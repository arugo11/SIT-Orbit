"""Strict request and response models for resumable agent runs.

The regular domain models predate the resumable agent API and intentionally
remain backwards compatible.  Run envelopes are a narrower boundary: unknown
fields are rejected and the response union is discriminated by ``status``.
"""

import re
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

from .domain import ActionProposal, EvidenceLink, LibraryActionOptionsResult, OrbitEvent

ChatToolName = Literal[
    "scombz_page_summary",
    "scombz_read",
    "scombz_course_list",
    "scombz_portal_read",
    "scombz_course_read",
    "scombz_material_search",
    "google_calendar_availability",
    "syllabus_search",
    "syllabus_read",
    "browser_read_url",
    "sitrus_read",
    "moodle_read",
    "my_library_read",
    "cast_read",
    "cast_alumni_read",
    "cast_search",
    "library_catalog_search",
    "library_item_read",
    "library_catalog_browse",
    "library_discovery_search",
    "library_action_options",
]


class StrictApiModel(BaseModel):
    """Base class for API envelopes that must not accept extra fields."""

    model_config = ConfigDict(extra="forbid", strict=True)


class AgentCapabilities(StrictApiModel):
    """Authenticated runtime capabilities used before personal data leaves Chrome."""

    agent_backend: Literal["fixture", "openai", "azure_openai"]
    my_library_personal_context: StrictBool


class ChatCapabilities(StrictApiModel):
    """Authenticated capability advertisement for the Chat extension.

    The legacy ``/v1/capabilities`` response intentionally remains stable for
    older clients.  Chat clients use this richer projection to compute the
    intersection of locally available tools and the deployed server contract.
    """

    schema_version: Literal["v1"] = "v1"
    agent_backend: Literal["fixture", "openai", "azure_openai"]
    observability: Literal["off", "wandb"]
    scombz_student_read_mode: Literal["off", "fixture", "live"]
    supported_client_tools: list["ChatToolName"] = Field(max_length=32)
    max_client_tools: StrictInt = Field(ge=1, le=32)

    @model_validator(mode="after")
    def validates_tool_capability(self) -> "ChatCapabilities":
        if len(set(self.supported_client_tools)) != len(self.supported_client_tools):
            raise ValueError("Chat capability tool names must be unique.")
        if len(self.supported_client_tools) > self.max_client_tools:
            raise ValueError("Chat capability tools exceed the advertised maximum.")
        new_scombz = {
            "scombz_course_list",
            "scombz_portal_read",
            "scombz_course_read",
            "scombz_material_search",
        }
        if not (
            self.agent_backend == "azure_openai"
            and self.observability == "off"
            and self.scombz_student_read_mode == "live"
        ) and new_scombz.intersection(self.supported_client_tools):
            raise ValueError("Live SCombZ tools require Azure OpenAI with observability off.")
        return self


class AgentSessionRequest(StrictApiModel):
    """One-time Google authorization material used to create an Agent session."""

    authorization_code: StrictStr = Field(min_length=1, max_length=4096)
    code_verifier: StrictStr = Field(
        min_length=43,
        max_length=128,
        pattern=r"^[A-Za-z0-9._~-]+$",
    )


class AgentSessionResponse(StrictApiModel):
    """An opaque, short-lived bearer token for Agent API requests."""

    access_token: StrictStr = Field(min_length=1, max_length=512)
    expires_at: datetime


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


class ScombzCoverage(StrictApiModel):
    """Bounded coverage report for cross-course SCombZ reads."""

    scope: StrictStr = Field(min_length=1, max_length=80)
    requested: StrictInt = Field(ge=0, le=1000)
    attempted: StrictInt = Field(ge=0, le=1000)
    succeeded: StrictInt = Field(ge=0, le=1000)
    failed: StrictInt = Field(ge=0, le=1000)
    truncated: StrictBool = False
    next_cursor: StrictStr | None = Field(default=None, max_length=240)

    @model_validator(mode="after")
    def counts_are_consistent(self) -> "ScombzCoverage":
        if self.attempted < self.succeeded + self.failed:
            raise ValueError("SCombZ coverage counts are inconsistent.")
        if not self.truncated and self.next_cursor is not None:
            raise ValueError("A complete SCombZ coverage cannot have a cursor.")
        return self


ScombzSectionState = Literal["complete", "truncated", "failed", "not_requested"]


class ScombzCourseSummary(StrictApiModel):
    course_ref: StrictStr = Field(
        min_length=1, max_length=160, pattern=r"^orbit-scombz://course/[A-Za-z0-9_-]{16,128}$"
    )
    display_name: StrictStr = Field(min_length=1, max_length=300)
    academic_year: StrictInt | None = Field(default=None, ge=2000, le=2100)
    term: StrictStr | None = Field(default=None, max_length=40)
    weekday: StrictStr | None = Field(default=None, max_length=20)
    period: StrictStr | None = Field(default=None, max_length=20)
    citation_uri: StrictStr | None = Field(default=None, max_length=240)


class ScombzCourseListResult(StrictApiModel):
    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "partial", "reauth_required", "unavailable"]
    courses: list[ScombzCourseSummary] = Field(default_factory=list, max_length=50)
    coverage: ScombzCoverage
    observed_at: StrictStr = Field(min_length=1, max_length=40)
    reason_code: StrictStr | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def unavailable_has_no_courses(self) -> "ScombzCourseListResult":
        if self.status in {"reauth_required", "unavailable"} and self.courses:
            raise ValueError("Unavailable SCombZ course lists cannot include courses.")
        return self


class ScombzPortalItem(StrictApiModel):
    ref: StrictStr = Field(
        min_length=1, max_length=160, pattern=r"^orbit-scombz://item/[A-Za-z0-9_-]{16,128}$"
    )
    section: StrictStr = Field(min_length=1, max_length=60)
    title: StrictStr = Field(min_length=1, max_length=300)
    detail: StrictStr | None = Field(default=None, max_length=3000)
    observed_at: StrictStr = Field(min_length=1, max_length=40)
    citation_uri: StrictStr | None = Field(default=None, max_length=240)


class ScombzPortalReadResult(StrictApiModel):
    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "partial", "reauth_required", "unavailable"]
    items: list[ScombzPortalItem] = Field(default_factory=list, max_length=200)
    coverage: ScombzCoverage
    observed_at: StrictStr = Field(min_length=1, max_length=40)
    reason_code: StrictStr | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def unavailable_has_no_items(self) -> "ScombzPortalReadResult":
        if self.status in {"reauth_required", "unavailable"} and self.items:
            raise ValueError("Unavailable SCombZ portal reads cannot include items.")
        return self


class ScombzCourseReadItem(StrictApiModel):
    ref: StrictStr = Field(
        min_length=1, max_length=160, pattern=r"^orbit-scombz://item/[A-Za-z0-9_-]{16,128}$"
    )
    course_ref: StrictStr = Field(
        min_length=1, max_length=160, pattern=r"^orbit-scombz://course/[A-Za-z0-9_-]{16,128}$"
    )
    section: StrictStr = Field(min_length=1, max_length=60)
    title: StrictStr = Field(min_length=1, max_length=300)
    body: StrictStr | None = Field(default=None, max_length=6000)
    due_at: StrictStr | None = Field(default=None, max_length=60)
    state: StrictStr | None = Field(default=None, max_length=40)
    has_pdf: StrictBool = False
    observed_at: StrictStr = Field(min_length=1, max_length=40)
    citation_uri: StrictStr | None = Field(default=None, max_length=240)


