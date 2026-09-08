from unittest.mock import Mock

import pytest
from orbit_api.agent.actions import ActionStore
from orbit_api.agent.fixture import FixtureAgent
from orbit_api.agent.pydantic_ai_backend import (
    ActionDraft,
    AgentExecution,
    DeferredActionRun,
    PydanticAIAgentBackend,
)
from orbit_api.agent.runs import (
    AgentRunService,
    ConsumedRunError,
    ExpiredRunError,
    RunStore,
    UnknownRunError,
)
from orbit_api.models import (
    ActionProposal,
    AgentRunRequest,
    AgentToolResultRequest,
    CalendarAvailabilityResult,
    ClientTool,
    EvidenceLink,
    OrbitEvent,
)


def make_event() -> OrbitEvent:
    return OrbitEvent(
        event_type="campus_entered",
        scenario_id="b1-omiya-calculus",
        campus="omiya",
        data_classification="synthetic",
    )


def make_evidence(evidence_id: str = "ev-assignment") -> EvidenceLink:
    return EvidenceLink(
        evidence_id=evidence_id,
        title="合成データの課題根拠",
        source_type="assignment",
        locator="demo://assignment/calculus-1",
        data_classification="synthetic",
    )


def make_calendar_result(
    status: str = "known",
) -> CalendarAvailabilityResult:
    if status == "known":
        return CalendarAvailabilityResult(
            status="known",
            time_zone="Asia/Tokyo",
            window_start="2026-08-17T00:00:00+09:00",
            window_end="2026-08-24T00:00:00+09:00",
            available_minutes=10080,
            busy_minutes=0,
            free_intervals=[],
            reason_code=None,
        )
    return CalendarAvailabilityResult(
        status=status,  # type: ignore[arg-type]
        time_zone="Asia/Tokyo",
        window_start="2026-08-17T00:00:00+09:00",
        window_end="2026-08-24T00:00:00+09:00",
        reason_code=(
            "calendar_auth_required"
            if status == "reauth_required"
            else "provider_unavailable"
        ),
    )


def make_pending_run(
    store: RunStore,
    *,
    backend_name: str = "azure_openai",
    tool_call_id: str = "calendar-call-1",
) -> str:
    return store.put(
        backend_name=backend_name,
        event=make_event(),
        context=[make_evidence()],
        deferred=DeferredActionRun(
            messages=[],
            tool_call_id=tool_call_id,
            conversation_id="conversation-1",
        ),
    )


def make_tool_result_request(
    *,
    tool_call_id: str = "calendar-call-1",
    status: str = "known",
) -> AgentToolResultRequest:
    return AgentToolResultRequest(
        tool_call_id=tool_call_id,
        result=make_calendar_result(status),
    )


def test_run_store_rejects_unknown_expired_consumed_and_reused_runs() -> None:
    now = [0.0]
    store = RunStore(ttl_seconds=10, clock=lambda: now[0])

    with pytest.raises(UnknownRunError):
        store.take("run-does-not-exist")

    expired_run_id = make_pending_run(store)
    now[0] = 10.0
    with pytest.raises(ExpiredRunError):
        store.take(expired_run_id)

    consumed_run_id = make_pending_run(store)
    store.take(consumed_run_id)
    with pytest.raises(ConsumedRunError):
        store.take(consumed_run_id)

    reused_run_id = make_pending_run(store)
    store.close(reused_run_id, "completed")
    with pytest.raises(ConsumedRunError):
        store.take(reused_run_id)


@pytest.mark.asyncio
async def test_wrong_tool_call_id_is_rejected_without_consuming_pending_run() -> None:
    store = RunStore()
    run_id = make_pending_run(store)
    backend_factory = Mock()
    service = AgentRunService(store=store, backend_factory=backend_factory)

    with pytest.raises(ValueError, match="tool call ID"):
        await service.submit_tool_result(
            run_id,
            make_tool_result_request(tool_call_id="wrong-call-id"),
        )

    assert len(store) == 1
    backend_factory.assert_not_called()
    store.take(run_id)


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["reauth_required", "unavailable"])
async def test_calendar_failure_is_not_completed_and_does_not_call_model(
    status: str,
) -> None:
    store = RunStore()
    run_id = make_pending_run(store)
    backend_factory = Mock()
    service = AgentRunService(store=store, backend_factory=backend_factory)

    with pytest.raises(ValueError, match="authorization or availability"):
        await service.submit_tool_result(
            run_id,
            make_tool_result_request(status=status),
        )

    backend_factory.assert_not_called()
    assert len(store) == 0
    with pytest.raises(ConsumedRunError):
        store.take(run_id)


