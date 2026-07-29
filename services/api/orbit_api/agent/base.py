from typing import Protocol

from orbit_api.models import ActionProposal, EvidenceLink, OrbitEvent


class AgentBackend(Protocol):
    async def propose_action(
        self,
        event: OrbitEvent,
        context: list[EvidenceLink],
    ) -> ActionProposal: ...
