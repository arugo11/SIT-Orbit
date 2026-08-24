import pytest
from fastapi.testclient import TestClient
from orbit_api.agent.chat import ChatRunService, ChatRunStore, FixtureChatBackend
from orbit_api.agent.openai_backend import OpenAIAgent
from orbit_api.agent.pydantic_ai_backend import (
    CALENDAR_TOOL_NAME,
    CAST_ALUMNI_TOOL_NAME,
    CAST_TOOL_NAME,
    LIBRARY_CATALOG_SEARCH_TOOL_NAME,
    LIBRARY_ITEM_READ_TOOL_NAME,
    MOODLE_TOOL_NAME,
    MY_LIBRARY_TOOL_NAME,
    SCOMBZ_READ_TOOL_NAME,
    SCOMBZ_TOOL_NAME,
    ChatAgentExecution,
    ChatDraft,
    DeferredChatRun,
    cast_read,
    google_calendar_availability,
    library_catalog_search,
    library_item_read,
    moodle_read,
    my_library_read,
    scombz_page_summary,
)
from orbit_api.main import app
from orbit_api.models import (
    CalendarAvailabilityResult,
    CastAlumniReadResult,
    CastReadResult,
    ChatClientTool,
    ChatHistoryMessage,
    ChatRunRequest,
    ChatRunToolRequired,
    ChatToolResultRequest,
    EvidenceLink,
    LegacyMyLibraryReadResult,
    LibraryBibliographicRecord,
    LibraryCatalogSearchResult,
    LibraryHoldingSummary,
    LibraryItemReadResult,
    MoodleReadResult,
    MyLibraryItem,
    ScombzPageSummaryResult,
    ScombzReadResult,
    ScopedMyLibraryReadResult,
)
from pydantic_ai import Agent, DeferredToolRequests, ModelResponse, ToolCallPart
from pydantic_ai.models.function import FunctionModel


class StubChatBackend:
    def __init__(self) -> None:
        self.resume_calls = 0

    async def start_chat(
        self,
        *,
        conversation_id: str,
        message: str,
        history: list[ChatHistoryMessage],
        context: list[EvidenceLink] | None = None,
        advertised_tools: set[str] | None = None,
    ) -> ChatAgentExecution:
        del message, history, context, advertised_tools
        return ChatAgentExecution(
            deferred=DeferredChatRun(
                messages=[],
                tool_call_id="stub-my-library-call",
                conversation_id=conversation_id,
                tool_name=MY_LIBRARY_TOOL_NAME,
                arguments={
                    "scope": "current_loans",
                    "query": "",
                    "offset": 0,
                    "limit": 20,
                },
            )
        )

    async def resume_chat(self, **kwargs) -> ChatAgentExecution:
        del kwargs
        self.resume_calls += 1
        return ChatAgentExecution(
            draft=ChatDraft(content_markdown="Stub continuation", evidence_ids=[])
        )


def scoped_chat_result() -> ScopedMyLibraryReadResult:
    return ScopedMyLibraryReadResult(
        status="known",
        scope="current_loans",
        items=[
            MyLibraryItem(
                resource_ref="orbit-library://record/1234567890abcdef",
                title="合成貸出資料",
                author="公開著者",
                status="loaned",
                due_date="2026-09-01",
                renewable=True,
                activity_date=None,
                request_type=None,
            )
        ],
        total_count=1,
        next_offset=None,
        loan_count=1,
        reservation_count=None,
        overdue_count=0,
        renewable_count=1,
        earliest_due_date="2026-09-01",
        reason_code=None,
    )


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
    assert "接続設定" not in payload["message"]["content_markdown"]
    assert "許可を確認" not in payload["message"]["content_markdown"]


