"""Process-memory resumable agent runs.

The store is deliberately single-process and bounded by one fixed TTL. State
transitions are protected by a short lock; the lock is never held while a
provider/model call is awaited. This gives the API at-most-once resume
semantics without introducing a database, queue, or broker.
"""

import os
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from typing import Literal, cast
from uuid import uuid4

from orbit_api.models import (
    AgentRunCompleted,
    AgentRunRequest,
    AgentRunResponse,
    AgentRunToolRequired,
    AgentToolCall,
    AgentToolResultRequest,
    CalendarAvailabilityResult,
    ClientTool,
    EvidenceLink,
    OrbitEvent,
    ScombzPageSummaryResult,
)

from .base import AgentBackend
from .factory import get_agent_backend
from .pydantic_ai_backend import (
    CALENDAR_AVAILABILITY_LOCATOR_PREFIX,
    CALENDAR_TOOL_NAME,
    SCOMBZ_PAGE_SUMMARY_LOCATOR_PREFIX,
    SCOMBZ_TOOL_NAME,
    DeferredActionRun,
    PydanticAIAgentBackend,
    validate_agent_data,
)

RUN_TTL_SECONDS = 600
RunState = Literal["pending", "in_flight"]


class UnknownRunError(LookupError):
    pass


class ExpiredRunError(LookupError):
    pass


class ConsumedRunError(LookupError):
    pass


class RunInFlightError(ConsumedRunError):
    """A concurrent retry cannot claim a run already being resumed."""


@dataclass(frozen=True)
class StoredAgentRun:
    run_id: str
    backend_name: str
    event: OrbitEvent
    context: list[EvidenceLink]
    deferred: DeferredActionRun
    advertised_tools: tuple[ClientTool, ...]
    used_tool_names: frozenset[str]
    seen_tool_call_ids: frozenset[str]
    generation: int
    expires_at: float
    state: RunState = "pending"


