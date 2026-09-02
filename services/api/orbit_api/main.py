import json
import logging
import os
import secrets
from contextlib import asynccontextmanager
from typing import Literal, cast

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from orbit_api.agent import (
    AgentRunService,
    AgentService,
    ChatRunService,
    get_agent_backend,
    get_chat_backend,
)
from orbit_api.agent.azure_openai_backend import validate_azure_runtime_configuration
from orbit_api.agent.chat import (
    ChatEvidenceConflictError,
    ChatRunConsumedError,
    ChatRunExpiredError,
    ChatRunUnknownError,
)
from orbit_api.agent.runs import ConsumedRunError, ExpiredRunError, UnknownRunError
from orbit_api.agent.runtime_profile import validate_runtime_backend
from orbit_api.agent.tool_catalog import capability_tool_names
from orbit_api.auth import (
    AgentAuthenticationError,
    AgentAuthenticationUnavailable,
    SessionTokenStore,
    exchange_google_authorization_code,
)
from orbit_api.library import OpacGatewayError, get_shared_opac_gateway
from orbit_api.models import (
    ActionProposal,
    AgentCapabilities,
    AgentRunRequest,
    AgentRunResponse,
    AgentSessionRequest,
    AgentSessionResponse,
    AgentToolResultRequest,
    ChatCapabilities,
    ChatRunRequest,
    ChatRunResponse,
    ChatRunStatusResponse,
    ChatToolResultRequest,
    LibraryCatalogSearchRequest,
    LibraryCatalogSearchResult,
    LibraryItemReadRequest,
    LibraryItemReadResult,
    OrbitEvent,
    ProposeActionRequest,
    VerifyActionRequest,
)
from orbit_api.observability import init_observability

logger = logging.getLogger("orbit_api.validation")


@asynccontextmanager
async def lifespan(_: FastAPI):
    backend_name = os.getenv("ORBIT_AGENT_BACKEND", "fixture")
    # Validate the backend/profile contract before clearing stores or serving
    # requests.  This keeps removed backends (including ``openai``) from
    # starting successfully and avoids a late, request-time failure.
    validate_runtime_backend(backend_name)
    if backend_name == "azure_openai":
        # This is a local, no-network preflight.  It fails startup before an
        # Azure Agent is built when the deployment/profile pair cannot use
        # native Responses Tool Search.
        validate_azure_runtime_configuration()
    agent_run_service.store.clear()
    chat_run_service.store.clear()
    chat_run_service.clear_background()
    agent_sessions.clear()
    init_observability()
    try:
        yield
    finally:
        agent_run_service.store.clear()
        chat_run_service.store.clear()
        chat_run_service.clear_background()
        agent_sessions.clear()


app = FastAPI(
    title="SIT ORBIT API",
    version="0.1.0",
    description="Personal Campus Agent for Shibaura Institute of Technology",
    lifespan=lifespan,
)

agent_sessions = SessionTokenStore(
    int(os.getenv("ORBIT_AGENT_SESSION_TTL_SECONDS", "900")),
)


_VALIDATION_FIELDS = {
    "conversation_id",
    "message",
    "execution_mode",
    "history",
    "client_tools",
    "context_manifest",
    "tool_call_id",
    "name",
    "version",
    "result",
}

_VALIDATION_PATH_FIELDS = _VALIDATION_FIELDS | {
    "schema_version",
    "status",
    "report_label",
    "grades",
    "credit_summaries",
    "cumulative_gpa",
    "observed_at",
    "reason_code",
    "subject",
    "course_code",
    "credits",
    "grade",
    "outcome",
    "year",
    "term",
    "term_slot",
    "repeated",
    "category",
    "credit_type",
    "current_course_count",
    "current_credits",
    "cumulative_course_count",
    "cumulative_credits",
}


def _safe_validation_detail(error: RequestValidationError) -> dict[str, str]:
    """Return only a stable field/type classification, never rejected values."""

    field = "request"
    error_type = "validation_error"
    for item in error.errors():
        location = item.get("loc", ())
        if isinstance(location, (tuple, list)):
            candidate = next(
                (part for part in location if isinstance(part, str) and part in _VALIDATION_FIELDS),
                None,
            )
            if candidate is not None:
                field = candidate
        candidate_type = item.get("type")
        if isinstance(candidate_type, str) and candidate_type:
            error_type = candidate_type[:80]
        if field != "request":
            break
    reason_code = {
        "context_manifest": "chat_context_invalid",
        "history": "chat_history_invalid",
        "client_tools": "chat_tools_invalid",
        "result": "tool_result_invalid",
    }.get(field, "request_invalid")
    return {
        "reason_code": reason_code,
        "field": field,
        "error_type": error_type,
    }


