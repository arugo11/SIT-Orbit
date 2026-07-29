from datetime import UTC, datetime

from orbit_api.models import (
    ActionProposal,
    EvidenceLink,
    OrbitEvent,
    VerifyActionRequest,
)
from orbit_api.observability import trace_op

from .base import AgentBackend


class AgentService:
    def __init__(self, backend: AgentBackend) -> None:
        self.backend = backend

    @trace_op("agent.handle_event", kind="agent")
    async def handle_event(
        self,
        event: OrbitEvent,
        context: list[EvidenceLink],
    ) -> ActionProposal:
        selected = await self._select_context(event, context)
        return await self._propose_action(event, selected)

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
        return await self.backend.propose_action(event, context)

    @trace_op("agent.verify_result", kind="tool")
    async def verify_result(
        self,
        action_id: str,
        verification: VerifyActionRequest,
    ) -> OrbitEvent:
        if not verification.approved:
            raise ValueError("An action cannot be completed without explicit approval.")
        if not verification.completed:
            raise ValueError("Only completed actions can produce a completion event.")

        return OrbitEvent(
            event_type="action_completed",
            scenario_id=verification.scenario_id,
            occurred_at=datetime.now(UTC),
            campus=verification.campus,
            data_classification="synthetic",
            payload={
                "action_id": action_id,
                "approved": verification.approved,
                "completed": verification.completed,
                "notes": verification.notes,
            },
        )
