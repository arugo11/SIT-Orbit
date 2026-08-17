from unittest.mock import Mock

import pytest
from orbit_api.agent.openai_backend import OpenAIAgent
from orbit_api.agent.pydantic_ai_backend import (
    ActionDraft,
    DeferredActionRun,
)
from orbit_api.agent.runs import (
    AgentRunService,
    ConsumedRunError,
    ExpiredRunError,
    RunStore,
    UnknownRunError,
)
from orbit_api.models import (
    AgentRunRequest,
    AgentRunToolRequired,
    AgentToolResultRequest,
    CalendarAvailabilityResult,
    ClientTool,
    EvidenceLink,
    OrbitEvent,
)
from pydantic_ai import Agent, CallDeferred, DeferredToolRequests
from pydantic_ai.models.test import TestModel


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
    backend_name: str = "openai",
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


def action_args() -> dict[str, object]:
    return {
        "title": "合成関数の微分を確認する",
        "reason": "合成fixtureの空き時間に収まるためです。",
        "duration_minutes": 12,
        "external_action": "checklist_update",
        "requires_confirmation": True,
        "evidence_ids": ["ev-assignment"],
    }


async def google_calendar_availability() -> None:
    raise CallDeferred()


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
async def test_client_tool_advertisement_controls_deferred_tool_registration(monkeypatch) -> None:
    backend = OpenAIAgent(api_key="synthetic-test-key", model="demo-model")
    seen_calendar_connected: list[bool] = []

    def build_agent(*, calendar_connected: bool):
        seen_calendar_connected.append(calendar_connected)
        model = TestModel(
            custom_output_args=action_args(),
            call_tools="all",
        )
        return Agent(
            model,
            output_type=[ActionDraft, DeferredToolRequests],
            instructions="test",
            tools=[google_calendar_availability] if calendar_connected else [],
        )

    monkeypatch.setattr(backend, "_agent", build_agent)
    service = AgentRunService(store=RunStore(), backend_factory=lambda: backend)
    base_request = AgentRunRequest(event=make_event(), context=[make_evidence()])

    completed = await service.start(base_request)
    assert completed.status == "completed"

    connected = await service.start(
        base_request.model_copy(
            update={
                "client_tools": [
                    ClientTool(name="google_calendar_availability", version=1)
                ]
            }
        )
    )
    assert isinstance(connected, AgentRunToolRequired)
    assert seen_calendar_connected == [False, True]
