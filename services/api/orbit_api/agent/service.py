from orbit_api.models import (
    ActionProposal,
    EvidenceLink,
    OrbitEvent,
    VerifyActionRequest,
)
from orbit_api.observability import trace_op

from .actions import ActionStore
from .base import AgentBackend
from .pydantic_ai_backend import validate_agent_data


class AgentService:
    def __init__(
        self,
        backend: AgentBackend | None = None,
        *,
        action_store: ActionStore | None = None,
    ) -> None:
        self.backend = backend
        self.action_store = action_store if action_store is not None else ActionStore()

    @trace_op("agent.handle_event", kind="agent")
    async def handle_event(
        self,
        event: OrbitEvent,
        context: list[EvidenceLink],
    ) -> ActionProposal:
        validate_agent_data(event, context)
        selected = await self._select_context(event, context)
        proposal = await self._propose_action(event, selected)
        return self.action_store.register(proposal, event)

    @trace_op("agent.select_context", kind="search")
    async def _select_context(
        self,
        event: OrbitEvent,
        context: list[EvidenceLink],
    ) -> list[EvidenceLink]:
        del event
        return context

    @trace_op("agent.propose_action", kind="agent")
    async def _propose_action(
        self,
        event: OrbitEvent,
        context: list[EvidenceLink],
    ) -> ActionProposal:
        if self.backend is None:
            raise RuntimeError("An agent backend is required to propose an action.")
        return await self.backend.propose_action(event, context)

    @trace_op("agent.verify_result", kind="tool")
    async def verify_result(
        self,
        action_id: str,
        verification: VerifyActionRequest,
    ) -> OrbitEvent:
        return self.action_store.complete(action_id, verification)