class ScombzCourseReadResult(StrictApiModel):
    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "partial", "reauth_required", "unavailable"]
    items: list[ScombzCourseReadItem] = Field(default_factory=list, max_length=250)
    section_states: dict[StrictStr, ScombzSectionState] = Field(default_factory=dict, max_length=20)
    coverage: ScombzCoverage
    observed_at: StrictStr = Field(min_length=1, max_length=40)
    reason_code: StrictStr | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def unavailable_has_no_items(self) -> "ScombzCourseReadResult":
        if self.status in {"reauth_required", "unavailable"} and (
            self.items or self.section_states
        ):
            raise ValueError("Unavailable SCombZ course reads cannot include items.")
        return self


class ScombzMaterialSearchHit(StrictApiModel):
    material_ref: StrictStr = Field(
        min_length=1, max_length=160, pattern=r"^orbit-scombz://material/[A-Za-z0-9_-]{16,128}$"
    )
    course_ref: StrictStr = Field(
        min_length=1, max_length=160, pattern=r"^orbit-scombz://course/[A-Za-z0-9_-]{16,128}$"
    )
    material_title: StrictStr = Field(min_length=1, max_length=300)
    page: StrictInt = Field(ge=1, le=10000)
    quote: StrictStr = Field(min_length=1, max_length=1800)
    observed_at: StrictStr = Field(min_length=1, max_length=40)
    citation_uri: StrictStr | None = Field(default=None, max_length=240)


class ScombzMaterialSearchResult(StrictApiModel):
    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "partial", "reauth_required", "unavailable"]
    hits: list[ScombzMaterialSearchHit] = Field(default_factory=list, max_length=24)
    coverage: ScombzCoverage
    observed_at: StrictStr = Field(min_length=1, max_length=40)
    reason_code: StrictStr | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def unavailable_has_no_hits(self) -> "ScombzMaterialSearchResult":
        if self.status in {"reauth_required", "unavailable"} and self.hits:
            raise ValueError("Unavailable SCombZ material reads cannot include hits.")
        return self


class SyllabusReadResult(StrictApiModel):
    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "unavailable"]
    syllabus_ref: StrictStr = Field(
        min_length=1, max_length=160, pattern=r"^orbit-syllabus://result/[A-Za-z0-9_-]{16,128}$"
    )
    url: StrictStr = Field(min_length=1, max_length=500)
    course_code: StrictStr | None = Field(default=None, max_length=100)
    title: StrictStr | None = Field(default=None, max_length=300)
    instructors: list[StrictStr] = Field(default_factory=list, max_length=20)
    objectives: StrictStr | None = Field(default=None, max_length=6000)
    weekly_plan: list[StrictStr] = Field(default_factory=list, max_length=60)
    evaluation: StrictStr | None = Field(default=None, max_length=3000)
    textbooks: list[StrictStr] = Field(default_factory=list, max_length=30)
    prerequisites: StrictStr | None = Field(default=None, max_length=2000)
    observed_at: StrictStr = Field(min_length=1, max_length=40)
    reason_code: StrictStr | None = Field(default=None, max_length=100)
    citation_uri: StrictStr | None = Field(default=None, max_length=240)

    @model_validator(mode="after")
    def unavailable_has_no_detail(self) -> "SyllabusReadResult":
        if self.status == "unavailable" and (
            self.course_code is not None
            or self.title is not None
            or self.instructors
            or self.objectives is not None
            or self.weekly_plan
            or self.evaluation is not None
            or self.textbooks
            or self.prerequisites is not None
        ):
            raise ValueError("Unavailable syllabus reads cannot include detail.")
        return self


class SyllabusResult(StrictApiModel):
    """One result from the official public syllabus search."""

    syllabus_ref: StrictStr = Field(
        min_length=1,
        max_length=160,
        pattern=r"^orbit-syllabus://result/[A-Za-z0-9_-]{16,128}$",
    )
    title: StrictStr = Field(min_length=1, max_length=300)
    course_code: StrictStr | None = Field(default=None, max_length=100)
    faculty: StrictStr | None = Field(default=None, max_length=200)
    url: StrictStr = Field(min_length=1, max_length=500)
    snippet: StrictStr | None = Field(default=None, max_length=1000)
    citation_uri: StrictStr | None = Field(default=None, max_length=240)

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
    observed_at: StrictStr = Field(min_length=1, max_length=40)
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


LibrarySearchCampus = Literal["toyosu", "omiya", "any"]
LibrarySearchFormat = Literal["book", "journal", "ebook", "any"]
LibraryRecordFormat = Literal["book", "journal", "ebook", "unknown"]
LibraryHoldingCampus = Literal["toyosu", "omiya", "unknown"]
LibraryHoldingStatus = Literal["available", "unavailable", "unknown"]


class LibraryHoldingSummary(StrictApiModel):
    """Public holding status rendered by the official OPAC.

    Internal material, copy, and holding identifiers deliberately have no
    representation in this model.
    """

    campus: LibraryHoldingCampus
    location: StrictStr | None = Field(default=None, max_length=200)
    call_number: StrictStr | None = Field(default=None, max_length=100)
    status: LibraryHoldingStatus
    due_date: StrictStr | None = Field(default=None, max_length=10)
    reservation_count: StrictInt | None = Field(default=None, ge=0, le=10000)

    @model_validator(mode="after")
    def values_match_status(self) -> "LibraryHoldingSummary":
        if self.due_date is not None:
            try:
                datetime.strptime(self.due_date, "%Y-%m-%d")
            except ValueError as error:
                raise ValueError("Library holding due dates must use YYYY-MM-DD.") from error
        if self.status == "unknown" and (
            self.due_date is not None or self.reservation_count is not None
        ):
            raise ValueError("Unknown library holdings cannot include derived counts or dates.")
        return self


class LibraryRelatedRecordRef(StrictApiModel):
    """A public related-record reference without material identifiers."""

    resource_ref: StrictStr = Field(
        min_length=1,
        max_length=160,
        pattern=r"^orbit-library://record/[A-Za-z0-9_-]{16,128}$",
    )
    title: StrictStr = Field(min_length=1, max_length=300)
    relation: Literal["related", "edition", "translation", "other"] = "related"


