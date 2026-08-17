"""Strict request and response models for resumable agent runs.

The regular domain models predate the resumable agent API and intentionally
remain backwards compatible.  Run envelopes are a narrower boundary: unknown
fields are rejected and the response union is discriminated by ``status``.
"""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
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


class ClientTool(StrictApiModel):
    """A capability explicitly advertised by the client for one run."""

    name: Literal["google_calendar_availability"]
    version: Literal[1]


class AgentRunRequest(StrictApiModel):
    """Start one explicit proposal run.

    ``client_tools`` is only a capability advertisement.  The server never
    uses it to access Google; a connected extension must complete the deferred
    tool call and send the minimized derived result back.
    """

    event: OrbitEvent
    context: list[EvidenceLink] = Field(min_length=1, max_length=100)
    client_tools: list[ClientTool] = Field(default_factory=list, max_length=1)


class AgentToolResultRequest(StrictApiModel):
    """Result for the one registered external tool."""

    tool_call_id: StrictStr = Field(min_length=1, max_length=200)
    result: CalendarAvailabilityResult


class AgentRunCompleted(StrictApiModel):
    status: Literal["completed"]
    proposal: ActionProposal


class AgentRunToolRequired(StrictApiModel):
    status: Literal["tool_required"]
    run_id: StrictStr = Field(min_length=1, max_length=200)
    calls: list["AgentToolCall"] = Field(min_length=1, max_length=1)


class AgentToolCall(StrictApiModel):
    tool_call_id: StrictStr = Field(min_length=1, max_length=200)
    name: Literal["google_calendar_availability"]
    version: Literal[1]


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
    "CalendarAvailabilityInterval",
    "CalendarAvailabilityResult",
    "ClientTool",
    "StrictApiModel",
]
