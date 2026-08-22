import pytest
from fastapi.testclient import TestClient
from orbit_api.agent.chat import ChatRunStore, FixtureChatBackend
from orbit_api.agent.openai_backend import OpenAIAgent
from orbit_api.agent.pydantic_ai_backend import (
    CALENDAR_TOOL_NAME,
    MOODLE_TOOL_NAME,
    SCOMBZ_READ_TOOL_NAME,
    SCOMBZ_TOOL_NAME,
    ChatDraft,
    DeferredChatRun,
    google_calendar_availability,
    moodle_read,
    scombz_page_summary,
)
from orbit_api.main import app
from orbit_api.models import (
    CalendarAvailabilityResult,
    ChatClientTool,
    ChatHistoryMessage,
    ChatRunRequest,
    EvidenceLink,
    MoodleReadResult,
    ScombzPageSummaryResult,
    ScombzReadResult,
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


def test_fixture_chat_route_runs_scombz_tool_loop(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "fixture")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    with TestClient(app) as client:
        first = client.post(
            "/v1/chat/runs",
            json={
                "conversation_id": "conversation-route-scombz",
                "message": "授業情報を確認して",
                "history": [],
                "client_tools": [{"name": "scombz_read", "version": 1}],
            },
        )
        assert first.status_code == 200
        pending = first.json()
        assert pending["status"] == "tool_required"
        call = pending["calls"][0]

        second = client.post(
            f"/v1/chat/runs/{pending['run_id']}/tool-results",
            json={
                "tool_call_id": call["tool_call_id"],
                "name": call["name"],
                "version": call["version"],
                "result": {
                    "schema_version": "v1",
                    "status": "known",
                    "route": "timetable",
                    "tasks": [],
                    "announcements": [],
                    "timetable": [],
                    "current_course": "組込みシステム",
                    "restricted_present": True,
                    "reason_code": None,
                },
            },
        )

    assert second.status_code == 200
    completed = second.json()
    assert completed["status"] == "completed"
    assert "組込みシステム" in completed["message"]["content_markdown"]
    assert "成績・出席・個人評価" in completed["message"]["content_markdown"]
    assert completed["message"]["evidence"][0]["source_type"] == "scombz"


def test_fixture_chat_route_runs_sitrus_grade_tool_loop(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "fixture")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    with TestClient(app) as client:
        first = client.post(
            "/v1/chat/runs",
            json={
                "conversation_id": "conversation-route-sitrus",
                "message": "SITRUSの成績とGPAを確認して",
                "history": [],
                "client_tools": [{"name": "sitrus_read", "version": 1}],
            },
        )
        assert first.status_code == 200
        pending = first.json()
        call = pending["calls"][0]
        second = client.post(
            f"/v1/chat/runs/{pending['run_id']}/tool-results",
            json={
                "tool_call_id": call["tool_call_id"],
                "name": call["name"],
                "version": call["version"],
                "result": {
                    "schema_version": "v1",
                    "status": "known",
                    "report_label": "2025年度 秋学期 分まで",
                    "grades": [
                        {
                            "subject": "線形代数第１",
                            "course_code": "L0410100",
                            "credits": 2,
                            "grade": "A",
                            "year": 2024,
                            "term": 2,
                            "term_slot": 1,
                            "repeated": False,
                        }
                    ],
                    "cumulative_gpa": 3.1,
                    "reason_code": None,
                },
            },
        )
    assert second.status_code == 200
    completed = second.json()
    assert completed["status"] == "completed"
    assert "線形代数第１" in completed["message"]["content_markdown"]
    assert "累積GPA: 3.1" in completed["message"]["content_markdown"]
    assert completed["message"]["evidence"][0]["source_type"] == "learning_history"
    assert completed["message"]["evidence"][0]["evidence_id"].startswith(
        "sitrus-grades-v1-"
    )


def test_sitrus_unavailable_result_cannot_resume(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "fixture")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    with TestClient(app) as client:
        first = client.post(
            "/v1/chat/runs",
            json={
                "conversation_id": "conversation-route-sitrus-unavailable",
                "message": "成績を確認して",
                "history": [],
                "client_tools": [{"name": "sitrus_read", "version": 1}],
            }
        ).json()
        call = first["calls"][0]
        response = client.post(
            f"/v1/chat/runs/{first['run_id']}/tool-results",
            json={
                "tool_call_id": call["tool_call_id"],
                "name": "sitrus_read",
                "version": 1,
                "result": {
                    "schema_version": "v1",
                    "status": "unavailable",
                    "report_label": None,
                    "grades": [],
                    "cumulative_gpa": None,
                    "reason_code": "grade_page_not_active",
                },
            },
        )
    assert response.status_code == 422


def test_fixture_chat_route_runs_moodle_derived_tool_loop(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "fixture")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    with TestClient(app) as client:
        first = client.post(
            "/v1/chat/runs",
            json={
                "conversation_id": "conversation-route-moodle",
                "message": "Moodleの課題を確認して",
                "history": [],
                "client_tools": [{"name": "moodle_read", "version": 1}],
            },
        ).json()
        assert first["status"] == "tool_required"
        call = first["calls"][0]
        second = client.post(
            f"/v1/chat/runs/{first['run_id']}/tool-results",
            json={
                "tool_call_id": call["tool_call_id"],
                "name": "moodle_read",
                "version": 1,
                "result": {
                    "schema_version": "v1",
                    "status": "known",
                    "course_count": 4,
                    "upcoming_item_count": 2,
                    "overdue_count": 1,
                    "earliest_due_at": "2026-08-24T06:00:00Z",
                    "unread_notification_count": 3,
                    "reason_code": None,
                },
            },
        )
    assert second.status_code == 200
    completed = second.json()
    assert completed["status"] == "completed"
    assert "コース: 4件" in completed["message"]["content_markdown"]
    assert completed["message"]["evidence"][0]["source_type"] == "assignment"
    serialized = second.text
    assert "制御工学" not in serialized
    assert "レポート1" not in serialized


def test_moodle_projection_rejects_detail_and_unavailable_data() -> None:
    with pytest.raises(ValueError):
        MoodleReadResult.model_validate(
            {
                "schema_version": "v1",
                "status": "known",
                "course_count": 1,
                "upcoming_item_count": 1,
                "overdue_count": 0,
                "earliest_due_at": None,
                "unread_notification_count": 0,
                "reason_code": None,
                "course_names": ["must stay local"],
            }
        )
    with pytest.raises(ValueError, match="cannot include derived data"):
        MoodleReadResult(
            status="reauth_required",
            course_count=1,
            upcoming_item_count=0,
            overdue_count=0,
            earliest_due_at=None,
            unread_notification_count=0,
            reason_code="login_required",
        )


@pytest.mark.asyncio
async def test_fixture_chat_replays_local_scombz_read_without_exposing_restricted_values() -> None:
    backend = FixtureChatBackend()
    first = await backend.start_chat(
        conversation_id="conversation-scombz-fixture",
        message="時間割と成績ページを確認して",
        history=[],
        advertised_tools={SCOMBZ_READ_TOOL_NAME},
    )

    assert first.deferred is not None
    evidence = EvidenceLink(
        evidence_id="scombz-read-v1-fixture",
        title="SCombZから取得した表示情報",
        source_type="scombz",
        locator="orbit-scombz://read/0123456789abcdef",
        data_classification="personal",
    )
    second = await backend.resume_chat(
        deferred=first.deferred,
        tool_result=ScombzReadResult(
            status="known",
            route="timetable",
            tasks=[],
            announcements=[],
            timetable=[],
            current_course="組込みシステム",
            restricted_present=True,
            reason_code=None,
        ),
        context=[evidence],
        advertised_tools={SCOMBZ_READ_TOOL_NAME},
    )

    assert second.draft is not None
    assert second.draft.evidence_ids == [evidence.evidence_id]
    assert "組込みシステム" in second.draft.content_markdown
    assert "成績・出席・個人評価" in second.draft.content_markdown
    assert "値はこのローカルChatの結果にも含めません" in second.draft.content_markdown


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


@pytest.mark.asyncio
async def test_function_model_sends_only_moodle_derived_projection(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    calls = [0]
    captured = [""]

    def model_function(messages, _info):
        calls[0] += 1
        if calls[0] == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart(MOODLE_TOOL_NAME, {}, tool_call_id="moodle-call-1")
                ]
            )
        captured[0] = str(messages)
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "final_result",
                    {
                        "content_markdown": "Moodleの期限を確認しました。",
                        "evidence_ids": ["moodle-summary-v1-run"],
                    },
                    tool_call_id="final-moodle-1",
                )
            ]
        )

    agent = Agent(
        FunctionModel(model_function, model_name="moodle-test"),
        output_type=[ChatDraft, DeferredToolRequests],
        instructions="test",
        tools=[moodle_read],
    )
    backend = OpenAIAgent(api_key="synthetic-key", model="synthetic-model")
    backend._chat_agent = lambda *, advertised_tools: agent  # type: ignore[method-assign]
    first = await backend.start_chat(
        conversation_id="conversation-moodle",
        message="Moodleを確認して",
        history=[],
        advertised_tools={MOODLE_TOOL_NAME},
    )
    assert first.deferred is not None
    evidence = EvidenceLink(
        evidence_id="moodle-summary-v1-run",
        title="Moodle概要",
        source_type="assignment",
        locator="orbit-moodle://summary/1234567890abcdef",
        data_classification="personal",
    )
    second = await backend.resume_chat(
        deferred=first.deferred,
        tool_result=MoodleReadResult(
            status="known",
            course_count=2,
            upcoming_item_count=1,
            overdue_count=0,
            earliest_due_at="2026-08-24T06:00:00Z",
            unread_notification_count=2,
            reason_code=None,
        ),
        context=[evidence],
        advertised_tools={MOODLE_TOOL_NAME},
    )
    assert second.draft is not None
    assert "course_count" in captured[0]
    assert "制御工学" not in captured[0]
    assert "レポート1" not in captured[0]
