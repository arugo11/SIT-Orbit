"""Adversarial tests for the linear two-tool PydanticAI resume boundary."""

from types import SimpleNamespace
from typing import cast

import pytest
from orbit_api.agent.openai_backend import OpenAIAgent
from orbit_api.agent.pydantic_ai_backend import (
    CALENDAR_AVAILABILITY_LOCATOR_PREFIX,
    CALENDAR_TOOL_NAME,
    SCOMBZ_PAGE_SUMMARY_LOCATOR_PREFIX,
    SCOMBZ_TOOL_NAME,
    ActionDraft,
    AgentExecution,
    DeferredActionRun,
    ToolName,
    google_calendar_availability,
    scombz_page_summary,
)
from orbit_api.agent.runs import (
    AgentRunService,
    ExpiredRunError,
    RunInFlightError,
    RunStore,
)
from orbit_api.models import (
    AgentRunRequest,
    AgentRunToolRequired,
    AgentToolResultRequest,
    CalendarAvailabilityInterval,
    CalendarAvailabilityResult,
    ClientTool,
    EvidenceLink,
    OrbitEvent,
    ScombzPageSummaryResult,
)
from pydantic_ai import Agent, DeferredToolRequests, ModelMessage
from pydantic_ai.messages import ModelResponse, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel


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


def make_scombz_evidence(evidence_id: str = "scombz-page-summary-v1-run-1") -> EvidenceLink:
    return EvidenceLink(
        evidence_id=evidence_id,
        title="ScombZページから導出したページ概要",
        source_type="scombz",
        locator=f"{SCOMBZ_PAGE_SUMMARY_LOCATOR_PREFIX}opaque-summary-1",
        data_classification="personal",
    )


def make_calendar_evidence(evidence_id: str = "calendar-availability-v1-run-1") -> EvidenceLink:
    return EvidenceLink(
        evidence_id=evidence_id,
        title="Google Calendarから導出した空き時間",
        source_type="calendar",
        locator=f"{CALENDAR_AVAILABILITY_LOCATOR_PREFIX}opaque-calendar-1",
        data_classification="personal",
    )


def make_scombz_result() -> ScombzPageSummaryResult:
    return ScombzPageSummaryResult(
        route="tasks",
        task_count=2,
        announcement_count=1,
        related_link_count=3,
        has_current_course=True,
    )


def make_calendar_result() -> CalendarAvailabilityResult:
    return CalendarAvailabilityResult(
        status="known",
        time_zone="Asia/Tokyo",
        window_start="2026-08-17T00:00:00+09:00",
        window_end="2026-08-24T00:00:00+09:00",
        available_minutes=10020,
        busy_minutes=60,
        free_intervals=[
            CalendarAvailabilityInterval(
                start="2026-08-17T00:00:00+09:00",
                end="2026-08-17T09:00:00+09:00",
            )
        ],
        reason_code=None,
    )


def action_args(evidence_ids: list[str]) -> dict[str, object]:
    return {
        "title": "合成関数の微分を確認する",
        "reason": "ScombZの課題と空き時間に収まるためです。",
        "duration_minutes": 12,
        "external_action": "checklist_update",
        "requires_confirmation": True,
        "evidence_ids": evidence_ids,
    }


def make_two_stage_agent(
    requests: list[list[ModelMessage]],
) -> Agent[object, object]:
    def model_function(messages: list[ModelMessage], _: AgentInfo) -> ModelResponse:
        requests.append(messages)
        tool_returns = [
            part
            for message in messages
            for part in message.parts
            if isinstance(part, ToolReturnPart)
        ]
        if not tool_returns:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        SCOMBZ_TOOL_NAME,
                        {},
                        tool_call_id="scombz-call-1",
                    )
                ]
            )
        if len(tool_returns) == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        CALENDAR_TOOL_NAME,
                        {},
                        tool_call_id="calendar-call-1",
                    )
                ]
            )
        evidence_ids = [
            part.content["evidence_id"]
            for part in tool_returns
            if isinstance(part.content, dict) and "evidence_id" in part.content
        ]
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "final_result",
                    action_args(["ev-assignment", *evidence_ids]),
                    tool_call_id="proposal-call-1",
                )
            ]
        )

    model = FunctionModel(model_function, model_name="deterministic-two-stage-test")
    return Agent(
        model,
        output_type=[ActionDraft, DeferredToolRequests],
        instructions="test",
        tools=[scombz_page_summary, google_calendar_availability],
    )