@pytest.mark.asyncio
@pytest.mark.parametrize("backend_name", ["fixture", "openai"])
async def test_chat_service_rejects_scoped_my_library_before_backend_resume(
    monkeypatch,
    backend_name: str,
) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", backend_name)
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    backend = StubChatBackend()
    service = ChatRunService(backend_factory=lambda: backend)
    pending = await service.start(
        ChatRunRequest(
            conversation_id=f"chat-boundary-{backend_name}",
            message="My Libraryの貸出を確認して",
            client_tools=[ChatClientTool(name=MY_LIBRARY_TOOL_NAME, version=1)],
        )
    )
    assert isinstance(pending, ChatRunToolRequired)

    with pytest.raises(ValueError, match="requires the explicitly consented Azure Agent"):
        await service.submit_tool_result(
            pending.run_id,
            ChatToolResultRequest(
                tool_call_id=pending.calls[0].tool_call_id,
                name=MY_LIBRARY_TOOL_NAME,
                version=1,
                result=scoped_chat_result(),
            ),
        )
    assert backend.resume_calls == 0


@pytest.mark.asyncio
async def test_chat_service_accepts_scoped_my_library_for_azure_stub(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "azure_openai")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    backend = StubChatBackend()
    service = ChatRunService(backend_factory=lambda: backend)
    pending = await service.start(
        ChatRunRequest(
            conversation_id="chat-boundary-azure",
            message="My Libraryの貸出を確認して",
            client_tools=[ChatClientTool(name=MY_LIBRARY_TOOL_NAME, version=1)],
        )
    )
    assert isinstance(pending, ChatRunToolRequired)

    completed = await service.submit_tool_result(
        pending.run_id,
        ChatToolResultRequest(
            tool_call_id=pending.calls[0].tool_call_id,
            name=MY_LIBRARY_TOOL_NAME,
            version=1,
            result=scoped_chat_result(),
        ),
    )
    assert completed.status == "completed"
    assert backend.resume_calls == 1


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


def test_fixture_chat_route_rejects_scoped_my_library_result(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "fixture")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    with TestClient(app) as client:
        first = client.post(
            "/v1/chat/runs",
            json={
                "conversation_id": "conversation-route-my-library",
                "message": "My Libraryの貸出と予約を確認して",
                "history": [],
                "client_tools": [{"name": "my_library_read", "version": 1}],
            },
        ).json()
        assert first["status"] == "tool_required"
        call = first["calls"][0]
        second = client.post(
            f"/v1/chat/runs/{first['run_id']}/tool-results",
            json={
                "tool_call_id": call["tool_call_id"],
                "name": "my_library_read",
                "version": 1,
                "result": {
                    "schema_version": "v1",
                    "status": "known",
                    "scope": "current_loans",
                    "items": [
                        {
                            "resource_ref": "orbit-library://record/1234567890abcdef",
                            "title": "合成貸出資料",
                            "author": "公開著者",
                            "status": "loaned",
                            "due_date": "2026-09-01",
                            "renewable": True,
                            "activity_date": None,
                            "request_type": None,
                        }
                    ],
                    "total_count": 1,
                    "next_offset": None,
                    "loan_count": 1,
                    "reservation_count": None,
                    "overdue_count": 0,
                    "renewable_count": 1,
                    "earliest_due_date": "2026-09-01",
                    "reason_code": None,
                },
            },
        )
    assert second.status_code == 422
    assert "requires the explicitly consented Azure Agent" in second.text


def test_my_library_projection_rejects_detail_and_unavailable_data() -> None:
    with pytest.raises(ValueError):
        LegacyMyLibraryReadResult.model_validate(
            {
                "schema_version": "v1",
                "status": "known",
                "loan_count": 1,
                "reservation_count": 0,
                "overdue_count": 0,
                "renewable_count": 1,
                "earliest_due_date": "2026-09-01",
                "reason_code": None,
                "titles": ["must stay local"],
            }
        )
    with pytest.raises(ValueError, match="cannot include derived data"):
        LegacyMyLibraryReadResult(
            status="reauth_required",
            loan_count=1,
            reservation_count=0,
            overdue_count=0,
            renewable_count=0,
            earliest_due_date=None,
            reason_code="login_required",
        )


