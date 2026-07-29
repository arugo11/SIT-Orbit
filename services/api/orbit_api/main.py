from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException

from orbit_api.agent import AgentService, get_agent_backend
from orbit_api.models import (
    ActionProposal,
    OrbitEvent,
    ProposeActionRequest,
    VerifyActionRequest,
)
from orbit_api.observability import init_observability


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_observability()
    yield


app = FastAPI(
    title="SIT ORBIT API",
    version="0.1.0",
    description="Personal Campus Agent for Shibaura Institute of Technology",
    lifespan=lifespan,
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


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