@pytest.mark.asyncio
async def test_function_model_two_stage_scombz_then_calendar_keeps_minimized_returns() -> None:
    requests: list[list[ModelMessage]] = []
    test_agent = make_two_stage_agent(requests)
    backend = OpenAIAgent(api_key="synthetic-test-key", model="demo-model")
    backend._agent = lambda *, advertised_tools: test_agent  # type: ignore[method-assign]

    advertised = {SCOMBZ_TOOL_NAME, CALENDAR_TOOL_NAME}
    event = make_event()
    context = [make_evidence()]
    proposal, deferred = await backend.start_run(
        event,
        context,
        advertised_tools=advertised,
    )

    assert proposal is None
    assert deferred is not None
    assert deferred.tool_name == SCOMBZ_TOOL_NAME
    assert deferred.tool_call_id == "scombz-call-1"

    scombz_evidence = make_scombz_evidence()
    scombz_execution = await backend.resume_execution(
        event,
        [*context, scombz_evidence],
        deferred,
        make_scombz_result(),
        advertised_tools=advertised,
    )

    assert scombz_execution.draft is None
    calendar_deferred = scombz_execution.deferred
    assert calendar_deferred is not None
    assert calendar_deferred.tool_name == CALENDAR_TOOL_NAME
    assert calendar_deferred.tool_call_id == "calendar-call-1"

    calendar_evidence = make_calendar_evidence()
    final_execution = await backend.resume_execution(
        event,
        [*context, scombz_evidence, calendar_evidence],
        calendar_deferred,
        make_calendar_result(),
        advertised_tools=advertised,
        used_tool_names={SCOMBZ_TOOL_NAME},
        seen_tool_call_ids={"scombz-call-1"},
    )

    assert isinstance(final_execution, AgentExecution)
    assert final_execution.deferred is None
    assert final_execution.draft is not None
    proposal = backend._canonicalize(
        final_execution.draft,
        [*context, scombz_evidence, calendar_evidence],
    )
    assert {item.evidence_id for item in proposal.evidence} == {
        "ev-assignment",
        scombz_evidence.evidence_id,
        calendar_evidence.evidence_id,
    }
    assert len(requests) == 3

    scombz_returns = [
        part
        for message in requests[1]
        for part in message.parts
        if isinstance(part, ToolReturnPart)
    ]
    calendar_returns = [
        part
        for message in requests[2]
        for part in message.parts
        if isinstance(part, ToolReturnPart) and part.tool_name == CALENDAR_TOOL_NAME
    ]
    assert len(scombz_returns) == 1
    assert scombz_returns[0].content == {
        "evidence_id": scombz_evidence.evidence_id,
        "page_summary": make_scombz_result().model_dump(mode="json"),
    }
    assert len(calendar_returns) == 1
    assert calendar_returns[0].content == {
        "evidence_id": calendar_evidence.evidence_id,
        "availability": make_calendar_result().model_dump(mode="json"),
    }
    serialized_returns = str(
        [
            part.content
            for messages in requests[1:]
            for message in messages
            for part in message.parts
            if isinstance(part, ToolReturnPart)
        ]
    )
    for raw_value in (
        "私的な課題タイトル",
        "https://scombz.shibaura-it.ac.jp/private-task/1",
        "私的な授業名",
        "oauth-secret",
        "private-event-title",
    ):
        assert raw_value not in serialized_returns