class RunStore:
    """Single-worker process-memory store for resumable deferred calls."""

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
        self._lock = threading.Lock()

    def _cleanup_locked(self) -> None:
        now = self._clock()
        for run_id, run in list(self._active.items()):
            if run.expires_at <= now:
                del self._active[run_id]
                self._closed[run_id] = ("expired", now)
        for run_id, (_, closed_at) in list(self._closed.items()):
            if closed_at + self.ttl_seconds <= now:
                del self._closed[run_id]

    def _raise_missing_locked(self, run_id: str) -> None:
        closed = self._closed.get(run_id)
        reason = closed[0] if closed is not None else None
        if reason == "expired":
            raise ExpiredRunError(run_id)
        if reason in {"consumed", "completed", "failed"}:
            raise ConsumedRunError(run_id)
        raise UnknownRunError(run_id)

    def _get_locked(self, run_id: str) -> StoredAgentRun:
        run = self._active.get(run_id)
        if run is None:
            self._raise_missing_locked(run_id)
            raise AssertionError("unreachable")
        return run

    @staticmethod
    def _normalize_advertised_tools(
        advertised_tools: Sequence[ClientTool] | None,
        deferred: DeferredActionRun,
    ) -> tuple[ClientTool, ...]:
        if advertised_tools is None:
            return (ClientTool(name=deferred.tool_name, version=cast(Literal[1], 1)),)
        tools = tuple(advertised_tools)
        names = [tool.name for tool in tools]
        if len(tools) > 2 or len(set(names)) != len(names):
            raise ValueError("Client tool names must be unique and at most two may be advertised.")
        if deferred.tool_name not in names:
            raise ValueError("The deferred tool was not advertised by the client.")
        return tools

    def put(
        self,
        *,
        backend_name: str,
        event: OrbitEvent,
        context: list[EvidenceLink],
        deferred: DeferredActionRun,
        advertised_tools: Sequence[ClientTool] | None = None,
    ) -> str:
        tools = self._normalize_advertised_tools(advertised_tools, deferred)
        now = self._clock()
        run_id = f"run-{uuid4()}"
        stored = StoredAgentRun(
            run_id=run_id,
            backend_name=backend_name,
            event=event,
            context=list(context),
            deferred=deferred,
            advertised_tools=tools,
            used_tool_names=frozenset(),
            seen_tool_call_ids=frozenset(),
            generation=0,
            expires_at=now + self.ttl_seconds,
        )
        with self._lock:
            self._cleanup_locked()
            self._active[run_id] = stored
        return run_id

    def peek(self, run_id: str) -> StoredAgentRun:
        """Return a snapshot without consuming or claiming the run."""

        with self._lock:
            self._cleanup_locked()
            return self._get_locked(run_id)

    def claim(
        self,
        run_id: str,
        *,
        tool_call_id: str,
        tool_name: str,
        tool_version: int,
    ) -> StoredAgentRun:
        """Atomically validate and claim the current pending tool call.

        No fields are consumed until every identity check passes. Once this
        returns, a provider/protocol/cancellation failure must tombstone the
        run rather than making it available for a second resume.
        """

        with self._lock:
            self._cleanup_locked()
            run = self._get_locked(run_id)
            if run.state != "pending":
                raise RunInFlightError(run_id)
            if run.deferred.tool_call_id != tool_call_id:
                raise ValueError("The tool call ID does not belong to this run.")
            if run.deferred.tool_name != tool_name or run.deferred.tool_version != tool_version:
                raise ValueError("The deferred tool name or version does not match this run.")
            if tool_name not in {tool.name for tool in run.advertised_tools}:
                raise ValueError("The deferred tool was not advertised by the client.")
            if tool_name in run.used_tool_names:
                raise ValueError("The advertised tool was already used in this run.")
            if tool_call_id in run.seen_tool_call_ids:
                raise ValueError("The tool call ID was already used in this run.")
            claimed = replace(run, state="in_flight")
            self._active[run_id] = claimed
            return claimed

    def continue_run(
        self,
        run_id: str,
        *,
        deferred: DeferredActionRun,
        context: list[EvidenceLink],
        generation: int,
    ) -> StoredAgentRun:
        """Save a newer checkpoint under the same run ID and return to pending."""

        with self._lock:
            self._cleanup_locked()
            run = self._get_locked(run_id)
            if run.state != "in_flight":
                raise ConsumedRunError(run_id)
            if run.generation != generation:
                raise ConsumedRunError(run_id)
            if deferred.tool_name not in {tool.name for tool in run.advertised_tools}:
                raise ValueError("The next deferred tool was not advertised by the client.")
            if deferred.tool_name in run.used_tool_names | {run.deferred.tool_name}:
                raise ValueError("The next deferred tool was already used in this run.")
            if deferred.tool_call_id in run.seen_tool_call_ids | {
                run.deferred.tool_call_id
            }:
                raise ValueError("The next deferred tool call ID was already used in this run.")
            if deferred.conversation_id != run.deferred.conversation_id:
                raise ValueError("The agent changed the conversation ID while resuming.")
            updated = replace(
                run,
                context=list(context),
                deferred=deferred,
                used_tool_names=run.used_tool_names | {run.deferred.tool_name},
                seen_tool_call_ids=run.seen_tool_call_ids
                | {run.deferred.tool_call_id},
                generation=run.generation + 1,
                state="pending",
            )
            self._active[run_id] = updated
            return updated

    def complete(self, run_id: str, *, generation: int) -> None:
        """Complete the exact in-flight generation, unless its fixed TTL elapsed."""

        with self._lock:
            self._cleanup_locked()
            run = self._get_locked(run_id)
            if run.state != "in_flight" or run.generation != generation:
                raise ConsumedRunError(run_id)
            self._active.pop(run_id, None)
            self._closed[run_id] = ("completed", self._clock())

    def fail(self, run_id: str) -> None:
        self._tombstone(run_id, "failed")

    def _tombstone(self, run_id: str, reason: str) -> None:
        with self._lock:
            self._cleanup_locked()
            if run_id in self._active:
                self._active.pop(run_id, None)
                self._closed[run_id] = (reason, self._clock())

    def take(self, run_id: str) -> StoredAgentRun:
        """Compatibility helper that consumes a pending run atomically."""

        with self._lock:
            self._cleanup_locked()
            run = self._get_locked(run_id)
            if run.state != "pending":
                raise RunInFlightError(run_id)
            self._active.pop(run_id, None)
            self._closed[run_id] = ("consumed", self._clock())
            return run

    def close(self, run_id: str, reason: str) -> None:
        """Compatibility lifecycle method used by older callers/tests."""

        self._tombstone(run_id, reason)

    def clear(self) -> None:
        """Clear active and tombstone state for an explicit app/test reset."""

        with self._lock:
            self._active.clear()
            self._closed.clear()

    def __len__(self) -> int:
        with self._lock:
            self._cleanup_locked()
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


