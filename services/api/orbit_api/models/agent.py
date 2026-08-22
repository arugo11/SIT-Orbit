"""Strict request and response models for resumable agent runs.

The regular domain models predate the resumable agent API and intentionally
remain backwards compatible.  Run envelopes are a narrower boundary: unknown
fields are rejected and the response union is discriminated by ``status``.
"""

from datetime import datetime
from typing import Annotated, Any, Literal
from urllib.parse import urlparse

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
    model_validator,
)

from .domain import ActionProposal, EvidenceLink, OrbitEvent


class StrictApiModel(BaseModel):
    """Base class for API envelopes that must not accept extra fields."""

    model_config = ConfigDict(extra="forbid", strict=True)


class CalendarAvailabilityInterval(StrictApiModel):
    """One derived free-time interval, without calendar event details."""

    start: StrictStr = Field(min_length=1, max_length=40)
    end: StrictStr = Field(min_length=1, max_length=40)

    @model_validator(mode="after")
    def interval_is_ordered_rfc3339(self) -> "CalendarAvailabilityInterval":
        try:
            start = datetime.fromisoformat(self.start.replace("Z", "+00:00"))
            end = datetime.fromisoformat(self.end.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError(
                "Calendar availability intervals must use RFC3339 timestamps."
            ) from error
        if start.tzinfo is None or end.tzinfo is None:
            raise ValueError("Calendar availability timestamps must include a timezone.")
        if start >= end:
            raise ValueError("Calendar availability interval start must precede end.")
        return self


class CalendarAvailabilityResult(StrictApiModel):
    """Minimal v1 result accepted from the extension's Calendar connector.

    Event IDs, titles, attendees, locations, descriptions, and raw Google
    responses deliberately have no representation in this model.
    """

    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "unknown", "reauth_required", "unavailable"]
    time_zone: StrictStr = Field(min_length=1, max_length=100)
    window_start: StrictStr = Field(min_length=1, max_length=40)
    window_end: StrictStr = Field(min_length=1, max_length=40)
    available_minutes: StrictInt | None = Field(default=None, ge=0, le=10080)
    busy_minutes: StrictInt | None = Field(default=None, ge=0, le=10080)
    free_intervals: list[CalendarAvailabilityInterval] = Field(
        default_factory=list,
        max_length=200,
    )
    reason_code: StrictStr | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def values_match_status(self) -> "CalendarAvailabilityResult":
        try:
            window_start = datetime.fromisoformat(self.window_start.replace("Z", "+00:00"))
            window_end = datetime.fromisoformat(self.window_end.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError("Calendar availability window must use RFC3339 timestamps.") from error
        if window_start.tzinfo is None or window_end.tzinfo is None:
            raise ValueError("Calendar availability window must include a timezone.")
        if window_start >= window_end:
            raise ValueError("Calendar availability window start must precede end.")

        if self.status != "known":
            if self.available_minutes is not None or self.busy_minutes is not None:
                raise ValueError("Unavailable calendar availability cannot include minute totals.")
            if self.free_intervals:
                raise ValueError("Unavailable calendar availability cannot include intervals.")
        elif self.available_minutes is None or self.busy_minutes is None:
            raise ValueError("Known calendar availability requires minute totals.")
        return self


class ScombzPageSummaryResult(StrictApiModel):
    """A minimized summary of the currently displayed ScombZ page.

    This deliberately has no title, URL, course name, item, link, HTML, or
    browser token field.  The tool name and version are carried by the
    surrounding deferred-tool result envelope.
    """

    route: Literal[
        "home",
        "tasks",
        "timetable",
        "announcements",
        "calendar",
        "course",
        "other",
    ]
    task_count: StrictInt = Field(ge=0, le=10000)
    announcement_count: StrictInt = Field(ge=0, le=10000)
    related_link_count: StrictInt = Field(ge=0, le=10000)
    has_current_course: StrictBool


class ScombzReadTask(StrictApiModel):
    """A visible SCombZ assignment projection without HTML or identifiers."""

    course: StrictStr = Field(min_length=1, max_length=200)
    title: StrictStr = Field(min_length=1, max_length=300)
    deadline: StrictStr = Field(min_length=1, max_length=100)


class ScombzReadAnnouncement(StrictApiModel):
    """A visible announcement projection without its raw link or markup."""

    title: StrictStr = Field(min_length=1, max_length=300)


class ScombzReadScheduleItem(StrictApiModel):
    """A visible timetable/absence notice projection."""

    title: StrictStr = Field(min_length=1, max_length=300)
    starts_at: StrictStr | None = Field(default=None, max_length=40)
    ends_at: StrictStr | None = Field(default=None, max_length=40)
    status: Literal["class", "cancelled", "makeup", "unknown"] = "unknown"


class ScombzReadResult(StrictApiModel):
    """Structured SCombZ information returned after an explicit user run.

    Restricted grade/attendance values have no representation here.  A
    connector can report their presence so the UI can ask for confirmation,
    but it cannot forward those values through this result schema.
    """

    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "unavailable"]
    route: Literal[
        "home",
        "tasks",
        "timetable",
        "announcements",
        "calendar",
        "course",
        "other",
    ]
    tasks: list[ScombzReadTask] = Field(default_factory=list, max_length=100)
    announcements: list[ScombzReadAnnouncement] = Field(
        default_factory=list,
        max_length=100,
    )
    timetable: list[ScombzReadScheduleItem] = Field(
        default_factory=list,
        max_length=100,
    )
    current_course: StrictStr | None = Field(default=None, max_length=200)
    restricted_present: StrictBool = False
    reason_code: StrictStr | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def unavailable_has_no_page_data(self) -> "ScombzReadResult":
        if self.status == "unavailable" and (
            self.tasks or self.announcements or self.timetable or self.current_course is not None
        ):
            raise ValueError("Unavailable SCombZ results cannot include page data.")
        return self


