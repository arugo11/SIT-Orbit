"""Process-memory resumable agent runs.

Only safe event/context messages are retained while a Calendar result is
pending.  The store has no persistence backend and never stores OAuth tokens,
raw events, or Calendar result payloads.
"""

import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from uuid import uuid4

from orbit_api.models import (
    AgentRunCompleted,
    AgentRunRequest,
    AgentRunResponse,
    AgentRunToolRequired,
    AgentToolCall,
    AgentToolResultRequest,
    CalendarAvailabilityResult,
    EvidenceLink,
    OrbitEvent,
)

from .base import AgentBackend
from .factory import get_agent_backend
from .pydantic_ai_backend import (
    CALENDAR_AVAILABILITY_LOCATOR_PREFIX,
    CALENDAR_TOOL_NAME,
    DeferredActionRun,
    PydanticAIAgentBackend,
    validate_agent_data,
)

RUN_TTL_SECONDS = 600


class UnknownRunError(LookupError):
    pass


class ExpiredRunError(LookupError):
    pass


class ConsumedRunError(LookupError):
    pass


@dataclass(frozen=True)
class StoredAgentRun:
    run_id: str
    backend_name: str
    event: OrbitEvent
    context: list[EvidenceLink]
    deferred: DeferredActionRun
    expires_at: float


class RunStore:
    """Small bounded-by-TTL process-memory store for one pending tool call."""

    def __init__(
        self,
        *,
        ttl_seconds: int = RUN_TTL_SECONDS,
        clock: Callable[[], float] | None = None,
    ) -> None:
        if ttl_seconds <= 0:
            raise ValueError("Run store TTL must be positive.")
        self.ttl_seconds = ttl_seconds
        self._clock = clock or time.monotonic
        self._active: dict[str, StoredAgentRun] = {}
        self._closed: dict[str, tuple[str, float]] = {}

    def _cleanup(self) -> None:
        now = self._clock()
        for run_id, run in list(self._active.items()):
            if run.expires_at <= now:
                del self._active[run_id]
                self._closed[run_id] = ("expired", now)
        for run_id, (_, closed_at) in list(self._closed.items()):
            if closed_at + self.ttl_seconds <= now:
                del self._closed[run_id]

    def put(
        self,
        *,
        backend_name: str,
        event: OrbitEvent,
        context: list[EvidenceLink],
        deferred: DeferredActionRun,
    ) -> str:
        self._cleanup()
        run_id = f"run-{uuid4()}"
        self._active[run_id] = StoredAgentRun(
            run_id=run_id,
            backend_name=backend_name,
            event=event,
            context=list(context),
            deferred=deferred,
            expires_at=self._clock() + self.ttl_seconds,
        )
        return run_id

    def take(self, run_id: str) -> StoredAgentRun:
        self._cleanup()
        run = self._active.pop(run_id, None)
        if run is not None:
            self._closed[run_id] = ("consumed", self._clock())
            return run
        closed = self._closed.get(run_id)
        reason = closed[0] if closed is not None else None
        if reason == "expired":
            raise ExpiredRunError(run_id)
        if reason in {"consumed", "completed", "failed"}:
            raise ConsumedRunError(run_id)
        raise UnknownRunError(run_id)

    def peek(self, run_id: str) -> StoredAgentRun:
        """Return an active run without consuming it.

        A caller can use this to validate process-wide prerequisites before
        atomically consuming the pending run.  The returned object is
        immutable, and the store remains the owner of its lifecycle.
        """

        self._cleanup()
        run = self._active.get(run_id)
        if run is not None:
            return run
        closed = self._closed.get(run_id)
        reason = closed[0] if closed is not None else None
        if reason == "expired":
            raise ExpiredRunError(run_id)
        if reason in {"consumed", "completed", "failed"}:
            raise ConsumedRunError(run_id)
        raise UnknownRunError(run_id)

    def close(self, run_id: str, reason: str) -> None:
        self._active.pop(run_id, None)
        self._closed[run_id] = (reason, self._clock())

    def clear(self) -> None:
        """Clear active and tombstone state for an explicit test/app reset."""

        self._active.clear()
        self._closed.clear()

    def __len__(self) -> int:
        self._cleanup()
        return len(self._active)