class LibraryBibliographicRecord(StrictApiModel):
    """Public bibliographic metadata and rendered holdings from the OPAC."""

    resource_ref: StrictStr = Field(
        min_length=1,
        max_length=160,
        pattern=r"^orbit-library://record/[A-Za-z0-9_-]{16,128}$",
    )
    title: StrictStr = Field(min_length=1, max_length=300)
    authors: list[StrictStr] = Field(default_factory=list, max_length=20)
    subjects: list[StrictStr] = Field(default_factory=list, max_length=20)
    isbn: StrictStr | None = Field(default=None, max_length=32)
    publisher: StrictStr | None = Field(default=None, max_length=300)
    publication_year: StrictInt | None = Field(default=None, ge=1000, le=2100)
    format: LibraryRecordFormat = "unknown"
    campus: LibrarySearchCampus = "any"
    url: StrictStr = Field(min_length=1, max_length=500)
    holdings: list[LibraryHoldingSummary] = Field(
        default_factory=list,
        min_length=1,
        max_length=20,
    )
    related_records: list[LibraryRelatedRecordRef] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def official_record_url(self) -> "LibraryBibliographicRecord":
        parsed = urlparse(self.url)
        if (
            parsed.scheme != "https"
            or parsed.netloc != "library.shibaura-it.ac.jp"
            or not parsed.path.startswith("/opc/recordID/catalog.bib/")
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("Library records must link to an official OPAC record.")
        return self


# A shorter name is useful at API call sites while retaining one canonical
# schema definition for OpenAPI and the client guards.
LibraryCatalogItem = LibraryBibliographicRecord


class LibraryCatalogSearchResult(StrictApiModel):
    """Bounded public results from the official OPAC search form."""

    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "unavailable"]
    query: StrictStr = Field(min_length=1, max_length=200)
    items: list[LibraryCatalogItem] = Field(default_factory=list, max_length=10)
    reason_code: StrictStr | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def unavailable_has_no_items(self) -> "LibraryCatalogSearchResult":
        if self.status == "unavailable" and self.items:
            raise ValueError("Unavailable library searches cannot include items.")
        return self


class LibraryCatalogSearchRequest(StrictApiModel):
    """Authenticated server-side OPAC search request."""

    query: StrictStr = Field(min_length=1, max_length=200)
    author: StrictStr | None = Field(default=None, max_length=200)
    subject: StrictStr | None = Field(default=None, max_length=200)
    isbn: StrictStr | None = Field(default=None, max_length=32)
    pub_year: StrictInt | None = Field(default=None, ge=1000, le=2100)
    campus: LibrarySearchCampus = "any"
    format: LibrarySearchFormat = "any"
    limit: StrictInt = Field(default=10, ge=1, le=10)


class LibraryItemReadResult(StrictApiModel):
    """Detailed public OPAC record resolved from an opaque resource reference."""

    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "unavailable"]
    resource_ref: StrictStr = Field(
        min_length=1,
        max_length=160,
        pattern=r"^orbit-library://record/[A-Za-z0-9_-]{16,128}$",
    )
    item: LibraryCatalogItem | None = None
    reason_code: StrictStr | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def item_matches_status(self) -> "LibraryItemReadResult":
        if self.status == "known" and self.item is None:
            raise ValueError("Known library item reads require an item.")
        if self.status == "unavailable" and self.item is not None:
            raise ValueError("Unavailable library item reads cannot include an item.")
        if self.item is not None and self.item.resource_ref != self.resource_ref:
            raise ValueError("Library item resource references must match.")
        return self


class LibraryCatalogBrowseResult(StrictApiModel):
    """Public new-book or loan-ranking rows from the official catalog pages."""

    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "unavailable"]
    kind: Literal["new_books", "loan_ranking"]
    campus: LibrarySearchCampus = "any"
    items: list[LibraryCatalogItem] = Field(default_factory=list, max_length=10)
    reason_code: StrictStr | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def unavailable_has_no_items(self) -> "LibraryCatalogBrowseResult":
        if self.status == "unavailable" and self.items:
            raise ValueError("Unavailable library browse results cannot include items.")
        return self


class LibraryDiscoveryItem(StrictApiModel):
    """Displayed public metadata/link from the official SIT Search page.

    This schema intentionally has no full-text, download, or persistence field.
    """

    title: StrictStr = Field(min_length=1, max_length=300)
    authors: list[StrictStr] = Field(default_factory=list, max_length=20)
    source_label: StrictStr | None = Field(default=None, max_length=200)
    url: StrictStr = Field(min_length=1, max_length=500)
    snippet: StrictStr | None = Field(default=None, max_length=500)
    resource_ref: StrictStr | None = Field(
        default=None,
        max_length=160,
        pattern=r"^orbit-library://record/[A-Za-z0-9_-]{16,128}$",
    )

    @model_validator(mode="after")
    def official_discovery_url(self) -> "LibraryDiscoveryItem":
        parsed = urlparse(self.url)
        if parsed.scheme != "https" or parsed.username or parsed.password:
            raise ValueError("Library discovery links must be HTTPS without credentials.")
        official_path = (
            parsed.netloc == "slib.shibaura-it.ac.jp"
            and parsed.path.startswith("/sublib/")
            and not parsed.query
            and not parsed.fragment
        ) or (
            parsed.netloc == "library.shibaura-it.ac.jp"
            and parsed.path.startswith("/opc/recordID/catalog.bib/")
            and not parsed.query
            and not parsed.fragment
        )
        if not official_path:
            raise ValueError("Library discovery links must use an official SIT origin.")
        return self


class LibraryDiscoverySearchResult(StrictApiModel):
    """Bounded metadata-only results from official SIT Search."""

    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "unavailable"]
    query: StrictStr = Field(min_length=1, max_length=200)
    items: list[LibraryDiscoveryItem] = Field(default_factory=list, max_length=10)
    reason_code: StrictStr | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def unavailable_has_no_items(self) -> "LibraryDiscoverySearchResult":
        if self.status == "unavailable" and self.items:
            raise ValueError("Unavailable library discovery results cannot include items.")
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
                due_at = datetime.fromisoformat(self.earliest_due_at.replace("Z", "+00:00"))
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


MyLibraryScope = Literal[
    "current_loans",
    "reservations",
    "loan_history",
    "purchase_requests",
    "interlibrary_requests",
]


class MyLibraryItem(StrictApiModel):
    """One bounded personal-library row safe to share after session consent.

    The connector maps provider-specific identifiers to an opaque reference
    before this model is constructed.  Material/request IDs, call numbers,
    form values, and account identity intentionally have no fields here.
    """

    resource_ref: StrictStr = Field(
        min_length=1,
        max_length=160,
        pattern=r"^orbit-library://record/[A-Za-z0-9_-]{16,128}$",
    )
    title: StrictStr = Field(min_length=1, max_length=300)
    author: StrictStr | None = Field(default=None, max_length=300)
    status: StrictStr | None = Field(default=None, max_length=100)
    due_date: StrictStr | None = Field(default=None, max_length=10)
    renewable: StrictBool | None = None
    activity_date: StrictStr | None = Field(default=None, max_length=10)
    request_type: StrictStr | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def dates_are_iso(self) -> "MyLibraryItem":
        if not self.title.strip():
            raise ValueError("My Library titles must not be blank.")
        for field_name, value in (
            ("due_date", self.due_date),
            ("activity_date", self.activity_date),
        ):
            try:
                _validate_my_library_date(value)
            except ValueError as error:
                raise ValueError(f"My Library {field_name} values must use YYYY-MM-DD.") from error
        return self