class SyllabusResult(StrictApiModel):
    """One result from the official public syllabus search."""

    title: StrictStr = Field(min_length=1, max_length=300)
    course_code: StrictStr | None = Field(default=None, max_length=100)
    faculty: StrictStr | None = Field(default=None, max_length=200)
    url: StrictStr = Field(min_length=1, max_length=500)
    snippet: StrictStr | None = Field(default=None, max_length=1000)

    @model_validator(mode="after")
    def official_https_url(self) -> "SyllabusResult":
        parsed = urlparse(self.url)
        if (
            parsed.scheme != "https"
            or parsed.netloc != "syllabus.sic.shibaura-it.ac.jp"
            or not parsed.path.startswith("/")
        ):
            raise ValueError("Syllabus results must link to the official SIT syllabus site.")
        return self


class SyllabusSearchResult(StrictApiModel):
    """A bounded public result set from the official syllabus search."""

    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "unavailable"]
    query: StrictStr = Field(min_length=1, max_length=200)
    year: StrictInt | None = Field(default=None, ge=2000, le=2100)
    faculty: StrictStr | None = Field(default=None, max_length=200)
    results: list[SyllabusResult] = Field(default_factory=list, max_length=20)
    reason_code: StrictStr | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def unavailable_has_no_results(self) -> "SyllabusSearchResult":
        if self.status == "unavailable" and self.results:
            raise ValueError("Unavailable syllabus results cannot include results.")
        return self