def test_fixture_chat_route_runs_cast_derived_tool_loop(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "fixture")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    with TestClient(app) as client:
        first = client.post(
            "/v1/chat/runs",
            json={
                "conversation_id": "conversation-route-cast",
                "message": "CASTの求人と説明会を確認して",
                "history": [],
                "client_tools": [{"name": "cast_read", "version": 1}],
            },
        ).json()
        assert first["status"] == "tool_required"
        call = first["calls"][0]
        second = client.post(
            f"/v1/chat/runs/{first['run_id']}/tool-results",
            json={
                "tool_call_id": call["tool_call_id"],
                "name": "cast_read",
                "version": 1,
                "result": {
                    "schema_version": "v1",
                    "status": "known",
                    "notice_count": 3,
                    "new_job_count": 4,
                    "new_internship_count": 7,
                    "new_event_count": 2,
                    "has_counseling_reservation": False,
                    "nearest_notice_date": "2026-08-20",
                    "reason_code": None,
                },
            },
        )
    assert second.status_code == 200
    completed = second.json()
    assert completed["status"] == "completed"
    assert "新着求人: 4件" in completed["message"]["content_markdown"]
    assert completed["message"]["evidence"][0]["source_type"] == "career"
    assert "合成キャリア講座" not in second.text
    assert "応募履歴" not in second.text


def test_cast_projection_rejects_detail_and_unavailable_data() -> None:
    with pytest.raises(ValueError):
        CastReadResult.model_validate(
            {
                "schema_version": "v1",
                "status": "known",
                "notice_count": 1,
                "new_job_count": 4,
                "new_internship_count": 7,
                "new_event_count": 2,
                "has_counseling_reservation": False,
                "nearest_notice_date": "2026-08-20",
                "reason_code": None,
                "notice_titles": ["must stay local"],
            }
        )
    with pytest.raises(ValueError, match="cannot include derived data"):
        CastReadResult(
            status="reauth_required",
            notice_count=1,
            new_job_count=0,
            new_internship_count=0,
            new_event_count=0,
            has_counseling_reservation=False,
            nearest_notice_date=None,
            reason_code="login_required",
        )


def test_fixture_chat_route_runs_cast_alumni_aggregate_loop(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "fixture")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    with TestClient(app) as client:
        first = client.post(
            "/v1/chat/runs",
            json={
                "conversation_id": "conversation-route-cast-alumni",
                "message": "就活サポーターの回答可能テーマと面談可能頻度を確認して",
                "history": [],
                "client_tools": [{"name": CAST_ALUMNI_TOOL_NAME, "version": 1}],
            },
        ).json()
        assert first["status"] == "tool_required"
        call = first["calls"][0]
        second = client.post(
            f"/v1/chat/runs/{first['run_id']}/tool-results",
            json={
                "tool_call_id": call["tool_call_id"],
                "name": CAST_ALUMNI_TOOL_NAME,
                "version": 1,
                "result": {
                    "schema_version": "v1",
                    "status": "known",
                    "data_classification": "personal",
                    "profile_count": 2,
                    "topic_categories": ["技術・研究", "選考・応募書類"],
                    "availability_frequencies": ["monthly"],
                    "meeting_modes": ["online"],
                    "shareable_insight_categories": ["選考体験"],
                    "contact_present": True,
                    "discovered_link_count": 1,
                    "reason_code": None,
                },
            },
        )
    assert second.status_code == 200
    completed = second.json()
    assert completed["status"] == "completed"
    assert "登録プロフィール: 2件" in completed["message"]["content_markdown"]
    assert completed["message"]["evidence"][0]["evidence_id"].startswith(
        "cast-alumni-v1-"
    )
    assert "氏名" not in second.text
    assert "連絡先" in completed["message"]["content_markdown"]