def _validate_my_library_date(value: str | None) -> None:
    if value is None:
        return
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("My Library dates must use YYYY-MM-DD.")
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError as error:
        raise ValueError("My Library dates must use YYYY-MM-DD.") from error


def _validate_my_library_scope_items(scope: MyLibraryScope, items: list[MyLibraryItem]) -> None:
    required_fields: dict[MyLibraryScope, tuple[str, ...]] = {
        "current_loans": ("due_date",),
        "reservations": ("due_date", "status"),
        "loan_history": ("activity_date", "status"),
        "purchase_requests": ("activity_date", "status", "request_type"),
        "interlibrary_requests": ("activity_date", "status", "request_type"),
    }
    for item in items:
        for field in required_fields[scope]:
            value = getattr(item, field)
            if value is None or (
                field in {"status", "request_type"} and isinstance(value, str) and not value.strip()
            ):
                raise ValueError(f"My Library {scope} items have incomplete fields.")


class LegacyMyLibraryReadResult(StrictApiModel):
    """The original aggregate-only My Library result shape."""

    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "reauth_required", "unavailable"]
    loan_count: StrictInt = Field(ge=0, le=1000)
    reservation_count: StrictInt = Field(ge=0, le=1000)
    overdue_count: StrictInt = Field(ge=0, le=1000)
    renewable_count: StrictInt = Field(ge=0, le=1000)
    earliest_due_date: StrictStr | None = Field(max_length=10)
    reason_code: StrictStr | None = Field(max_length=100)

    @model_validator(mode="after")
    def values_match_status(self) -> "LegacyMyLibraryReadResult":
        _validate_my_library_date(self.earliest_due_date)
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


class ScopedMyLibraryReadResult(StrictApiModel):
    """A complete, bounded page for exactly one My Library scope."""

    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "reauth_required", "unavailable"]
    scope: MyLibraryScope
    items: list[MyLibraryItem] = Field(max_length=20)
    total_count: StrictInt = Field(ge=0, le=1000)
    next_offset: StrictInt | None = Field(ge=0, le=1000)
    loan_count: StrictInt | None = Field(ge=0, le=1000)
    reservation_count: StrictInt | None = Field(ge=0, le=1000)
    overdue_count: StrictInt | None = Field(ge=0, le=1000)
    renewable_count: StrictInt | None = Field(ge=0, le=1000)
    earliest_due_date: StrictStr | None = Field(max_length=10)
    reason_code: StrictStr | None = Field(max_length=100)

    @model_validator(mode="after")
    def values_match_status(self) -> "ScopedMyLibraryReadResult":
        _validate_my_library_date(self.earliest_due_date)
        if self.status == "known":
            _validate_my_library_scope_items(self.scope, self.items)
        if self.scope == "current_loans":
            if self.reservation_count is not None:
                raise ValueError("Unread reservation count must be null.")
            if self.status == "known" and any(
                value is None
                for value in (
                    self.loan_count,
                    self.overdue_count,
                    self.renewable_count,
                )
            ):
                raise ValueError("Known loan results require loan aggregates.")
            if self.status == "known" and self.loan_count != self.total_count:
                raise ValueError("My Library loan_count must equal the scope total_count.")
        elif self.scope == "reservations":
            if any(
                value is not None
                for value in (
                    self.loan_count,
                    self.overdue_count,
                    self.renewable_count,
                    self.earliest_due_date,
                )
            ):
                raise ValueError("Unread loan aggregates must be null.")
            if self.status == "known" and self.reservation_count is None:
                raise ValueError("Known reservation results require reservation_count.")
            if self.status == "known" and self.reservation_count != self.total_count:
                raise ValueError("My Library reservation_count must equal the scope total_count.")
        elif any(
            value is not None
            for value in (
                self.loan_count,
                self.reservation_count,
                self.overdue_count,
                self.renewable_count,
                self.earliest_due_date,
            )
        ):
            raise ValueError("Aggregates outside the requested scope must be null.")
        if self.status != "known" and (
            self.items
            or self.total_count
            or self.next_offset is not None
            or self.loan_count is not None
            or self.reservation_count is not None
            or self.overdue_count is not None
            or self.renewable_count is not None
            or self.earliest_due_date is not None
        ):
            raise ValueError("Unavailable My Library results cannot include derived data.")
        if self.total_count < len(self.items):
            raise ValueError("My Library total_count cannot be below the item count.")
        if self.total_count <= len(self.items) and self.next_offset is not None:
            raise ValueError("My Library next_offset must be null on the final page.")
        if (
            self.overdue_count is not None
            and self.loan_count is not None
            and self.overdue_count > self.loan_count
        ):
            raise ValueError("My Library overdue count cannot exceed loan count.")
        if (
            self.renewable_count is not None
            and self.loan_count is not None
            and self.renewable_count > self.loan_count
        ):
            raise ValueError("My Library renewable count cannot exceed loan count.")
        return self


MyLibraryReadResult = LegacyMyLibraryReadResult | ScopedMyLibraryReadResult


class CastReadResult(StrictApiModel):
    """Derived CAST dashboard counts safe for an explicitly confirmed run.

    Notice text, career preferences, application history, user identity, and
    submitted documents deliberately have no representation in this model.
    """

    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "reauth_required", "unavailable"]
    notice_count: StrictInt = Field(ge=0, le=1000)
    new_job_count: StrictInt = Field(ge=0, le=100_000)
    new_internship_count: StrictInt = Field(ge=0, le=100_000)
    new_event_count: StrictInt = Field(ge=0, le=100_000)
    has_counseling_reservation: StrictBool
    nearest_notice_date: StrictStr | None = Field(default=None, max_length=10)
    reason_code: StrictStr | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def values_match_status(self) -> "CastReadResult":
        if self.nearest_notice_date is not None:
            try:
                datetime.strptime(self.nearest_notice_date, "%Y-%m-%d")
            except ValueError as error:
                raise ValueError("CAST notice dates must use YYYY-MM-DD.") from error
        if self.status != "known" and (
            self.notice_count
            or self.new_job_count
            or self.new_internship_count
            or self.new_event_count
            or self.has_counseling_reservation
            or self.nearest_notice_date is not None
        ):
            raise ValueError("Unavailable CAST results cannot include derived data.")
        return self


