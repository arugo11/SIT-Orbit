"""Strict request and response models for resumable agent runs.

The regular domain models predate the resumable agent API and intentionally
remain backwards compatible.  Run envelopes are a narrower boundary: unknown
fields are rejected and the response union is discriminated by ``status``.
"""

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
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
    "google_calendar_availability",
    "syllabus_search",
    "browser_read_url",
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
    client_tools: list[ChatClientTool] = Field(default_factory=list, max_length=8)

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
    result: CalendarAvailabilityResult | ScombzPageSummaryResult

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
        if self.name in {"syllabus_search", "browser_read_url"}:
            raise ValueError("This chat tool is not enabled in the current API build.")
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
    "CalendarAvailabilityInterval",
    "CalendarAvailabilityResult",
    "ClientTool",
    "ScombzPageSummaryResult",
    "StrictApiModel",
]