def _safe_validation_diagnostics(
    error: RequestValidationError,
) -> list[dict[str, object]]:
    """Return value-free validation locations for server-side diagnosis.

    Pydantic locations can contain an unknown extra-field name supplied by a
    client.  Only known contract fields and bounded list indexes are retained,
    so diagnostics cannot become a side channel for student-record values.
    """

    diagnostics: list[dict[str, object]] = []
    for item in error.errors()[:12]:
        safe_location: list[str | int] = []
        location = item.get("loc", ())
        if isinstance(location, (tuple, list)):
            for part in location:
                if isinstance(part, str) and part in _VALIDATION_PATH_FIELDS:
                    safe_location.append(part)
                elif isinstance(part, int) and 0 <= part <= 200:
                    safe_location.append(part)
        error_type = item.get("type")
        diagnostics.append(
            {
                "location": safe_location,
                "error_type": (
                    error_type[:80]
                    if isinstance(error_type, str) and error_type
                    else "validation_error"
                ),
            }
        )
    return diagnostics


def _safe_chat_error_reason(error: Exception) -> str:
    """Map internal chat failures to a value-free public reason code."""

    if isinstance(error, ChatEvidenceConflictError):
        return "chat_context_invalid"
    message = str(error).lower()
    if any(marker in message for marker in ("evidence", "manifest", "history")):
        return "chat_context_invalid"
    if any(marker in message for marker in ("draft", "agent returned", "tool")):
        return "agent_output_invalid"
    if "backend changed" in message or "run" in message:
        return "chat_run_invalid"
    return "chat_contract_invalid"


@app.exception_handler(RequestValidationError)
async def redact_request_validation_error(
    request: Request,
    _error: RequestValidationError,
) -> JSONResponse:
    """Reject malformed API input without reflecting its values.

    Pydantic validation errors normally include the rejected input in the
    response body. Client-tool payloads can contain private browser data, so
    returning that diagnostic would turn a successful schema rejection into a
    disclosure channel. Detailed validation remains available in local tests;
    the HTTP boundary exposes only a stable, value-free error.
    """

    logger.warning(
        "request_validation_failed path=%s diagnostics=%s",
        request.url.path,
        json.dumps(
            _safe_validation_diagnostics(_error),
            ensure_ascii=True,
            separators=(",", ":"),
        ),
    )
    return JSONResponse(
        status_code=422,
        content={"detail": _safe_validation_detail(_error)},
    )


@app.middleware("http")
async def require_api_token(request: Request, call_next):
    """Protect remote Agent routes with static or managed session credentials."""
    if request.url.path == "/v1/auth/session":
        return await call_next(request)
    expected = os.getenv("ORBIT_API_TOKEN", "").strip()
    if expected and request.url.path.startswith("/v1/"):
        authorization = request.headers.get("authorization", "")
        scheme, separator, provided = authorization.partition(" ")
        if (
            separator != " "
            or scheme.lower() != "bearer"
            or not provided
            or not (secrets.compare_digest(provided, expected) or agent_sessions.verify(provided))
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
        allow_headers=[
            "Authorization",
            "Content-Type",
            "X-Orbit-Tool-Call-Id",
            "X-Orbit-Evidence-Id",
        ],
        expose_headers=["X-Orbit-Tool-Call-Id", "X-Orbit-Evidence-Id"],
    )


configure_cors(app)

agent_run_service = AgentRunService()
chat_run_service = ChatRunService(backend_factory=get_chat_backend)
opac_gateway = get_shared_opac_gateway()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/auth/session", response_model=AgentSessionResponse)
async def create_agent_session(request: AgentSessionRequest) -> AgentSessionResponse:
    try:
        await exchange_google_authorization_code(
            request.authorization_code,
            request.code_verifier,
        )
    except AgentAuthenticationError as error:
        raise HTTPException(status_code=401, detail="Agent authentication failed.") from error
    except AgentAuthenticationUnavailable as error:
        raise HTTPException(
            status_code=503,
            detail="Agent authentication is unavailable.",
        ) from error
    access_token, expires_at = agent_sessions.issue()
    return AgentSessionResponse(access_token=access_token, expires_at=expires_at)


@app.get("/v1/capabilities", response_model=AgentCapabilities)
async def capabilities() -> AgentCapabilities:
    backend = os.getenv("ORBIT_AGENT_BACKEND", "fixture")
    if backend not in {"fixture", "azure_openai"}:
        raise HTTPException(status_code=503, detail="Agent backend is not supported.")
    try:
        validate_runtime_backend(backend)
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    if backend == "azure_openai":
        try:
            validate_azure_runtime_configuration()
        except (RuntimeError, ValueError) as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
    supported_backend = cast(Literal["fixture", "azure_openai"], backend)
    return AgentCapabilities(
        agent_backend=supported_backend,
        my_library_personal_context=supported_backend == "azure_openai",
    )