def test_cast_alumni_result_has_no_person_fields() -> None:
    with pytest.raises(ValueError):
        CastAlumniReadResult.model_validate(
            {
                "schema_version": "v1",
                "status": "known",
                "data_classification": "personal",
                "profile_count": 1,
                "topic_categories": [],
                "availability_frequencies": [],
                "meeting_modes": [],
                "shareable_insight_categories": [],
                "contact_present": False,
                "discovered_link_count": 0,
                "reason_code": None,
                "names": ["must stay local"],
            }
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
async def test_function_model_reads_authoritative_opac_detail_after_catalog_discovery(
    monkeypatch,
) -> None:
    """A location follow-up must cross the discovery/detail boundary once."""

    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    resource_ref = "orbit-library://record/0123456789abcdef"
    calls = [0]
    captured: list[str] = []

    def model_function(messages, _info):
        calls[0] += 1
        captured.append(str(messages))
        if calls[0] == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        LIBRARY_CATALOG_SEARCH_TOOL_NAME,
                        {"query": "ロボット解体新書", "limit": 10},
                        tool_call_id="catalog-location-1",
                    )
                ]
            )
        if calls[0] == 2:
            # The opaque reference returned by discovery is the hand-off into
            # the authoritative record read; no title-specific special case is
            # involved in this transition.
            assert resource_ref in captured[-1]
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        LIBRARY_ITEM_READ_TOOL_NAME,
                        {"resource_ref": resource_ref},
                        tool_call_id="item-location-1",
                    )
                ]
            )
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "final_result",
                    {
                        "content_markdown": (
                            "豊洲図書館の配架場所と請求記号を確認しました。"
                        ),
                        "evidence_ids": [
                            "library-item-read-v1-0123456789abcdef"
                        ],
                    },
                    tool_call_id="final-location-1",
                )
            ]
        )

    agent = Agent(
        FunctionModel(model_function, model_name="library-location-test"),
        output_type=[ChatDraft, DeferredToolRequests],
        instructions="test",
        tools=[library_catalog_search, library_item_read],
    )
    backend = OpenAIAgent(
        api_key="synthetic-key",
        model="synthetic-model",
        provider_name="Azure OpenAI",
    )
    backend._chat_agent = lambda *, advertised_tools: agent  # type: ignore[method-assign]
    advertised = {
        LIBRARY_CATALOG_SEARCH_TOOL_NAME,
        LIBRARY_ITEM_READ_TOOL_NAME,
    }
    catalog_evidence = EvidenceLink(
        evidence_id="library-catalog-search-v1-1111111111111111",
        title="芝浦工業大学公式OPACの公開カタログ検索",
        source_type="library",
        locator="orbit-library://public/catalog-location",
        data_classification="public",
    )
    catalog_item = LibraryBibliographicRecord(
        resource_ref=resource_ref,
        title="ロボット解体新書",
        authors=["神崎洋治"],
        subjects=["ロボット"],
        isbn=None,
        publisher=None,
        publication_year=2017,
        format="book",
        campus="toyosu",
        url=(
            "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/BB23092122"
        ),
        holdings=[
            LibraryHoldingSummary(
                campus="toyosu",
                location="豊洲図書館 豊洲図書館",
                call_number="548.3/Ko98",
                status="available",
                due_date=None,
                reservation_count=0,
            )
        ],
        related_records=[],
    )

    first = await backend.start_chat(
        conversation_id="conversation-library-location",
        message="この本はどこに配架されていますか？",
        history=[
            ChatHistoryMessage(role="user", content="ロボット解体新書は大学にありますか？")
        ],
        advertised_tools=advertised,
    )
    assert first.deferred is not None
    assert first.deferred.tool_name == LIBRARY_CATALOG_SEARCH_TOOL_NAME

    second = await backend.resume_chat(
        deferred=first.deferred,
        tool_result=LibraryCatalogSearchResult(
            status="known",
            query="ロボット解体新書",
            items=[catalog_item],
            reason_code=None,
        ),
        context=[catalog_evidence],
        advertised_tools=advertised,
    )
    assert second.deferred is not None
    assert second.deferred.tool_name == LIBRARY_ITEM_READ_TOOL_NAME
    assert second.deferred.arguments == {"resource_ref": resource_ref}

    detail_evidence = EvidenceLink(
        evidence_id="library-item-read-v1-0123456789abcdef",
        title="芝浦工業大学公式OPACの公開書誌レコード",
        source_type="library",
        locator="orbit-library://public/item-location-123",
        data_classification="public",
    )
    completed = await backend.resume_chat(
        deferred=second.deferred,
        tool_result=LibraryItemReadResult(
            status="known",
            resource_ref=resource_ref,
            item=catalog_item,
            reason_code=None,
        ),
        context=[catalog_evidence, detail_evidence],
        advertised_tools=advertised,
        seen_tool_call_ids={first.deferred.tool_call_id},
    )
    assert completed.draft is not None
    assert "library-item-read-v1-0123456789abcdef" in captured[-1]
    assert completed.draft.evidence_ids == [
        "library-item-read-v1-0123456789abcdef"
    ]
    assert "豊洲図書館" in completed.draft.content_markdown
    assert "配架場所" in completed.draft.content_markdown


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


