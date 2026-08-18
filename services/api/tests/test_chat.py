import pytest
from fastapi.testclient import TestClient
from orbit_api.agent.chat import ChatRunStore
from orbit_api.agent.openai_backend import OpenAIAgent
from orbit_api.agent.pydantic_ai_backend import (
    CALENDAR_TOOL_NAME,
    SCOMBZ_TOOL_NAME,
    ChatDraft,
    DeferredChatRun,
    google_calendar_availability,
    scombz_page_summary,
)
from orbit_api.main import app
from orbit_api.models import (
    CalendarAvailabilityResult,
    ChatClientTool,
    ChatHistoryMessage,
    ChatRunRequest,
    EvidenceLink,
    ScombzPageSummaryResult,
)
from pydantic_ai import Agent, DeferredToolRequests, ModelResponse, ToolCallPart
from pydantic_ai.models.function import FunctionModel


def test_chat_request_limits_history() -> None:
    with pytest.raises(ValueError, match="64000"):
        ChatRunRequest(
            conversation_id="conversation-1",
            message="質問",
            history=[
                ChatHistoryMessage(role="user", content="x" * 8000)
            ]
            * 9,
        )


def test_fixture_chat_route_returns_completed_message(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "fixture")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    with TestClient(app) as client:
        response = client.post(
            "/v1/chat/runs",
            json={
                "conversation_id": "conversation-fixture",
                "message": "今日の学習を相談したい",
                "history": [],
                "client_tools": [],
            },
        )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "completed"
    assert payload["message"]["evidence"] == []
    assert "今日の学習を相談したい" in payload["message"]["content_markdown"]


def test_chat_store_allows_repeated_tool_name_but_rejects_duplicate_call_id() -> None:
    store = ChatRunStore()
    first = DeferredChatRun(
        messages=[],
        tool_call_id="scombz-call-1",
        conversation_id="conversation-1",
        tool_name=SCOMBZ_TOOL_NAME,
    )
    run_id = store.put(
        backend_name="openai",
        conversation_id="conversation-1",
        deferred=first,
        context=[],
        advertised_tools=[ChatClientTool(name=SCOMBZ_TOOL_NAME, version=1)],
    )
    claimed = store.claim(
        run_id,
        tool_call_id="scombz-call-1",
        tool_name=SCOMBZ_TOOL_NAME,
        tool_version=1,
    )
    second = DeferredChatRun(
        messages=[],
        tool_call_id="scombz-call-2",
        conversation_id="conversation-1",
        tool_name=SCOMBZ_TOOL_NAME,
        tool_call_count=2,
    )
    store.continue_run(
        run_id,
        deferred=second,
        context=[],
        generation=claimed.generation,
        claimed_call_id="scombz-call-1",
    )
    with pytest.raises(ValueError, match="does not belong"):
        store.claim(
            run_id,
            tool_call_id="scombz-call-1",
            tool_name=SCOMBZ_TOOL_NAME,
            tool_version=1,
        )


@pytest.mark.asyncio
async def test_function_model_replays_scombz_calendar_then_answer(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    calls = [0]

    def model_function(messages, _):
        calls[0] += 1
        if calls[0] == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        SCOMBZ_TOOL_NAME,
                        {},
                        tool_call_id="scombz-call-1",
                    )
                ]
            )
        if calls[0] == 2:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        CALENDAR_TOOL_NAME,
                        {},
                        tool_call_id="calendar-call-1",
                    )
                ]
            )
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "final_result",
                    {
                        "content_markdown": "SCombZとCalendarを確認しました。",
                        "evidence_ids": [
                            "scombz-page-summary-v1-run",
                            "calendar-availability-v1-run",
                        ],
                    },
                    tool_call_id="proposal-call-1",
                )
            ]
        )

    model = FunctionModel(model_function, model_name="chat-test")
    test_agent = Agent(
        model,
        output_type=[ChatDraft, DeferredToolRequests],
        instructions="test",
        tools=[scombz_page_summary, google_calendar_availability],
    )
    backend = OpenAIAgent(api_key="synthetic-key", model="synthetic-model")
    backend._chat_agent = lambda *, advertised_tools: test_agent  # type: ignore[method-assign]

    first = await backend.start_chat(
        conversation_id="conversation-1",
        message="課題と空き時間を確認して",
        history=[],
        advertised_tools={SCOMBZ_TOOL_NAME, CALENDAR_TOOL_NAME},
    )
    assert first.deferred is not None
    scombz_evidence = EvidenceLink(
        evidence_id="scombz-page-summary-v1-run",
        title="SCombZページ概要",
        source_type="scombz",
        locator="orbit-scombz://page-summary/1234567890abcdef",
        data_classification="personal",
    )
    second = await backend.resume_chat(
        deferred=first.deferred,
        tool_result=ScombzPageSummaryResult(
            route="home",
            task_count=1,
            announcement_count=2,
            related_link_count=3,
            has_current_course=False,
        ),
        context=[scombz_evidence],
        advertised_tools={SCOMBZ_TOOL_NAME, CALENDAR_TOOL_NAME},
    )
    assert second.deferred is not None
    calendar_evidence = EvidenceLink(
        evidence_id="calendar-availability-v1-run",
        title="Calendarの空き時間",
        source_type="calendar",
        locator="orbit-calendar://availability/1234567890abcdef",
        data_classification="personal",
    )
    third = await backend.resume_chat(
        deferred=second.deferred,
        tool_result=CalendarAvailabilityResult(
            status="known",
            time_zone="Asia/Tokyo",
            window_start="2026-08-17T00:00:00+09:00",
            window_end="2026-08-24T00:00:00+09:00",
            available_minutes=100,
            busy_minutes=20,
            free_intervals=[],
            reason_code=None,
        ),
        context=[scombz_evidence, calendar_evidence],
        advertised_tools={SCOMBZ_TOOL_NAME, CALENDAR_TOOL_NAME},
        seen_tool_call_ids={first.deferred.tool_call_id},
    )
    assert third.draft is not None
    assert third.draft.evidence_ids == [
        "scombz-page-summary-v1-run",
        "calendar-availability-v1-run",
    ]
