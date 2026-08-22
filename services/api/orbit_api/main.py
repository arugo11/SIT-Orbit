import os
import secrets
from contextlib import asynccontextmanager
from typing import Literal, cast

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from orbit_api.agent import (
    AgentRunService,
    AgentService,
    ChatRunService,
    get_agent_backend,
    get_chat_backend,
)
from orbit_api.agent.chat import (
    ChatRunConsumedError,
    ChatRunExpiredError,
    ChatRunUnknownError,
)
from orbit_api.agent.runs import ConsumedRunError, ExpiredRunError, UnknownRunError
from orbit_api.models import (
    ActionProposal,
    AgentCapabilities,
    AgentRunRequest,
    AgentRunResponse,
    AgentToolResultRequest,
    ChatRunRequest,
    ChatRunResponse,
    ChatToolResultRequest,
    OrbitEvent,
    ProposeActionRequest,
    VerifyActionRequest,
)
from orbit_api.observability import init_observability


@asynccontextmanager
async def lifespan(_: FastAPI):
    agent_run_service.store.clear()
    chat_run_service.store.clear()
    init_observability()
    try:
        yield
    finally:
        agent_run_service.store.clear()
        chat_run_service.store.clear()


app = FastAPI(
    title="SIT ORBIT API",
    version="0.1.0",
    description="Personal Campus Agent for Shibaura Institute of Technology",
    lifespan=lifespan,
)


@app.exception_handler(RequestValidationError)
async def redact_request_validation_error(
    _request: Request,
    _error: RequestValidationError,
) -> JSONResponse:
    """Reject malformed API input without reflecting its values.

    Pydantic validation errors normally include the rejected input in the
    response body. Client-tool payloads can contain private browser data, so
    returning that diagnostic would turn a successful schema rejection into a
    disclosure channel. Detailed validation remains available in local tests;
    the HTTP boundary exposes only a stable, value-free error.
    """

    return JSONResponse(
        status_code=422,
        content={"detail": "Request validation failed."},
    )


@app.middleware("http")
async def require_api_token(request: Request, call_next):
    """Protect remote Agent routes when ORBIT_API_TOKEN is configured."""
    expected = os.getenv("ORBIT_API_TOKEN", "").strip()
    if expected and request.url.path.startswith("/v1/"):
        authorization = request.headers.get("authorization", "")
        scheme, separator, provided = authorization.partition(" ")
        if (
            separator != " "
            or scheme.lower() != "bearer"
            or not provided
            or not secrets.compare_digest(provided, expected)
        ):
            return JSONResponse(
                status_code=401,
                content={"detail": "Valid Agent API credentials are required."},
                headers={"WWW-Authenticate": "Bearer"},
            )
    return await call_next(request)


def configure_cors(application: FastAPI) -> None:
    """Allow only explicitly configured browser-extension origins."""
    origins = [
        origin.strip().rstrip("/")
        for origin in os.getenv("ORBIT_CORS_ORIGINS", "").split(",")
        if origin.strip()
    ]
    if not origins:
        return
    if "*" in origins:
        raise RuntimeError("ORBIT_CORS_ORIGINS must list explicit origins.")
    application.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )


configure_cors(app)

agent_run_service = AgentRunService()
chat_run_service = ChatRunService(backend_factory=get_chat_backend)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/v1/capabilities", response_model=AgentCapabilities)
async def capabilities() -> AgentCapabilities:
    backend = os.getenv("ORBIT_AGENT_BACKEND", "fixture")
    if backend not in {"fixture", "openai", "azure_openai"}:
        raise HTTPException(status_code=503, detail="Agent backend is not supported.")
    supported_backend = cast(Literal["fixture", "openai", "azure_openai"], backend)
    return AgentCapabilities(
        agent_backend=supported_backend,
        my_library_personal_context=supported_backend == "azure_openai",
    )


@app.post("/v1/agent/runs", response_model=AgentRunResponse)
async def start_agent_run(request: AgentRunRequest) -> AgentRunResponse:
    try:
        return await agent_run_service.start(request)
    except (RuntimeError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/v1/agent/runs/{run_id}/tool-results", response_model=AgentRunResponse)
async def submit_agent_tool_result(
    run_id: str,
    request: AgentToolResultRequest,
) -> AgentRunResponse:
    try:
        return await agent_run_service.submit_tool_result(run_id, request)
    except (UnknownRunError, ExpiredRunError, ConsumedRunError) as error:
        raise HTTPException(status_code=410, detail="Agent run is no longer resumable.") from error
    except (RuntimeError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/v1/chat/runs", response_model=ChatRunResponse)
async def start_chat_run(request: ChatRunRequest) -> ChatRunResponse:
    try:
        return await chat_run_service.start(request)
    except (RuntimeError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/v1/chat/runs/{run_id}/tool-results", response_model=ChatRunResponse)
async def submit_chat_tool_result(
    run_id: str,
    request: ChatToolResultRequest,
) -> ChatRunResponse:
    try:
        return await chat_run_service.submit_tool_result(run_id, request)
    except (ChatRunUnknownError, ChatRunExpiredError, ChatRunConsumedError) as error:
        raise HTTPException(status_code=410, detail="Chat run is no longer resumable.") from error
    except (RuntimeError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/v1/actions/propose", response_model=ActionProposal)
async def propose_action(request: ProposeActionRequest) -> ActionProposal:
    try:
        service = AgentService(get_agent_backend())
        return await service.handle_event(request.event, request.context)
    except (RuntimeError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/v1/actions/{action_id}/verify", response_model=OrbitEvent)
async def verify_action(action_id: str, request: VerifyActionRequest) -> OrbitEvent:
    try:
        service = AgentService(get_agent_backend())
        return await service.verify_result(action_id, request)
    except (RuntimeError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
