import json
from pathlib import Path

import pytest
from orbit_api.agent.fixture import FixtureAgent
from orbit_api.agent.service import AgentService
from orbit_api.models import EvidenceLink, OrbitEvent, VerifyActionRequest

ROOT = Path(__file__).resolve().parents[3]


def load_fixture(name: str):
    return json.loads((ROOT / "fixtures" / "b1_omiya" / name).read_text(encoding="utf-8"))


@pytest.mark.asyncio
async def test_b1_omiya_closed_loop() -> None:
    event = OrbitEvent.model_validate(load_fixture("event.json"))
    context = [EvidenceLink.model_validate(item) for item in load_fixture("context.json")]
    service = AgentService(FixtureAgent())

    proposal = await service.handle_event(event, context)
    assert proposal.evidence
    assert proposal.requires_confirmation is True

    completion = await service.verify_result(
        proposal.action_id,
        VerifyActionRequest(
            scenario_id=event.scenario_id,
            campus=event.campus,
            approved=True,
            completed=True,
            notes="Synthetic fixture completed.",
        ),
    )
    assert completion.event_type == "action_completed"
    assert completion.payload["action_id"] == proposal.action_id