@pytest.mark.asyncio
async def test_resume_execution_rejects_duplicate_tool_call_and_unadvertised_tool() -> None:
    backend = OpenAIAgent(api_key="synthetic-test-key", model="demo-model")
    result = SimpleNamespace(
        conversation_id="conversation-1",
        output=DeferredToolRequests(
            calls=[
                ToolCallPart(
                    CALENDAR_TOOL_NAME,
                    {},
                    tool_call_id="calendar-call-1",
                )
            ]
        ),
        all_messages=lambda: [],
    )

    with pytest.raises(RuntimeError, match="not advertised"):
        backend._execution(result, advertised_tools={SCOMBZ_TOOL_NAME})
    with pytest.raises(RuntimeError, match="duplicate or empty"):
        backend._execution(
            result,
            advertised_tools={CALENDAR_TOOL_NAME},
            seen_tool_call_ids={"calendar-call-1"},
        )


def make_multi_tool_request() -> AgentRunRequest:
    return AgentRunRequest(
        event=make_event(),
        context=[make_evidence()],
        client_tools=[
            ClientTool(name=SCOMBZ_TOOL_NAME, version=1),
            ClientTool(name=CALENDAR_TOOL_NAME, version=1),
        ],
    )


def make_pending_multi_tool_run(store: RunStore) -> str:
    return store.put(
        backend_name="openai",
        event=make_event(),
        context=[make_evidence()],
        deferred=DeferredActionRun(
            messages=[],
            tool_call_id="scombz-call-1",
            conversation_id="conversation-1",
            tool_name=cast(ToolName, SCOMBZ_TOOL_NAME),
        ),
        advertised_tools=[
            ClientTool(name=SCOMBZ_TOOL_NAME, version=1),
            ClientTool(name=CALENDAR_TOOL_NAME, version=1),
        ],
    )


@pytest.mark.asyncio
async def test_agent_run_service_keeps_one_run_id_across_scombz_calendar_and_final_action(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "openai")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    requests: list[list[ModelMessage]] = []
    backend = OpenAIAgent(api_key="synthetic-test-key", model="demo-model")
    test_agent = make_two_stage_agent(requests)
    backend._agent = lambda *, advertised_tools: test_agent  # type: ignore[method-assign]
    service = AgentRunService(
        store=RunStore(),
        backend_factory=lambda: backend,
    )

    first = await service.start(make_multi_tool_request())
    assert isinstance(first, AgentRunToolRequired)
    assert first.calls[0].name == SCOMBZ_TOOL_NAME
    run_id = first.run_id

    second = await service.submit_tool_result(
        run_id,
        AgentToolResultRequest(
            tool_call_id=first.calls[0].tool_call_id,
            name=SCOMBZ_TOOL_NAME,
            version=1,
            result=make_scombz_result(),
        ),
    )
    assert isinstance(second, AgentRunToolRequired)
    assert second.run_id == run_id
    assert second.calls[0].name == CALENDAR_TOOL_NAME

    completed = await service.submit_tool_result(
        run_id,
        AgentToolResultRequest(
            tool_call_id=second.calls[0].tool_call_id,
            name=CALENDAR_TOOL_NAME,
            version=1,
            result=make_calendar_result(),
        ),
    )
    assert completed.status == "completed"
    assert {item.evidence_id for item in completed.proposal.evidence} >= {
        "ev-assignment",
        f"scombz-page-summary-v1-{run_id}",
        f"calendar-availability-v1-{run_id}",
    }
    assert len(requests) == 3