@pytest.mark.asyncio
async def test_function_model_sends_my_library_projection_only_to_azure(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    calls = [0]
    captured = [""]

    def model_function(messages, _info):
        calls[0] += 1
        if calls[0] == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        MY_LIBRARY_TOOL_NAME,
                        {},
                        tool_call_id="my-library-call-1",
                    )
                ]
            )
        captured[0] = str(messages)
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "final_result",
                    {
                        "content_markdown": "返却期限を確認しました。",
                        "evidence_ids": ["my-library-summary-v1-run"],
                    },
                    tool_call_id="final-my-library-1",
                )
            ]
        )

    agent = Agent(
        FunctionModel(model_function, model_name="my-library-test"),
        output_type=[ChatDraft, DeferredToolRequests],
        instructions="test",
        tools=[my_library_read],
    )
    backend = OpenAIAgent(
        api_key="synthetic-key",
        model="synthetic-model",
        provider_name="Azure OpenAI",
    )
    backend._chat_agent = lambda *, advertised_tools: agent  # type: ignore[method-assign]
    first = await backend.start_chat(
        conversation_id="conversation-my-library",
        message="My Libraryを確認して",
        history=[],
        advertised_tools={MY_LIBRARY_TOOL_NAME},
    )
    assert first.deferred is not None
    evidence = EvidenceLink(
        evidence_id="my-library-summary-v1-run",
        title="My Library概要",
        source_type="library",
        locator="orbit-library://summary/1234567890abcdef",
        data_classification="personal",
    )
    result = ScopedMyLibraryReadResult(
        status="known",
        scope="current_loans",
        items=[
            MyLibraryItem(
                resource_ref="orbit-library://record/1234567890abcdef",
                title="合成貸出資料",
                author="公開著者",
                status="loaned",
                due_date="2026-09-01",
                renewable=True,
                activity_date=None,
                request_type=None,
            )
        ],
        total_count=1,
        next_offset=None,
        loan_count=1,
        reservation_count=None,
        overdue_count=0,
        renewable_count=1,
        earliest_due_date="2026-09-01",
        reason_code=None,
    )
    openai_backend = OpenAIAgent(api_key="synthetic-key", model="synthetic-model")
    openai_backend._chat_agent = lambda *, advertised_tools: agent  # type: ignore[method-assign]
    with pytest.raises(ValueError, match="requires the explicitly consented Azure Agent"):
        await openai_backend.resume_chat(
            deferred=first.deferred,
            tool_result=result,
            context=[evidence],
            advertised_tools={MY_LIBRARY_TOOL_NAME},
        )

    second = await backend.resume_chat(
        deferred=first.deferred,
        tool_result=result,
        context=[evidence],
        advertised_tools={MY_LIBRARY_TOOL_NAME},
    )
    assert second.draft is not None
    assert "loan_count" in captured[0]
    assert "分散システム入門" not in captured[0]
    assert "material-secret" not in captured[0]