@app.get("/v1/chat/capabilities", response_model=ChatCapabilities)
async def chat_capabilities() -> ChatCapabilities:
    """Return the authenticated Chat contract used for capability intersection.

    The legacy capabilities endpoint above is intentionally untouched.  This
    endpoint is a stricter, versioned advertisement for the extension and is
    fail-closed for live SCombZ student reads.
    """

    backend = os.getenv("ORBIT_AGENT_BACKEND", "fixture")
    if backend not in {"fixture", "azure_openai"}:
        raise HTTPException(status_code=503, detail="Agent backend is not supported.")
    try:
        validate_runtime_backend(backend)
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    if backend == "azure_openai":
        try:
            validate_azure_runtime_configuration()
        except (RuntimeError, ValueError) as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
    observability = os.getenv("ORBIT_OBSERVABILITY", "off")
    if observability not in {"off", "wandb"}:
        raise HTTPException(status_code=503, detail="Observability mode is not supported.")
    scombz_mode = os.getenv("ORBIT_SCOMBZ_STUDENT_READ", "off")
    if scombz_mode not in {"off", "fixture", "live"}:
        raise HTTPException(status_code=503, detail="SCombZ student read mode is not supported.")
    sitrus_mode = os.getenv("ORBIT_SITRUS_PERSONAL_CONTEXT", "off")
    if sitrus_mode not in {"off", "fixture", "live"}:
        raise HTTPException(
            status_code=503,
            detail="SITRUS personal context mode is not supported.",
        )

    supported = capability_tool_names(
        backend=backend,
        observability=observability,
        scombz_student_read_mode=scombz_mode,
        sitrus_personal_context_mode=sitrus_mode,
    )
    return ChatCapabilities(
        agent_backend=cast(Literal["fixture", "azure_openai"], backend),
        observability=cast(Literal["off", "wandb"], observability),
        scombz_student_read_mode=cast(Literal["off", "fixture", "live"], scombz_mode),
        sitrus_personal_context_mode=cast(Literal["off", "fixture", "live"], sitrus_mode),
        supported_client_tools=list(supported),
        max_client_tools=32,
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


@app.post("/v1/chat/runs", response_model=ChatRunStatusResponse)
async def start_chat_run(request: ChatRunRequest) -> ChatRunStatusResponse:
    try:
        return await chat_run_service.start(request)
    except (RuntimeError, ValueError) as error:
        raise HTTPException(
            status_code=422,
            detail={"reason_code": _safe_chat_error_reason(error)},
        ) from error


@app.get("/v1/chat/runs/{run_id}", response_model=ChatRunStatusResponse)
async def get_chat_run(run_id: str) -> ChatRunStatusResponse:
    try:
        return chat_run_service.background_status(run_id)
    except ChatRunUnknownError as error:
        raise HTTPException(status_code=404, detail="Chat background run was not found.") from error
    except ChatRunExpiredError as error:
        raise HTTPException(status_code=410, detail="Chat background run expired.") from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail="Chat background run failed.") from error


@app.get(
    "/v1/chat/runs/{run_id}/events",
    response_class=StreamingResponse,
    response_model=None,
    responses={
        200: {
            "description": "Server-sent progress events.",
            "content": {"text/event-stream": {}},
        }
    },
)
async def get_chat_run_events(run_id: str) -> StreamingResponse:
    try:
        events = chat_run_service.background_events(run_id)
        # Resolve existence before returning a streaming response so unknown
        # IDs do not become an opaque connection hang.
        chat_run_service.background_status(run_id)
    except ChatRunUnknownError as error:
        raise HTTPException(status_code=404, detail="Chat background run was not found.") from error
    except ChatRunExpiredError as error:
        raise HTTPException(status_code=410, detail="Chat background run expired.") from error

    async def stream():
        async for event in events:
            payload = json.dumps(event.model_dump(mode="json"), ensure_ascii=False)
            yield f"event: progress\ndata: {payload}\n\n"
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/v1/library/catalog/search", response_model=LibraryCatalogSearchResult)
async def search_library_catalog(
    request: LibraryCatalogSearchRequest,
) -> LibraryCatalogSearchResult:
    try:
        return await opac_gateway.search(**request.model_dump())
    except OpacGatewayError as error:
        return LibraryCatalogSearchResult(
            status="unavailable",
            query=request.query,
            reason_code=error.reason_code,
        )
    except (RuntimeError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/v1/library/items/read", response_model=LibraryItemReadResult)
async def read_library_item(request: LibraryItemReadRequest) -> LibraryItemReadResult:
    try:
        return await opac_gateway.read(
            resource_ref=request.resource_ref,
            presentation=request.presentation,
            records=request.records,
        )
    except OpacGatewayError as error:
        return LibraryItemReadResult(
            status="unavailable",
            resource_ref=request.resource_ref,
            reason_code=error.reason_code,
        )
    except (RuntimeError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/v1/chat/runs/{run_id}/tool-results", response_model=ChatRunResponse)
async def submit_chat_tool_result(
    run_id: str,
    request: ChatToolResultRequest,
    response: Response,
) -> ChatRunResponse:
    try:
        result = await chat_run_service.submit_tool_result(run_id, request)
        receipt = chat_run_service.take_tool_receipt(run_id)
        if receipt is not None:
            tool_call_id, evidence_id = receipt
            response.headers["X-Orbit-Tool-Call-Id"] = tool_call_id
            response.headers["X-Orbit-Evidence-Id"] = evidence_id
        return result
    except (ChatRunUnknownError, ChatRunExpiredError, ChatRunConsumedError) as error:
        raise HTTPException(status_code=410, detail="Chat run is no longer resumable.") from error
    except (RuntimeError, ValueError) as error:
        raise HTTPException(
            status_code=422,
            detail={"reason_code": _safe_chat_error_reason(error)},
        ) from error


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