class CastAlumniProfile(StrictApiModel):
    """Bounded pseudonymous CAST profile for the restricted career scope.

    The alias is generated in the extension and is the only person-like
    identifier accepted by the external Agent.  Names, contact values,
    source IDs, free text, and URLs have no fields in this projection.
    """

    alias: StrictStr = Field(
        min_length=1,
        max_length=120,
        pattern=r"^\[\[ORBIT_PERSON_[A-Za-z0-9_-]{16,64}\]\]$",
    )
    role: Literal["alumni", "supporter", "unknown"]
    company: StrictStr | None = Field(default=None, max_length=160)
    technical_domains: list[StrictStr] = Field(default_factory=list, max_length=12)
    job_types: list[StrictStr] = Field(default_factory=list, max_length=12)
    location_area: StrictStr | None = Field(default=None, max_length=80)
    graduation_year_bucket: StrictStr | None = Field(
        default=None,
        max_length=24,
        pattern=r"^(?:before-2010|20[0-9]{2}-20[0-9]{2})$",
    )
    evidence_id: StrictStr | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def contains_no_direct_identifiers(self) -> "CastAlumniProfile":
        values = [
            self.company,
            *self.technical_domains,
            *self.job_types,
            self.location_area,
            self.evidence_id,
        ]
        joined = "\n".join(value for value in values if value)
        if re.search(
            r"(?:@|https?://|orbit-[a-z0-9-]+://|(?:\+81|0)[-\d() ]{8,}|"
            r"\b[A-Z]{1,5}[-_ ]?\d{5,}\b)",
            joined,
            re.IGNORECASE,
        ):
            raise ValueError("Restricted CAST profiles must not contain direct identifiers.")
        if self.evidence_id is not None and not re.fullmatch(
            r"[A-Za-z0-9_-]{3,200}", self.evidence_id
        ):
            raise ValueError("Restricted CAST profile evidence IDs must be opaque.")
        if len(set(self.technical_domains)) != len(self.technical_domains):
            raise ValueError("Restricted CAST profile domains must be unique.")
        if len(set(self.job_types)) != len(self.job_types):
            raise ValueError("Restricted CAST profile job types must be unique.")
        return self


class CastAlumniReadResult(StrictApiModel):
    """Generalized CAST supporter data with no person or contact fields.

    The extension keeps the authenticated page and local detail card.  Only
    these bounded categories cross the Chat API; names, contact values, CAST
    identifiers, URLs, and free text have no representation here.
    """

    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "reauth_required", "unavailable"]
    data_classification: Literal["personal", "restricted"] = "personal"
    profile_count: StrictInt = Field(ge=0, le=64)
    profiles: list[CastAlumniProfile] = Field(default_factory=list, max_length=20)
    topic_categories: list[StrictStr] = Field(default_factory=list, max_length=32)
    availability_frequencies: list[Literal["weekly", "monthly", "occasional", "unknown"]] = Field(
        default_factory=list, max_length=4
    )
    meeting_modes: list[Literal["online", "in_person", "unknown"]] = Field(
        default_factory=list, max_length=3
    )
    shareable_insight_categories: list[StrictStr] = Field(default_factory=list, max_length=32)
    contact_present: StrictBool = False
    discovered_link_count: StrictInt = Field(ge=0, le=32)
    reason_code: StrictStr | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def values_match_status(self) -> "CastAlumniReadResult":
        if self.status != "known" and (
            self.profile_count
            or self.topic_categories
            or self.availability_frequencies
            or self.meeting_modes
            or self.shareable_insight_categories
            or self.contact_present
            or self.discovered_link_count
            or self.profiles
        ):
            raise ValueError("Unavailable CAST alumni results cannot include derived data.")
        if self.data_classification == "personal" and self.profiles:
            raise ValueError("Personal CAST alumni results cannot carry provider profiles.")
        if self.data_classification == "restricted":
            if self.contact_present:
                raise ValueError("Restricted CAST alumni results cannot expose contact presence.")
            if self.profile_count != len(self.profiles):
                raise ValueError("Restricted CAST profile count must match profiles.")
        if len(set(self.topic_categories)) != len(self.topic_categories):
            raise ValueError("CAST alumni topic categories must be unique.")
        if len(set(self.shareable_insight_categories)) != len(self.shareable_insight_categories):
            raise ValueError("CAST alumni insight categories must be unique.")
        return self


class CastSearchSort(StrictApiModel):
    key: Literal["company_name", "hiring_count", "graduation_year", "deadline"]
    direction: Literal["asc", "desc"]


class CastSearchAppliedFilters(StrictApiModel):
    kind: Literal["job", "internship", "company_session", "company", "hiring_record"]
    filters: dict[StrictStr, Any] = Field(default_factory=dict, max_length=24)
    sort: CastSearchSort | None = None
    graduation_years_defaulted: StrictBool = False

    @model_validator(mode="after")
    def semantic_filter_keys_are_allowlisted(self) -> "CastSearchAppliedFilters":
        allowed = {
            "company_name",
            "new_only",
            "year",
            "graduation_years",
            "academic_programs",
            "industries",
            "relation",
            "occupations",
            "locations",
            "deadline_before",
            "include_closed",
            "application_method",
            "target_grades",
            "duration",
            "event_start",
            "event_end",
            "advisor",
            "faculty",
        }
        string_keys = {
            "company_name",
            "deadline_before",
            "event_start",
            "event_end",
            "relation",
            "application_method",
            "advisor",
            "faculty",
        }
        boolean_keys = {"new_only", "include_closed"}
        list_string_keys = {
            "academic_programs",
            "industries",
            "occupations",
            "locations",
            "target_grades",
            "duration",
        }
        relation_values = {
            "hiring_record",
            "obog",
            "career_supporter",
            "company_session",
            "internship",
            "entrance_exam",
        }
        if set(self.filters) - allowed:
            raise ValueError("CAST search filters contain an unsupported key.")
        for key, value in self.filters.items():
            if key in boolean_keys:
                if not isinstance(value, bool):
                    raise ValueError(f"CAST search filter {key} contains invalid values.")
                continue
            if key == "year":
                if (
                    isinstance(value, bool)
                    or not isinstance(value, int)
                    or not 1995 <= value <= 2100
                ):
                    raise ValueError(f"CAST search filter {key} contains invalid values.")
                continue
            if key == "graduation_years":
                if not isinstance(value, list):
                    raise ValueError(f"CAST search filter {key} contains invalid values.")
                if (
                    not value
                    or len(value) > 20
                    or not all(
                        isinstance(item, int)
                        and not isinstance(item, bool)
                        and 1995 <= item <= 2100
                        for item in value
                    )
                ):
                    raise ValueError(f"CAST search filter {key} contains invalid values.")
                continue
            if key in string_keys and isinstance(value, str):
                if not value.strip() or len(value) > 200:
                    raise ValueError(f"CAST search filter {key} is invalid.")
                if key == "relation" and value not in relation_values:
                    raise ValueError(f"CAST search filter {key} is invalid.")
                if key == "application_method" and value not in {"free", "recommendation"}:
                    raise ValueError(f"CAST search filter {key} is invalid.")
                continue
            if key in list_string_keys and isinstance(value, list):
                if not value or len(value) > 20:
                    raise ValueError(f"CAST search filter {key} contains invalid values.")
                valid = all(
                    isinstance(item, str) and item.strip() and len(item) <= 200 for item in value
                )
                if not valid:
                    raise ValueError(f"CAST search filter {key} contains invalid values.")
                continue
            raise ValueError(f"CAST search filter {key} contains invalid values.")
        return self


class CastSearchCoverage(StrictApiModel):
    mode: Literal["page", "complete", "partial"]
    page_size: StrictInt = Field(ge=1, le=50)
    fetched_pages: StrictInt = Field(ge=0, le=100)
    total_pages: StrictInt | None = Field(default=None, ge=0, le=100)


class CastSearchAggregate(StrictApiModel):
    dimension: Literal["industry", "location", "graduation_year"]
    value: StrictStr = Field(min_length=1, max_length=200)
    count: StrictInt = Field(ge=5, le=100_000)


