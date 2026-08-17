from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException

from orbit_api.agent import AgentRunService, AgentService, get_agent_backend
from orbit_api.agent.runs import ConsumedRunError, ExpiredRunError, UnknownRunError
from orbit_api.models import (
    ActionProposal,
    AgentRunRequest,
    AgentRunResponse,
    AgentToolResultRequest,
    OrbitEvent,
    ProposeActionRequest,
    VerifyActionRequest,
)
from orbit_api.observability import init_observability


@asynccontextmanager
async def lifespan(_: FastAPI):
    agent_run_service.store.clear()
    init_observability()
    try:
        yield
    finally:
        agent_run_service.store.clear()


app = FastAPI(
    title="SIT ORBIT API",
    version="0.1.0",
    description="Personal Campus Agent for Shibaura Institute of Technology",
    lifespan=lifespan,
)

agent_run_service = AgentRunService()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


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