class BrowserReadLink(StrictApiModel):
    """A visible link projection; it has no DOM or form state."""

    label: StrictStr = Field(min_length=1, max_length=300)
    url: StrictStr = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def http_url_only(self) -> "BrowserReadLink":
        parsed = urlparse(self.url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Browser links must use an absolute HTTP(S) URL.")
        if parsed.username or parsed.password:
            raise ValueError("Browser links must not contain credentials.")
        return self


class BrowserReadResult(StrictApiModel):
    """Visible text from a user-authorized URL, bounded for model context."""

    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "unavailable"]
    url: StrictStr = Field(min_length=1, max_length=500)
    title: StrictStr = Field(default="", max_length=300)
    text: StrictStr = Field(default="", max_length=30_000)
    links: list[BrowserReadLink] = Field(default_factory=list, max_length=50)
    truncated: StrictBool = False
    data_classification: Literal["public", "personal"] = "public"
    reason_code: StrictStr | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def validates_safe_browser_projection(self) -> "BrowserReadResult":
        parsed = urlparse(self.url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Browser results must use an absolute HTTP(S) URL.")
        if parsed.username or parsed.password:
            raise ValueError("Browser results must not contain credentials.")
        if self.status == "unavailable" and (self.text or self.links):
            raise ValueError("Unavailable browser results cannot include page data.")
        suspicious = ("<script", "<input", "access_token", "oauth_token", "cookie=")
        lowered = f"{self.title}\n{self.text}".lower()
        if any(marker in lowered for marker in suspicious):
            raise ValueError("Browser results contain a prohibited raw or credential marker.")
        return self


class SitrusGradeItem(StrictApiModel):
    """One minimized grade row extracted from the displayed SITRUS notice."""

    subject: StrictStr = Field(min_length=1, max_length=200)
    course_code: StrictStr | None = Field(default=None, max_length=20)
    credits: StrictInt | None = Field(default=None, ge=0, le=20)
    grade: Literal["S", "A", "B", "C", "D", "F", "G", "N", "X", "#"]
    year: StrictInt | None = Field(default=None, ge=2000, le=2100)
    term: StrictInt | None = Field(default=None, ge=1, le=3)
    term_slot: StrictInt | None = Field(default=None, ge=1, le=4)
    repeated: StrictBool = False


class SitrusGradeResult(StrictApiModel):
    """In-memory SITRUS projection; the PDF and student identity are omitted."""

    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "unavailable"]
    report_label: StrictStr | None = Field(default=None, max_length=100)
    grades: list[SitrusGradeItem] = Field(default_factory=list, max_length=200)
    cumulative_gpa: StrictFloat | None = Field(default=None, ge=0, le=4)
    reason_code: StrictStr | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def unavailable_has_no_grade_data(self) -> "SitrusGradeResult":
        if self.status == "unavailable" and (
            self.report_label is not None or self.grades or self.cumulative_gpa is not None
        ):
            raise ValueError("Unavailable SITRUS results cannot include grade data.")
        return self


class MoodleReadResult(StrictApiModel):
    """Derived Moodle dashboard counts safe for an explicitly confirmed run.

    Course names, activity titles, course IDs, user identity, submission data,
    and source HTML deliberately have no representation in this model.
    """

    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "reauth_required", "unavailable"]
    course_count: StrictInt = Field(ge=0, le=1000)
    upcoming_item_count: StrictInt = Field(ge=0, le=1000)
    overdue_count: StrictInt = Field(ge=0, le=1000)
    earliest_due_at: StrictStr | None = Field(default=None, max_length=40)
    unread_notification_count: StrictInt = Field(ge=0, le=10000)
    reason_code: StrictStr | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def values_match_status(self) -> "MoodleReadResult":
        if self.earliest_due_at is not None:
            try:
                due_at = datetime.fromisoformat(
                    self.earliest_due_at.replace("Z", "+00:00")
                )
            except ValueError as error:
                raise ValueError("Moodle due dates must use RFC3339 timestamps.") from error
            if due_at.tzinfo is None:
                raise ValueError("Moodle due dates must include a timezone.")
        if self.status != "known" and (
            self.course_count
            or self.upcoming_item_count
            or self.overdue_count
            or self.earliest_due_at is not None
            or self.unread_notification_count
        ):
            raise ValueError("Unavailable Moodle results cannot include derived data.")
        return self


class MyLibraryReadResult(StrictApiModel):
    """Derived My Library counts safe for an explicitly confirmed run.

    Book titles, authors, material identifiers, call numbers, user identity,
    and SSO data deliberately have no representation in this model.
    """

    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "reauth_required", "unavailable"]
    loan_count: StrictInt = Field(ge=0, le=1000)
    reservation_count: StrictInt = Field(ge=0, le=1000)
    overdue_count: StrictInt = Field(ge=0, le=1000)
    renewable_count: StrictInt = Field(ge=0, le=1000)
    earliest_due_date: StrictStr | None = Field(default=None, max_length=10)
    reason_code: StrictStr | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def values_match_status(self) -> "MyLibraryReadResult":
        if self.earliest_due_date is not None:
            try:
                datetime.strptime(self.earliest_due_date, "%Y-%m-%d")
            except ValueError as error:
                raise ValueError(
                    "My Library due dates must use YYYY-MM-DD."
                ) from error
        if self.status != "known" and (
            self.loan_count
            or self.reservation_count
            or self.overdue_count
            or self.renewable_count
            or self.earliest_due_date is not None
        ):
            raise ValueError("Unavailable My Library results cannot include derived data.")
        if self.overdue_count > self.loan_count:
            raise ValueError("My Library overdue count cannot exceed loan count.")
        if self.renewable_count > self.loan_count:
            raise ValueError("My Library renewable count cannot exceed loan count.")
        return self