def _calendar_evidence(result: CalendarAvailabilityResult, run_id: str) -> EvidenceLink:
    title = (
        "Google Calendarから導出した空き時間"
        if result.status == "known"
        else "Google Calendarの空き時間は確定できません"
    )
    return EvidenceLink(
        evidence_id=f"calendar-availability-v1-{run_id}",
        title=title,
        source_type="calendar",
        locator=f"{CALENDAR_AVAILABILITY_LOCATOR_PREFIX}{uuid4().hex}",
        data_classification="personal",
    )


class AgentRunService:
    def __init__(
        self,
        *,
        store: RunStore | None = None,
        backend_factory: Callable[[], AgentBackend] = get_agent_backend,
    ) -> None:
        self.store = store or RunStore()
        self.backend_factory = backend_factory

    async def start(self, request: AgentRunRequest) -> AgentRunResponse:
        validate_agent_data(request.event, request.context)
        backend = self.backend_factory()
        backend_name = os.getenv("ORBIT_AGENT_BACKEND", "fixture")
        calendar_connected = any(
            tool.name == CALENDAR_TOOL_NAME and tool.version == 1
            for tool in request.client_tools
        )
        if isinstance(backend, PydanticAIAgentBackend):
            proposal, deferred = await backend.start_run(
                request.event,
                request.context,
                calendar_connected=calendar_connected,
            )
            if deferred is not None:
                run_id = self.store.put(
                    backend_name=backend_name,
                    event=request.event,
                    context=request.context,
                    deferred=deferred,
                )
                return AgentRunToolRequired(
                    status="tool_required",
                    run_id=run_id,
                    calls=[
                        AgentToolCall(
                            tool_call_id=deferred.tool_call_id,
                            name=CALENDAR_TOOL_NAME,
                            version=1,
                        )
                    ],
                )
            if proposal is None:
                raise RuntimeError("The agent returned neither a proposal nor a tool request.")
            return AgentRunCompleted(status="completed", proposal=proposal)

        proposal = await backend.propose_action(request.event, request.context)
        return AgentRunCompleted(status="completed", proposal=proposal)

    async def submit_tool_result(
        self,
        run_id: str,
        request: AgentToolResultRequest,
    ) -> AgentRunResponse:
        stored = self.store.peek(run_id)
        if os.getenv("ORBIT_OBSERVABILITY", "off") != "off":
            raise ValueError("Live calendar tools require ORBIT_OBSERVABILITY=off.")
        if stored.deferred.tool_call_id != request.tool_call_id:
            raise ValueError("The tool call ID does not belong to this run.")
        if request.result.status in {"reauth_required", "unavailable"}:
            self.store.close(run_id, "failed")
            raise ValueError(
                "Calendar authorization or availability must be restored before resuming."
            )
        stored = self.store.take(run_id)

        backend_name = os.getenv("ORBIT_AGENT_BACKEND", "fixture")
        if backend_name != stored.backend_name:
            raise RuntimeError("The agent backend changed while the run was pending.")
        backend = self.backend_factory()
        if not isinstance(backend, PydanticAIAgentBackend):
            raise RuntimeError("The pending run requires the PydanticAI backend.")

        try:
            context = [*stored.context, _calendar_evidence(request.result, run_id)]
            proposal = await backend.resume_run(
                stored.event,
                context,
                stored.deferred,
                request.result,
            )
        except Exception:
            self.store.close(run_id, "failed")
            raise
        self.store.close(run_id, "completed")
        return AgentRunCompleted(status="completed", proposal=proposal)


__all__ = [
    "AgentRunService",
    "ConsumedRunError",
    "ExpiredRunError",
    "RUN_TTL_SECONDS",
    "RunStore",
    "StoredAgentRun",
    "UnknownRunError",
]