class CastSearchResult(StrictApiModel):
    """Aggregate-only projection returned by the authenticated CAST search tool.

    Company/person detail remains in the extension's local result card.  This
    schema intentionally has no company code, person identifier, HTML, or
    source URL field.
    """

    schema_version: Literal["v1"] = "v1"
    status: Literal[
        "known",
        "reauth_required",
        "form_changed",
        "rate_limited",
        "unavailable",
    ]
    applied_filters: CastSearchAppliedFilters | None = None
    total_count: StrictInt = Field(ge=0, le=100_000)
    returned_count: StrictInt = Field(ge=0, le=1_000)
    coverage: CastSearchCoverage | None = None
    anonymous_aggregates: list[CastSearchAggregate] = Field(default_factory=list, max_length=100)
    evidence_ids: list[StrictStr] = Field(default_factory=list, max_length=32)
    reason_code: StrictStr | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def values_match_status(self) -> "CastSearchResult":
        if len(set(self.evidence_ids)) != len(self.evidence_ids):
            raise ValueError("CAST search evidence IDs must be unique.")
        if any(
            not re.fullmatch(r"cast-search-v1-[A-Za-z0-9_-]{16,200}", evidence_id)
            for evidence_id in self.evidence_ids
        ):
            raise ValueError("CAST search evidence IDs must be opaque v1 IDs.")
        aggregate_keys = [(item.dimension, item.value) for item in self.anonymous_aggregates]
        if len(set(aggregate_keys)) != len(aggregate_keys):
            raise ValueError("CAST search aggregates must be unique.")
        if self.returned_count > self.total_count:
            raise ValueError("CAST search returned_count cannot exceed total_count.")
        if self.status == "known":
            if self.applied_filters is None or self.coverage is None:
                raise ValueError("Known CAST search results require filters and coverage.")
        elif (
            self.applied_filters is not None
            or self.total_count
            or self.returned_count
            or self.coverage is not None
            or self.anonymous_aggregates
            or self.evidence_ids
        ):
            raise ValueError("Unavailable CAST search results cannot include derived data.")
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


class ChatHistoryMessage(StrictApiModel):
    role: ChatRole
    content: StrictStr = Field(min_length=1, max_length=12000)