class ClientTool(StrictApiModel):
    """A capability explicitly advertised by the client for one run."""

    name: Literal["scombz_page_summary", "google_calendar_availability"]
    version: Literal[1]


class AgentRunRequest(StrictApiModel):
    """Start one explicit proposal run.

    ``client_tools`` is only a capability advertisement.  The server never
    uses it to access Google; a connected extension must complete the deferred
    tool call and send the minimized derived result back.
    """

    event: OrbitEvent
    context: list[EvidenceLink] = Field(min_length=1, max_length=100)
    client_tools: list[ClientTool] = Field(default_factory=list, max_length=2)

    @model_validator(mode="after")
    def tool_names_are_unique(self) -> "AgentRunRequest":
        names = [tool.name for tool in self.client_tools]
        if len(set(names)) != len(names):
            raise ValueError("Client tool names must be unique per run.")
        return self


class AgentToolResultRequest(StrictApiModel):
    """Result for one registered external tool.

    The envelope repeats the call name and version so a result cannot be
    accidentally delivered to a different deferred tool.  The validator also
    keeps the two strict result schemas from being mixed across tools.
    """

    tool_call_id: StrictStr = Field(min_length=1, max_length=200)
    name: Literal["scombz_page_summary", "google_calendar_availability"] = (
        "google_calendar_availability"
    )
    version: Literal[1] = 1
    result: CalendarAvailabilityResult | ScombzPageSummaryResult

    @model_validator(mode="after")
    def result_matches_tool(self) -> "AgentToolResultRequest":
        if self.name == "google_calendar_availability" and not isinstance(
            self.result, CalendarAvailabilityResult
        ):
            raise ValueError("Calendar tool results must use CalendarAvailabilityResult.")
        if self.name == "scombz_page_summary" and not isinstance(
            self.result, ScombzPageSummaryResult
        ):
            raise ValueError("ScombZ tool results must use ScombzPageSummaryResult.")
        return self


class AgentRunCompleted(StrictApiModel):
    status: Literal["completed"]
    proposal: ActionProposal


class AgentRunToolRequired(StrictApiModel):
    status: Literal["tool_required"]
    run_id: StrictStr = Field(min_length=1, max_length=200)
    calls: list["AgentToolCall"] = Field(min_length=1, max_length=1)


class AgentToolCall(StrictApiModel):
    tool_call_id: StrictStr = Field(min_length=1, max_length=200)
    name: Literal["scombz_page_summary", "google_calendar_availability"]
    version: Literal[1]


# Chat is intentionally a separate envelope from the original action-run API.
# The action API keeps its one-shot semantics for compatibility, while Chat
# can carry a short-lived, linear tool chain without exposing PydanticAI's
# internal message objects to the browser.
ChatRole = Literal["user", "assistant"]
ChatToolName = Literal[
    "scombz_page_summary",
    "scombz_read",
    "google_calendar_availability",
    "syllabus_search",
    "browser_read_url",
    "sitrus_read",
    "moodle_read",
    "my_library_read",
]


class ChatHistoryMessage(StrictApiModel):
    role: ChatRole
    content: StrictStr = Field(min_length=1, max_length=8000)


class ChatClientTool(StrictApiModel):
    name: ChatToolName
    version: Literal[1]


class ChatRunRequest(StrictApiModel):
    conversation_id: StrictStr = Field(min_length=1, max_length=200)
    message: StrictStr = Field(min_length=1, max_length=8000)
    history: list[ChatHistoryMessage] = Field(default_factory=list, max_length=20)
    client_tools: list[ChatClientTool] = Field(default_factory=list, max_length=12)

    @model_validator(mode="after")
    def history_is_bounded(self) -> "ChatRunRequest":
        if sum(len(item.content) for item in self.history) > 64_000:
            raise ValueError("Chat history must not exceed 64000 characters.")
        names = [tool.name for tool in self.client_tools]
        if len(set(names)) != len(names):
            raise ValueError("Chat client tool names must be unique per run.")
        return self