@pytest.mark.asyncio
async def test_function_model_runs_moodle_library_cast_sequence_with_derived_values_only(
    monkeypatch,
) -> None:
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    calls = [0]
    captured: list[str] = []

    def model_function(messages, _info):
        calls[0] += 1
        captured.append(str(messages))
        if calls[0] == 1:
            return ModelResponse(
                parts=[ToolCallPart(MOODLE_TOOL_NAME, {}, tool_call_id="moodle-1")]
            )
        if calls[0] == 2:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        MY_LIBRARY_TOOL_NAME,
                        {},
                        tool_call_id="library-1",
                    )
                ]
            )
        if calls[0] == 3:
            return ModelResponse(
                parts=[ToolCallPart(CAST_TOOL_NAME, {}, tool_call_id="cast-1")]
            )
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "final_result",
                    {
                        "content_markdown": "学内サービスの要約を確認しました。",
                        "evidence_ids": [
                            "moodle-summary-v1-sequence",
                            "my-library-summary-v1-sequence",
                            "cast-summary-v1-sequence",
                        ],
                    },
                    tool_call_id="final-sequence",
                )
            ]
        )

    agent = Agent(
        FunctionModel(model_function, model_name="campus-sequence-test"),
        output_type=[ChatDraft, DeferredToolRequests],
        instructions="test",
        tools=[moodle_read, my_library_read, cast_read],
    )
    backend = OpenAIAgent(
        api_key="synthetic-key",
        model="synthetic-model",
        provider_name="Azure OpenAI",
    )
    backend._chat_agent = lambda *, advertised_tools: agent  # type: ignore[method-assign]
    advertised = {MOODLE_TOOL_NAME, MY_LIBRARY_TOOL_NAME, CAST_TOOL_NAME}
    evidence = [
        EvidenceLink(
            evidence_id="moodle-summary-v1-sequence",
            title="Moodle概要",
            source_type="assignment",
            locator="orbit-moodle://summary/1234567890abcdef",
            data_classification="personal",
        ),
        EvidenceLink(
            evidence_id="my-library-summary-v1-sequence",
            title="My Library概要",
            source_type="library",
            locator="orbit-library://summary/1234567890abcdef",
            data_classification="personal",
        ),
        EvidenceLink(
            evidence_id="cast-summary-v1-sequence",
            title="CAST概要",
            source_type="career",
            locator="orbit-cast://summary/1234567890abcdef",
            data_classification="personal",
        ),
    ]
    first = await backend.start_chat(
        conversation_id="conversation-campus-sequence",
        message="課題、返却期限、就活情報を順番に確認して",
        history=[],
        advertised_tools=advertised,
    )
    assert first.deferred is not None
    second = await backend.resume_chat(
        deferred=first.deferred,
        tool_result=MoodleReadResult(
            status="known",
            course_count=2,
            upcoming_item_count=1,
            overdue_count=0,
            earliest_due_at="2026-08-24T06:00:00Z",
            unread_notification_count=3,
            reason_code=None,
        ),
        context=evidence,
        advertised_tools=advertised,
    )
    assert second.deferred is not None
    third = await backend.resume_chat(
        deferred=second.deferred,
        tool_result=ScopedMyLibraryReadResult(
            status="known",
            scope="current_loans",
            items=[
                MyLibraryItem(
                    resource_ref="orbit-library://record/1234567890abcdef",
                    title="合成貸出資料",
                    author="公開著者",
                    status="loaned",
                    due_date="2026-09-01",
                    renewable=True,
                    activity_date=None,
                    request_type=None,
                )
            ],
            total_count=1,
            next_offset=None,
            loan_count=1,
            reservation_count=None,
            overdue_count=0,
            renewable_count=1,
            earliest_due_date="2026-09-01",
            reason_code=None,
        ),
        context=evidence,
        advertised_tools=advertised,
    )
    assert third.deferred is not None
    fourth = await backend.resume_chat(
        deferred=third.deferred,
        tool_result=CastReadResult(
            status="known",
            notice_count=3,
            new_job_count=4,
            new_internship_count=7,
            new_event_count=2,
            has_counseling_reservation=False,
            nearest_notice_date="2026-08-20",
            reason_code=None,
        ),
        context=evidence,
        advertised_tools=advertised,
    )
    assert fourth.draft is not None
    serialized = "\n".join(captured)
    assert "course_count" in serialized
    assert "loan_count" in serialized
    assert "new_job_count" in serialized
    assert "合成キャリア講座" not in serialized
    assert "応募履歴" not in serialized