def test_run_store_identity_checks_leave_pending_and_claim_is_at_most_once() -> None:
    store = RunStore()
    run_id = make_pending_multi_tool_run(store)

    for identity in (
        {"tool_call_id": "wrong-call", "tool_name": SCOMBZ_TOOL_NAME, "tool_version": 1},
        {"tool_call_id": "scombz-call-1", "tool_name": CALENDAR_TOOL_NAME, "tool_version": 1},
        {"tool_call_id": "scombz-call-1", "tool_name": SCOMBZ_TOOL_NAME, "tool_version": 2},
    ):
        with pytest.raises(ValueError):
            store.claim(run_id, **identity)
        assert store.peek(run_id).state == "pending"

    claimed = store.claim(
        run_id,
        tool_call_id="scombz-call-1",
        tool_name=SCOMBZ_TOOL_NAME,
        tool_version=1,
    )
    assert claimed.state == "in_flight"
    with pytest.raises(RunInFlightError):
        store.claim(
            run_id,
            tool_call_id="scombz-call-1",
            tool_name=SCOMBZ_TOOL_NAME,
            tool_version=1,
        )

    with pytest.raises(ValueError, match="already used"):
        store.continue_run(
            run_id,
            deferred=DeferredActionRun(
                messages=[],
                tool_call_id="scombz-call-2",
                conversation_id="conversation-1",
                tool_name=cast(ToolName, SCOMBZ_TOOL_NAME),
            ),
            context=claimed.context,
            generation=claimed.generation,
        )

    with pytest.raises(ValueError, match="already used"):
        store.continue_run(
            run_id,
            deferred=DeferredActionRun(
                messages=[],
                tool_call_id="scombz-call-1",
                conversation_id="conversation-1",
                tool_name=cast(ToolName, CALENDAR_TOOL_NAME),
            ),
            context=claimed.context,
            generation=claimed.generation,
        )

    continued = store.continue_run(
        run_id,
        deferred=DeferredActionRun(
            messages=[],
            tool_call_id="calendar-call-1",
            conversation_id="conversation-1",
            tool_name=cast(ToolName, CALENDAR_TOOL_NAME),
        ),
        context=claimed.context,
        generation=claimed.generation,
    )
    assert continued.run_id == run_id
    assert continued.generation == 1
    assert continued.state == "pending"

    second_claim = store.claim(
        run_id,
        tool_call_id="calendar-call-1",
        tool_name=CALENDAR_TOOL_NAME,
        tool_version=1,
    )
    with pytest.raises(ValueError, match="already used"):
        store.continue_run(
            run_id,
            deferred=DeferredActionRun(
                messages=[],
                tool_call_id="calendar-call-2",
                conversation_id="conversation-1",
                tool_name=cast(ToolName, SCOMBZ_TOOL_NAME),
            ),
            context=continued.context,
            generation=second_claim.generation,
        )


def test_run_store_absolute_ttl_expires_even_after_claim_in_flight() -> None:
    now = [0.0]
    store = RunStore(ttl_seconds=10, clock=lambda: now[0])
    run_id = make_pending_multi_tool_run(store)
    claimed = store.claim(
        run_id,
        tool_call_id="scombz-call-1",
        tool_name=SCOMBZ_TOOL_NAME,
        tool_version=1,
    )
    now[0] = 10.0

    with pytest.raises(ExpiredRunError):
        store.complete(run_id, generation=claimed.generation)
    with pytest.raises(ExpiredRunError):
        store.peek(run_id)
    assert len(store) == 0


@pytest.mark.asyncio
async def test_result_returning_after_ttl_cannot_complete_or_publish(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "openai")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    now = [0.0]
    store = RunStore(ttl_seconds=10, clock=lambda: now[0])
    run_id = store.put(
        backend_name="openai",
        event=make_event(),
        context=[make_evidence()],
        deferred=DeferredActionRun(
            messages=[],
            tool_call_id="calendar-call-1",
            conversation_id="conversation-1",
        ),
    )
    backend = OpenAIAgent(api_key="synthetic-test-key", model="demo-model")

    async def late_resume(*args: object, **kwargs: object) -> AgentExecution:
        del args, kwargs
        now[0] = 10.0
        return AgentExecution(
            draft=ActionDraft(
                title="遅れて返った提案",
                reason="期限後の結果",
                duration_minutes=5,
                evidence_ids=["ev-assignment"],
            )
        )

    monkeypatch.setattr(backend, "resume_execution", late_resume)
    service = AgentRunService(store=store, backend_factory=lambda: backend)

    with pytest.raises(ExpiredRunError):
        await service.submit_tool_result(
            run_id,
            AgentToolResultRequest(
                tool_call_id="calendar-call-1",
                name=CALENDAR_TOOL_NAME,
                version=1,
                result=make_calendar_result(),
            ),
        )

    with pytest.raises(ExpiredRunError):
        store.peek(run_id)
    assert len(store) == 0