class ChatToolCall(StrictApiModel):
    tool_call_id: StrictStr = Field(min_length=1, max_length=200)
    name: ChatToolName
    version: Literal[1]
    arguments: dict[str, Any] = Field(default_factory=dict)


class ChatToolResultRequest(StrictApiModel):
    tool_call_id: StrictStr = Field(min_length=1, max_length=200)
    name: ChatToolName
    version: Literal[1]
    result: (
        CalendarAvailabilityResult
        | ScombzPageSummaryResult
        | ScombzReadResult
        | SyllabusSearchResult
        | BrowserReadResult
        | SitrusGradeResult
        | MoodleReadResult
        | MyLibraryReadResult
    )

    @model_validator(mode="after")
    def result_matches_tool(self) -> "ChatToolResultRequest":
        if self.name == "google_calendar_availability" and not isinstance(
            self.result, CalendarAvailabilityResult
        ):
            raise ValueError("Calendar tool results must use CalendarAvailabilityResult.")
        if self.name == "scombz_page_summary" and not isinstance(
            self.result, ScombzPageSummaryResult
        ):
            raise ValueError("SCombZ tool results must use ScombzPageSummaryResult.")
        if self.name == "scombz_read" and not isinstance(self.result, ScombzReadResult):
            raise ValueError("SCombZ read results must use ScombzReadResult.")
        if self.name == "syllabus_search" and not isinstance(self.result, SyllabusSearchResult):
            raise ValueError("Syllabus results must use SyllabusSearchResult.")
        if self.name == "browser_read_url" and not isinstance(self.result, BrowserReadResult):
            raise ValueError("Browser results must use BrowserReadResult.")
        if self.name == "sitrus_read" and not isinstance(self.result, SitrusGradeResult):
            raise ValueError("SITRUS results must use SitrusGradeResult.")
        if self.name == "moodle_read" and not isinstance(self.result, MoodleReadResult):
            raise ValueError("Moodle results must use MoodleReadResult.")
        if self.name == "my_library_read" and not isinstance(
            self.result, MyLibraryReadResult
        ):
            raise ValueError("My Library results must use MyLibraryReadResult.")
        return self


class ChatAssistantMessage(StrictApiModel):
    message_id: StrictStr = Field(min_length=1, max_length=200)
    content_markdown: StrictStr = Field(min_length=1, max_length=12000)
    evidence: list[EvidenceLink] = Field(default_factory=list, max_length=100)


class ChatRunCompleted(StrictApiModel):
    status: Literal["completed"]
    message: ChatAssistantMessage
    proposal: ActionProposal | None = None


class ChatRunToolRequired(StrictApiModel):
    status: Literal["tool_required"]
    run_id: StrictStr = Field(min_length=1, max_length=200)
    calls: list[ChatToolCall] = Field(min_length=1, max_length=1)


ChatRunResponse = Annotated[
    ChatRunCompleted | ChatRunToolRequired,
    Field(discriminator="status"),
]


AgentRunResponse = Annotated[
    AgentRunCompleted | AgentRunToolRequired,
    Field(discriminator="status"),
]


__all__ = [
    "AgentRunCompleted",
    "AgentRunRequest",
    "AgentRunResponse",
    "AgentRunToolRequired",
    "AgentToolCall",
    "AgentToolResultRequest",
    "ChatAssistantMessage",
    "ChatClientTool",
    "ChatHistoryMessage",
    "ChatRunCompleted",
    "ChatRunRequest",
    "ChatRunResponse",
    "ChatRunToolRequired",
    "ChatToolCall",
    "ChatToolName",
    "ChatToolResultRequest",
    "BrowserReadLink",
    "BrowserReadResult",
    "SitrusGradeItem",
    "SitrusGradeResult",
    "MoodleReadResult",
    "CalendarAvailabilityInterval",
    "CalendarAvailabilityResult",
    "ClientTool",
    "ScombzPageSummaryResult",
    "ScombzReadAnnouncement",
    "ScombzReadResult",
    "ScombzReadScheduleItem",
    "ScombzReadTask",
    "SyllabusResult",
    "SyllabusSearchResult",
    "StrictApiModel",
]