class ChatLibraryContextRecord(StrictApiModel):
    """A bounded public OPAC record carried between Chat turns.

    This is deliberately separate from the transcript.  It contains only
    the structured, public projection that the next model turn may use to
    resolve elliptical follow-ups such as ``"どこにある？"``.
    """

    resource_ref: StrictStr = Field(
        min_length=1,
        max_length=160,
        pattern=r"^orbit-library://record/[A-Za-z0-9_-]{16,128}$",
    )
    record: LibraryBibliographicRecord
    evidence_ids: list[StrictStr] = Field(default_factory=list, max_length=10)
    observed_at: StrictStr = Field(min_length=1, max_length=40)

    @model_validator(mode="after")
    def validates_public_context(self) -> "ChatLibraryContextRecord":
        try:
            observed = datetime.fromisoformat(self.observed_at.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError("Library context timestamps must use RFC3339.") from error
        if observed.tzinfo is None:
            raise ValueError("Library context timestamps must include a timezone.")
        if len(set(self.evidence_ids)) != len(self.evidence_ids):
            raise ValueError("Library context evidence IDs must be unique.")
        if self.resource_ref != self.record.resource_ref:
            raise ValueError("Library context resource_ref must match its record.")
        raw = self.model_dump_json().lower()
        for marker in ("<script", "<input", "cookie=", "access_token", "oauth_token"):
            if marker in raw:
                raise ValueError("Library context contains a prohibited raw marker.")
        return self


RelatedBookAxisSource = Literal["explicit", "metadata", "inferred"]
RelatedBookVerificationStatus = Literal["unverified", "verified", "recheck_failed"]


class RelatedBookRelationAxis(StrictApiModel):
    """One bounded explanation axis used to diversify book discovery."""

    label: StrictStr = Field(min_length=1, max_length=100)
    source: RelatedBookAxisSource


class RelatedBookCatalogVerification(StrictApiModel):
    """Latest SIT OPAC verification state for one public candidate."""

    status: RelatedBookVerificationStatus = "unverified"
    resource_ref: StrictStr | None = Field(
        default=None,
        max_length=160,
        pattern=r"^orbit-library://record/[A-Za-z0-9_-]{16,128}$",
    )
    observed_at: StrictStr | None = Field(default=None, max_length=40)

    @model_validator(mode="after")
    def validates_verification(self) -> "RelatedBookCatalogVerification":
        if self.status == "verified" and self.resource_ref is None:
            raise ValueError("Verified related books require an opaque resource_ref.")
        if self.status != "verified" and self.resource_ref is not None:
            raise ValueError("Only verified related books may include a resource_ref.")
        if self.status != "unverified" and self.observed_at is None:
            raise ValueError("Verified or failed rechecks require an observation time.")
        if self.observed_at is not None:
            try:
                observed = datetime.fromisoformat(self.observed_at.replace("Z", "+00:00"))
            except ValueError as error:
                raise ValueError("Related-book timestamps must use RFC3339.") from error
            if observed.tzinfo is None:
                raise ValueError("Related-book timestamps must include a timezone.")
        return self


class RelatedBookCandidate(StrictApiModel):
    """Public, evidence-grounded candidate produced by bounded discovery."""

    candidate_ref: StrictStr = Field(
        min_length=1,
        max_length=160,
        pattern=r"^orbit-book://candidate/[A-Za-z0-9_-]{16,128}$",
    )
    title: StrictStr = Field(min_length=1, max_length=300)
    authors: list[StrictStr] = Field(default_factory=list, max_length=20)
    isbn: StrictStr | None = Field(default=None, max_length=32)
    publication_year: StrictInt | None = Field(default=None, ge=1000, le=2100)
    relation_axes: list[RelatedBookRelationAxis] = Field(
        default_factory=list,
        min_length=1,
        max_length=5,
    )
    why_related: StrictStr = Field(min_length=1, max_length=500)
    evidence_ids: list[StrictStr] = Field(min_length=1, max_length=10)
    catalog_verification: RelatedBookCatalogVerification = Field(
        default_factory=RelatedBookCatalogVerification
    )
    observed_at: StrictStr = Field(min_length=1, max_length=40)

    @model_validator(mode="after")
    def validates_public_candidate(self) -> "RelatedBookCandidate":
        if len(set(self.evidence_ids)) != len(self.evidence_ids):
            raise ValueError("Related-book evidence IDs must be unique.")
        try:
            observed = datetime.fromisoformat(self.observed_at.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError("Related-book timestamps must use RFC3339.") from error
        if observed.tzinfo is None:
            raise ValueError("Related-book timestamps must include a timezone.")
        public_text = "\n".join(
            [
                self.title,
                *self.authors,
                self.isbn or "",
                self.why_related,
                *(axis.label for axis in self.relation_axes),
            ]
        ).lower()
        for marker in (
            "<script",
            "<input",
            "cookie=",
            "access_token",
            "oauth_token",
            "orbit-",
        ):
            if marker in public_text:
                raise ValueError("Related-book context contains a prohibited raw marker.")
        return self


class ChatContextManifest(StrictApiModel):
    """Typed, short-lived public context supplied by the extension."""

    schema_version: Literal["v1"] = "v1"
    evidence: list[EvidenceLink] = Field(default_factory=list, max_length=100)
    library_records: list[ChatLibraryContextRecord] = Field(
        default_factory=list,
        max_length=20,
    )
    related_books: list[RelatedBookCandidate] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def validates_manifest(self) -> "ChatContextManifest":
        # Older clients may have persisted the same completion evidence from
        # both ``message.evidence`` and ``context_manifest.evidence``.  Treat
        # byte-for-byte equivalent public links as one stable entry so a
        # session upgrade repairs that legacy state at the API boundary.  A
        # reused ID with different metadata is ambiguous and remains a hard
        # failure; silently choosing one would risk carrying evidence from a
        # different source into the next turn.
        merged_evidence: list[EvidenceLink] = []
        evidence_by_id: dict[str, EvidenceLink] = {}
        for item in self.evidence:
            previous = evidence_by_id.get(item.evidence_id)
            if previous is None:
                evidence_by_id[item.evidence_id] = item
                merged_evidence.append(item)
                continue
            if (
                previous.title,
                previous.source_type,
                previous.locator,
                previous.data_classification,
            ) != (
                item.title,
                item.source_type,
                item.locator,
                item.data_classification,
            ):
                raise ValueError("Context manifest contains conflicting evidence metadata.")
        self.evidence = merged_evidence
        evidence_ids = set(evidence_by_id)
        for item in self.evidence:
            if item.data_classification not in {"public", "synthetic"}:
                # A SCombZ follow-up may carry only the opaque, conversation-
                # bound citation minted by the extension.  Other personal
                # evidence (calendar, library accounts, grades, etc.) remains
                # local and is never accepted in a provider context manifest.
                if not (
                    item.data_classification == "personal"
                    and item.source_type == "scombz"
                    and re.fullmatch(
                        r"scombz-(?:page-summary|read|course-list|portal-read|course-read|material-search)-v1-[A-Za-z0-9_-]{16,200}",
                        item.evidence_id,
                    )
                    and re.fullmatch(
                        r"orbit-scombz://(?:read|citation)/[A-Za-z0-9_-]{16,128}",
                        item.locator,
                    )
                ) and not (
                    item.data_classification == "restricted"
                    and item.source_type == "career"
                    and re.fullmatch(
                        r"cast-alumni-v1-[A-Za-z0-9_-]{16,200}",
                        item.evidence_id,
                    )
                    and re.fullmatch(
                        r"orbit-cast://alumni/[A-Za-z0-9_-]{16,128}",
                        item.locator,
                    )
                ):
                    raise ValueError(
                        "Personal or restricted evidence cannot be included in a context manifest."
                    )
            locator = urlparse(item.locator)
            if locator.scheme in {"http", "https"} and (
                locator.username or locator.password or locator.query or locator.fragment
            ):
                raise ValueError(
                    "Manifest evidence locators must not contain credentials or query data."
                )
        for record in self.library_records:
            if any(evidence_id not in evidence_ids for evidence_id in record.evidence_ids):
                raise ValueError("Library context references an unknown evidence ID.")
        candidate_refs = {item.candidate_ref for item in self.related_books}
        if len(candidate_refs) != len(self.related_books):
            raise ValueError("Related-book candidate refs must be unique.")
        library_refs = {item.resource_ref for item in self.library_records}
        for candidate in self.related_books:
            if any(evidence_id not in evidence_ids for evidence_id in candidate.evidence_ids):
                raise ValueError("Related-book context references an unknown evidence ID.")
            verified_ref = candidate.catalog_verification.resource_ref
            if verified_ref is not None and verified_ref not in library_refs:
                raise ValueError("Verified related-book refs must exist in the library context.")
        if len(self.model_dump_json()) > 64_000:
            raise ValueError("Context manifest must not exceed 64000 characters.")
        return self


class LibraryItemReadRequest(StrictApiModel):
    """Authenticated server-side OPAC detail request."""

    resource_ref: StrictStr = Field(
        min_length=1,
        max_length=160,
        pattern=r"^orbit-library://record/[A-Za-z0-9_-]{16,128}$",
    )
    presentation: Literal["summary", "location"] = "summary"
    records: list[ChatLibraryContextRecord] = Field(default_factory=list, max_length=20)


class ChatClientTool(StrictApiModel):
    name: ChatToolName
    version: Literal[1]


class ChatRunRequest(StrictApiModel):
    conversation_id: StrictStr = Field(min_length=1, max_length=200)
    message: StrictStr = Field(min_length=1, max_length=8000)
    execution_mode: Literal["sync", "background"] = "sync"
    history: list[ChatHistoryMessage] = Field(default_factory=list, max_length=20)
    # The extension may advertise every supported client capability on a run.
    # Keeping this bound in sync with ChatToolName prevents a connected page
    # from being rejected at the HTTP boundary with a misleading 422.
    client_tools: list[ChatClientTool] = Field(default_factory=list, max_length=32)
    context_manifest: ChatContextManifest | None = None

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
        | ScombzCourseListResult
        | ScombzPortalReadResult
        | ScombzCourseReadResult
        | ScombzMaterialSearchResult
        | SyllabusSearchResult
        | SyllabusReadResult
        | BrowserReadResult
        | SitrusGradeResult
        | MoodleReadResult
        | MyLibraryReadResult
        | CastReadResult
        | CastAlumniReadResult
        | CastSearchResult
        | LibraryCatalogSearchResult
        | LibraryItemReadResult
        | LibraryCatalogBrowseResult
        | LibraryDiscoverySearchResult
        | LibraryActionOptionsResult
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
        if self.name == "scombz_course_list" and not isinstance(
            self.result, ScombzCourseListResult
        ):
            raise ValueError("SCombZ course list results must use ScombzCourseListResult.")
        if self.name == "scombz_portal_read" and not isinstance(
            self.result, ScombzPortalReadResult
        ):
            raise ValueError("SCombZ portal results must use ScombzPortalReadResult.")
        if self.name == "scombz_course_read" and not isinstance(
            self.result, ScombzCourseReadResult
        ):
            raise ValueError("SCombZ course results must use ScombzCourseReadResult.")
        if self.name == "scombz_material_search" and not isinstance(
            self.result, ScombzMaterialSearchResult
        ):
            raise ValueError("SCombZ material results must use ScombzMaterialSearchResult.")
        if self.name == "syllabus_search" and not isinstance(self.result, SyllabusSearchResult):
            raise ValueError("Syllabus results must use SyllabusSearchResult.")
        if self.name == "syllabus_read" and not isinstance(self.result, SyllabusReadResult):
            raise ValueError("Syllabus detail results must use SyllabusReadResult.")
        if self.name == "browser_read_url" and not isinstance(self.result, BrowserReadResult):
            raise ValueError("Browser results must use BrowserReadResult.")
        if self.name == "sitrus_read" and not isinstance(self.result, SitrusGradeResult):
            raise ValueError("SITRUS results must use SitrusGradeResult.")
        if self.name == "moodle_read" and not isinstance(self.result, MoodleReadResult):
            raise ValueError("Moodle results must use MoodleReadResult.")
        if self.name == "my_library_read" and not isinstance(self.result, MyLibraryReadResult):
            raise ValueError("My Library results must use MyLibraryReadResult.")
        if self.name == "cast_read" and not isinstance(self.result, CastReadResult):
            raise ValueError("CAST results must use CastReadResult.")
        if self.name == "cast_alumni_read" and not isinstance(self.result, CastAlumniReadResult):
            raise ValueError("CAST alumni results must use CastAlumniReadResult.")
        if self.name == "cast_search" and not isinstance(self.result, CastSearchResult):
            raise ValueError("CAST search results must use CastSearchResult.")
        if self.name == "library_catalog_search" and not isinstance(
            self.result, LibraryCatalogSearchResult
        ):
            raise ValueError("Library catalog search results must use LibraryCatalogSearchResult.")
        if self.name == "library_item_read" and not isinstance(self.result, LibraryItemReadResult):
            raise ValueError("Library item results must use LibraryItemReadResult.")
        if self.name == "library_catalog_browse" and not isinstance(
            self.result, LibraryCatalogBrowseResult
        ):
            raise ValueError("Library browse results must use LibraryCatalogBrowseResult.")
        if self.name == "library_discovery_search" and not isinstance(
            self.result, LibraryDiscoverySearchResult
        ):
            raise ValueError("Library discovery results must use LibraryDiscoverySearchResult.")
        if self.name == "library_action_options" and not isinstance(
            self.result, LibraryActionOptionsResult
        ):
            raise ValueError("Library action results must use LibraryActionOptionsResult.")
        return self


class ChatAssistantMessage(StrictApiModel):
    message_id: StrictStr = Field(min_length=1, max_length=200)
    content_markdown: StrictStr = Field(min_length=1, max_length=12000)
    evidence: list[EvidenceLink] = Field(default_factory=list, max_length=100)
    related_books: list[RelatedBookCandidate] = Field(default_factory=list, max_length=5)

    @model_validator(mode="after")
    def validates_related_book_evidence(self) -> "ChatAssistantMessage":
        evidence_ids = {item.evidence_id for item in self.evidence}
        if len(evidence_ids) != len(self.evidence):
            raise ValueError("Assistant evidence IDs must be unique.")
        candidate_refs = {item.candidate_ref for item in self.related_books}
        if len(candidate_refs) != len(self.related_books):
            raise ValueError("Assistant related-book refs must be unique.")
        for candidate in self.related_books:
            if any(item not in evidence_ids for item in candidate.evidence_ids):
                raise ValueError("Assistant related books reference unknown evidence.")
        return self


class ChatRunCompleted(StrictApiModel):
    status: Literal["completed"]
    message: ChatAssistantMessage
    proposal: ActionProposal | None = None
    context_manifest: ChatContextManifest | None = None

    @model_validator(mode="after")
    def validates_overlapping_evidence(self) -> "ChatRunCompleted":
        """Allow mirrored evidence, but never conflicting metadata.

        The assistant message and the context manifest intentionally carry the
        same public evidence so older clients can render either projection.
        Their overlap must represent one canonical link; otherwise the next
        turn could not safely merge it.
        """

        if self.context_manifest is None:
            return self
        manifest_by_id = {item.evidence_id: item for item in self.context_manifest.evidence}
        for item in self.message.evidence:
            previous = manifest_by_id.get(item.evidence_id)
            if previous is None:
                continue
            if (
                previous.title,
                previous.source_type,
                previous.locator,
                previous.data_classification,
            ) != (
                item.title,
                item.source_type,
                item.locator,
                item.data_classification,
            ):
                raise ValueError("Chat completion contains conflicting evidence metadata.")
        return self


class ChatRunBackground(StrictApiModel):
    """Acknowledgement for a bounded in-memory background chat run."""

    status: Literal["background"]
    run_id: StrictStr = Field(min_length=1, max_length=200)


class ChatRunProgressEvent(StrictApiModel):
    """Safe user-facing progress metadata; no prompts or tool arguments."""

    sequence: StrictInt = Field(ge=1, le=1000)
    stage: Literal["planning", "tool_call", "tool_result", "synthesizing"]
    title: StrictStr = Field(min_length=1, max_length=80)
    completed: StrictInt = Field(ge=0, le=8)
    total: StrictInt | None = Field(default=None, ge=1, le=8)
    elapsed_ms: StrictInt = Field(ge=0, le=600_000)


class ChatRunToolRequired(StrictApiModel):
    status: Literal["tool_required"]
    run_id: StrictStr = Field(min_length=1, max_length=200)
    calls: list[ChatToolCall] = Field(min_length=1, max_length=1)


ChatRunResponse = Annotated[
    ChatRunCompleted | ChatRunToolRequired,
    Field(discriminator="status"),
]


ChatRunStatusResponse = Annotated[
    ChatRunCompleted | ChatRunToolRequired | ChatRunBackground,
    Field(discriminator="status"),
]


AgentRunResponse = Annotated[
    AgentRunCompleted | AgentRunToolRequired,
    Field(discriminator="status"),
]


__all__ = [
    "AgentCapabilities",
    "ChatCapabilities",
    "AgentRunCompleted",
    "AgentRunRequest",
    "AgentRunResponse",
    "AgentRunToolRequired",
    "AgentToolCall",
    "AgentToolResultRequest",
    "ChatAssistantMessage",
    "ChatClientTool",
    "ChatContextManifest",
    "ChatHistoryMessage",
    "ChatLibraryContextRecord",
    "ChatRunCompleted",
    "ChatRunRequest",
    "ChatRunResponse",
    "ChatRunToolRequired",
    "ChatToolCall",
    "ChatToolName",
    "ChatToolResultRequest",
    "BrowserReadLink",
    "BrowserReadResult",
    "CastReadResult",
    "CastAlumniProfile",
    "CastAlumniReadResult",
    "CastSearchAggregate",
    "CastSearchAppliedFilters",
    "CastSearchCoverage",
    "CastSearchResult",
    "CastSearchSort",
    "SitrusGradeItem",
    "SitrusGradeResult",
    "MoodleReadResult",
    "LegacyMyLibraryReadResult",
    "MyLibraryItem",
    "MyLibraryScope",
    "MyLibraryReadResult",
    "ScopedMyLibraryReadResult",
    "LibraryHoldingSummary",
    "LibraryRelatedRecordRef",
    "LibraryBibliographicRecord",
    "LibraryCatalogItem",
    "LibraryCatalogSearchResult",
    "LibraryItemReadResult",
    "RelatedBookCatalogVerification",
    "RelatedBookCandidate",
    "RelatedBookRelationAxis",
    "LibraryCatalogBrowseResult",
    "LibraryDiscoveryItem",
    "LibraryDiscoverySearchResult",
    "LibraryActionOptionsResult",
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