def _scombz_evidence(result: ScombzPageSummaryResult, run_id: str) -> EvidenceLink:
    return EvidenceLink(
        evidence_id=f"scombz-page-summary-v1-{run_id}",
        title="ScombZページから導出したページ概要",
        source_type="scombz",
        locator=f"{SCOMBZ_PAGE_SUMMARY_LOCATOR_PREFIX}{uuid4().hex}",
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

    @staticmethod
    def _tool_names(tools: Sequence[ClientTool]) -> set[str]:
        return {tool.name for tool in tools}

    @staticmethod
    def _tool_required(run_id: str, deferred: DeferredActionRun) -> AgentRunToolRequired:
        return AgentRunToolRequired(
            status="tool_required",
            run_id=run_id,
            calls=[
                AgentToolCall(
                    tool_call_id=deferred.tool_call_id,
                    name=deferred.tool_name,
                    version=deferred.tool_version,
                )
            ],
        )

    async def start(self, request: AgentRunRequest) -> AgentRunResponse:
        validate_agent_data(request.event, request.context)
        backend = self.backend_factory()
        backend_name = os.getenv("ORBIT_AGENT_BACKEND", "fixture")
        if isinstance(backend, PydanticAIAgentBackend):
            advertised_tools = self._tool_names(request.client_tools)
            proposal, deferred = await backend.start_run(
                request.event,
                request.context,
                advertised_tools=advertised_tools,
            )
            if deferred is not None:
                run_id = self.store.put(
                    backend_name=backend_name,
                    event=request.event,
                    context=request.context,
                    deferred=deferred,
                    advertised_tools=request.client_tools,
                )
                return self._tool_required(run_id, deferred)
            if proposal is None:
                raise RuntimeError("The agent returned neither a proposal nor a tool request.")
            return AgentRunCompleted(status="completed", proposal=proposal)

        # The compatibility backend contract remains a single synchronous
        # proposal method; client tools only apply to the resumable adapter.
        proposal = await backend.propose_action(request.event, request.context)
        return AgentRunCompleted(status="completed", proposal=proposal)

    async def submit_tool_result(
        self,
        run_id: str,
        request: AgentToolResultRequest,
    ) -> AgentRunResponse:
        self.store.peek(run_id)
        # Personal connector values must never enter observability backends.
        if os.getenv("ORBIT_OBSERVABILITY", "off") != "off":
            raise ValueError("Live client tools require ORBIT_OBSERVABILITY=off.")

        # claim() is the only consuming transition. Pydantic validation and
        # identity checks happen before it, so malformed/wrong results leave
        # the run pending and retryable.
        claimed = self.store.claim(
            run_id,
            tool_call_id=request.tool_call_id,
            tool_name=request.name,
            tool_version=request.version,
        )
        try:
            if (
                isinstance(request.result, CalendarAvailabilityResult)
                and request.result.status in {"reauth_required", "unavailable"}
            ):
                raise ValueError(
                    "Calendar authorization or availability must be restored before resuming."
                )

            if request.name == CALENDAR_TOOL_NAME:
                evidence = _calendar_evidence(request.result, run_id)  # type: ignore[arg-type]
            elif request.name == SCOMBZ_TOOL_NAME:
                evidence = _scombz_evidence(request.result, run_id)  # type: ignore[arg-type]
            else:
                raise ValueError("The deferred tool name is unsupported.")
            context = [*claimed.context, evidence]

            backend_name = os.getenv("ORBIT_AGENT_BACKEND", "fixture")
            if backend_name != claimed.backend_name:
                raise RuntimeError("The agent backend changed while the run was pending.")
            backend = self.backend_factory()
            if not isinstance(backend, PydanticAIAgentBackend):
                raise RuntimeError("The pending run requires the PydanticAI backend.")

            execution = await backend.resume_execution(
                claimed.event,
                context,
                claimed.deferred,
                request.result,
                advertised_tools=self._tool_names(claimed.advertised_tools),
                used_tool_names=claimed.used_tool_names,
                seen_tool_call_ids=claimed.seen_tool_call_ids,
            )
            if execution.draft is not None:
                proposal = backend._canonicalize(execution.draft, context)
                self.store.complete(run_id, generation=claimed.generation)
                return AgentRunCompleted(status="completed", proposal=proposal)
            if execution.deferred is None:
                raise RuntimeError("The agent returned neither a proposal nor a tool request.")

            self.store.continue_run(
                run_id,
                deferred=execution.deferred,
                context=context,
                generation=claimed.generation,
            )
            return self._tool_required(run_id, execution.deferred)
        except BaseException:
            # Once claimed, every provider/protocol/cancellation failure is
            # terminal. fail() is idempotent and preserves an expiry tombstone.
            self.store.fail(run_id)
            raise


__all__ = [
    "AgentRunService",
    "ConsumedRunError",
    "ExpiredRunError",
    "RUN_TTL_SECONDS",
    "RunInFlightError",
    "RunStore",
    "StoredAgentRun",
    "UnknownRunError",
]