@pytest.mark.asyncio
async def test_unknown_run_is_rejected_before_model_factory() -> None:
    backend_factory = Mock()
    service = AgentRunService(backend_factory=backend_factory)

    with pytest.raises(UnknownRunError):
        await service.submit_tool_result(
            "run-unknown",
            make_tool_result_request(),
        )

    backend_factory.assert_not_called()


@pytest.mark.asyncio
async def test_expired_run_is_rejected_before_model_factory() -> None:
    now = [0.0]
    store = RunStore(ttl_seconds=1, clock=lambda: now[0])
    run_id = make_pending_run(store)
    backend_factory = Mock()
    service = AgentRunService(store=store, backend_factory=backend_factory)
    now[0] = 1.1

    with pytest.raises(ExpiredRunError):
        await service.submit_tool_result(run_id, make_tool_result_request())

    backend_factory.assert_not_called()


@pytest.mark.asyncio
async def test_completed_resumable_run_registers_proposal_for_action_verification(
    monkeypatch,
) -> None:
    class DeferredBackend(PydanticAIAgentBackend):
        def __init__(self) -> None:
            pass

        async def start_run(
            self,
            event,
            context,
            *,
            calendar_connected=None,
            advertised_tools=None,
        ):
            del event, context, calendar_connected, advertised_tools
            return None, DeferredActionRun(
                messages=[],
                tool_call_id="calendar-call-1",
                conversation_id="conversation-1",
            )

        async def resume_execution(
            self,
            event,
            context,
            deferred,
            tool_result,
            *,
            advertised_tools=None,
            used_tool_names=frozenset(),
            seen_tool_call_ids=frozenset(),
        ):
            del event, deferred, tool_result, advertised_tools, used_tool_names, seen_tool_call_ids
            return AgentExecution(
                draft=ActionDraft(
                    title="確認する",
                    reason="合成データの確認",
                    duration_minutes=10,
                    evidence_ids=[item.evidence_id for item in context],
                )
            )

        def _canonicalize(self, draft, context):
            return ActionProposal(
                action_id="act-resumed",
                title=draft.title,
                reason=draft.reason,
                duration_minutes=draft.duration_minutes,
                evidence=list(context),
                external_action=draft.external_action,
                requires_confirmation=draft.requires_confirmation,
                prompt_version="test-resumed-v1",
                operation=draft.operation,
            )

    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "azure_openai")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    run_store = RunStore()
    action_store = ActionStore()
    backend = DeferredBackend()
    service = AgentRunService(
        store=run_store,
        action_store=action_store,
        backend_factory=lambda: backend,
    )
    request = AgentRunRequest(
        event=make_event(),
        context=[make_evidence()],
        client_tools=[ClientTool(name="google_calendar_availability", version=1)],
    )

    started = await service.start(request)
    assert started.status == "tool_required"
    run_id = started.run_id
    assert len(action_store) == 0

    completed = await service.submit_tool_result(run_id, make_tool_result_request())

    assert completed.status == "completed"
    assert completed.proposal.action_id == "act-resumed"
    assert action_store.get("act-resumed").source_event.event_id == request.event.event_id


@pytest.mark.asyncio
async def test_completed_compatibility_run_registers_proposal_for_action_verification() -> None:
    action_store = ActionStore()
    service = AgentRunService(
        action_store=action_store,
        backend_factory=FixtureAgent,
    )
    request = AgentRunRequest(event=make_event(), context=[make_evidence()])

    completed = await service.start(request)

    assert completed.status == "completed"
    assert (
        action_store.get(completed.proposal.action_id).source_event.event_id
        == request.event.event_id
    )
