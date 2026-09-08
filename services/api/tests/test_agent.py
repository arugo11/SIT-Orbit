import json
from pathlib import Path

import pytest
from orbit_api.agent.actions import (
    ActionConflictError,
    ActionStore,
    ActionUnavailableError,
    ExpiredActionError,
    UnknownActionError,
)
from orbit_api.agent.fixture import FixtureAgent
from orbit_api.agent.service import AgentService
from orbit_api.models import (
    ActionProposal,
    EvidenceLink,
    OrbitEvent,
    ReserveOperation,
    VerifyActionRequest,
)

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


@pytest.mark.asyncio
async def test_completion_is_bound_to_registered_action_and_exact_retry_is_idempotent() -> None:
    event = OrbitEvent.model_validate(load_fixture("event.json"))
    context = [EvidenceLink.model_validate(item) for item in load_fixture("context.json")]
    service = AgentService(FixtureAgent(), action_store=ActionStore())

    proposal = await service.handle_event(event, context)
    request = VerifyActionRequest(
        scenario_id=event.scenario_id,
        campus=event.campus,
        approved=True,
        completed=True,
        notes="確認済み",
    )
    completion = await service.verify_result(proposal.action_id, request)
    retry = await service.verify_result(proposal.action_id, request)

    assert retry == completion
    assert completion.data_classification == event.data_classification
    assert completion.payload["evidence_ids"] == [item.evidence_id for item in proposal.evidence]
    assert completion.payload["notes"] == "確認済み"

    with pytest.raises(ActionConflictError):
        await service.verify_result(
            proposal.action_id,
            request.model_copy(update={"scenario_id": "different-scenario"}),
        )
    with pytest.raises(ActionConflictError):
        await service.verify_result(
            proposal.action_id,
            request.model_copy(update={"notes": "別の承認内容"}),
        )

    with pytest.raises(UnknownActionError):
        await service.verify_result("act-unknown", request)


@pytest.mark.asyncio
async def test_library_write_cannot_be_completed_without_provider_readback() -> None:
    event = OrbitEvent(
        event_id="evt-library-write",
        event_type="campus_entered",
        scenario_id="library-scenario",
        campus="omiya",
        data_classification="synthetic",
    )
    evidence = EvidenceLink(
        evidence_id="library-source",
        title="公開図書館記録",
        source_type="library",
        locator="https://library.example/record/1",
        data_classification="public",
    )
    proposal = ActionProposal(
        action_id="act-library-write",
        title="予約する",
        reason="空きがあるため",
        duration_minutes=10,
        evidence=[evidence],
        external_action="library_write",
        requires_confirmation=True,
        prompt_version="test-v1",
        operation=ReserveOperation(
            action_type="reserve",
            resource_ref="orbit-library://record/abcdefghijklmnop",
        ),
    )
    store = ActionStore()
    store.register(proposal, event)

    with pytest.raises(ActionUnavailableError):
        store.complete(
            proposal.action_id,
            VerifyActionRequest(
                scenario_id=event.scenario_id,
                campus=event.campus,
                approved=True,
                completed=True,
            ),
        )
    assert store.get(proposal.action_id).completion is None


def test_action_store_is_bounded_and_exposes_expiry() -> None:
    now = [0.0]
    store = ActionStore(ttl_seconds=10, max_records=2, clock=lambda: now[0])
    event = OrbitEvent(
        event_type="campus_entered",
        scenario_id="scenario-bound",
        campus="omiya",
    )

    def proposal(action_id: str) -> ActionProposal:
        return ActionProposal(
            action_id=action_id,
            title="確認する",
            reason="合成データの課題に対応するため",
            duration_minutes=10,
            evidence=[
                EvidenceLink(
                    evidence_id=f"evidence-{action_id}",
                    title="Synthetic evidence",
                    source_type="assignment",
                    locator=f"demo://{action_id}",
                )
            ],
            prompt_version="test-v1",
        )

    store.register(proposal("act-1"), event)
    store.register(proposal("act-2"), event)
    store.register(proposal("act-3"), event)

    assert len(store) == 2
    with pytest.raises(UnknownActionError):
        store.get("act-1")

    now[0] = 10
    with pytest.raises(ExpiredActionError):
        store.get("act-2")
