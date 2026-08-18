"""Short-lived Chat turns and their deferred client-tool checkpoints."""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from typing import Protocol
from uuid import uuid4

from orbit_api.models import (
    ActionProposal,
    CalendarAvailabilityResult,
    ChatAssistantMessage,
    ChatClientTool,
    ChatHistoryMessage,
    ChatRunCompleted,
    ChatRunRequest,
    ChatRunResponse,
    ChatRunToolRequired,
    ChatToolCall,
    ChatToolResultRequest,
    EvidenceLink,
    ScombzPageSummaryResult,
)

from .pydantic_ai_backend import (
    CALENDAR_AVAILABILITY_LOCATOR_PREFIX,
    CALENDAR_TOOL_NAME,
    SCOMBZ_PAGE_SUMMARY_LOCATOR_PREFIX,
    ChatAgentExecution,
    ChatDraft,
    DeferredChatRun,
)

CHAT_RUN_TTL_SECONDS = 600
CHAT_MAX_TOOL_CALLS = 8
CHAT_PROMPT_VERSION = "pydantic-ai-chat-v1"


class ChatBackend(Protocol):
    async def start_chat(
        self,
        *,
        conversation_id: str,
        message: str,
        history: list[ChatHistoryMessage],
        context: list[EvidenceLink] | None = None,
        advertised_tools: set[str] | None = None,
    ) -> ChatAgentExecution: ...

    async def resume_chat(
        self,
        *,
        deferred: DeferredChatRun,
        tool_result: CalendarAvailabilityResult | ScombzPageSummaryResult,
        context: list[EvidenceLink],
        advertised_tools: set[str],
        seen_tool_call_ids: set[str] | frozenset[str] = frozenset(),
    ) -> ChatAgentExecution: ...


class FixtureChatBackend:
    """No-network Chat backend used by local development and CI."""

    async def start_chat(
        self,
        *,
        conversation_id: str,
        message: str,
        history: list[ChatHistoryMessage],
        context: list[EvidenceLink] | None = None,
        advertised_tools: set[str] | None = None,
    ) -> ChatAgentExecution:
        del conversation_id, history, context, advertised_tools
        return ChatAgentExecution(
            draft=ChatDraft(
                content_markdown=(
                    "これはローカルの合成Agentです。\n\n"
                    f"受け取った内容: {message}\n\n"
                    "実データを取得する場合は、接続設定と許可を確認してから実行します。"
                )
            )
        )

    async def resume_chat(self, **_: object) -> ChatAgentExecution:
        raise RuntimeError("The fixture Chat backend does not execute live tools.")


class ChatRunUnknownError(LookupError):
    pass


class ChatRunExpiredError(LookupError):
    pass


class ChatRunConsumedError(LookupError):
    pass


ChatRunState = str


@dataclass(frozen=True)
class StoredChatRun:
    run_id: str
    backend_name: str
    conversation_id: str
    deferred: DeferredChatRun
    context: list[EvidenceLink]
    advertised_tools: tuple[ChatClientTool, ...]
    seen_tool_call_ids: frozenset[str]
    generation: int
    expires_at: float
    state: ChatRunState = "pending"


class ChatRunStore:
    """Process-memory store for one linear Chat tool chain."""

    def __init__(
        self,
        *,
        ttl_seconds: int = CHAT_RUN_TTL_SECONDS,
        clock: Callable[[], float] | None = None,
    ) -> None:
        if ttl_seconds <= 0:
            raise ValueError("Chat run store TTL must be positive.")
        self.ttl_seconds = ttl_seconds
        self._clock = clock or time.monotonic
        self._active: dict[str, StoredChatRun] = {}
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

    def _missing_locked(self, run_id: str) -> None:
        reason = self._closed.get(run_id, ("unknown", 0))[0]
        if reason == "expired":
            raise ChatRunExpiredError(run_id)
        if reason in {"completed", "failed", "consumed"}:
            raise ChatRunConsumedError(run_id)
        raise ChatRunUnknownError(run_id)

    def _get_locked(self, run_id: str) -> StoredChatRun:
        run = self._active.get(run_id)
        if run is None:
            self._missing_locked(run_id)
            raise AssertionError("unreachable")
        return run

    @staticmethod
    def _validate_tools(tools: Sequence[ChatClientTool]) -> tuple[ChatClientTool, ...]:
        normalized = tuple(tools)
        names = [tool.name for tool in normalized]
        if len(set(names)) != len(names):
            raise ValueError("Chat client tool names must be unique per run.")
        return normalized

    def put(
        self,
        *,
        backend_name: str,
        conversation_id: str,
        deferred: DeferredChatRun,
        context: list[EvidenceLink],
        advertised_tools: Sequence[ChatClientTool],
    ) -> str:
        now = self._clock()
        run_id = f"chat-run-{uuid4()}"
        stored = StoredChatRun(
            run_id=run_id,
            backend_name=backend_name,
            conversation_id=conversation_id,
            deferred=deferred,
            context=list(context),
            advertised_tools=self._validate_tools(advertised_tools),
            seen_tool_call_ids=frozenset(),
            generation=0,
            expires_at=now + self.ttl_seconds,
        )
        with self._lock:
            self._cleanup_locked()
            self._active[run_id] = stored
        return run_id

    def peek(self, run_id: str) -> StoredChatRun:
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
    ) -> StoredChatRun:
        with self._lock:
            self._cleanup_locked()
            run = self._get_locked(run_id)
            if run.state != "pending":
                raise ChatRunConsumedError(run_id)
            if run.deferred.tool_call_id != tool_call_id:
                raise ValueError("The chat tool call ID does not belong to this run.")
            if run.deferred.tool_name != tool_name or run.deferred.tool_version != tool_version:
                raise ValueError("The chat tool name or version does not match this run.")
            if tool_name not in {tool.name for tool in run.advertised_tools}:
                raise ValueError("The chat tool was not advertised by the client.")
            if tool_call_id in run.seen_tool_call_ids:
                raise ValueError("The chat tool call ID was already used in this run.")
            if run.deferred.tool_call_count > CHAT_MAX_TOOL_CALLS:
                raise ValueError("This chat turn exceeded the tool call limit.")
            claimed = replace(run, state="in_flight")
            self._active[run_id] = claimed
            return claimed

    def continue_run(
        self,
        run_id: str,
        *,
        deferred: DeferredChatRun,
        context: list[EvidenceLink],
        generation: int,
        claimed_call_id: str,
    ) -> None:
        with self._lock:
            self._cleanup_locked()
            run = self._get_locked(run_id)
            if run.state != "in_flight" or run.generation != generation:
                raise ChatRunConsumedError(run_id)
            if deferred.conversation_id != run.conversation_id:
                raise ValueError("The chat agent changed the conversation ID while resuming.")
            if deferred.tool_call_count > CHAT_MAX_TOOL_CALLS:
                raise ValueError("This chat turn may execute at most eight tools.")
            if (
                deferred.tool_call_id in run.seen_tool_call_ids
                or deferred.tool_call_id == claimed_call_id
            ):
                raise ValueError("The chat agent returned a duplicate tool call ID.")
            if deferred.tool_name not in {tool.name for tool in run.advertised_tools}:
                raise ValueError("The next chat tool was not advertised by the client.")
            self._active[run_id] = replace(
                run,
                deferred=deferred,
                context=list(context),
                seen_tool_call_ids=run.seen_tool_call_ids | {claimed_call_id},
                generation=run.generation + 1,
                state="pending",
            )

    def complete(self, run_id: str, *, generation: int) -> None:
        with self._lock:
            self._cleanup_locked()
            run = self._get_locked(run_id)
            if run.state != "in_flight" or run.generation != generation:
                raise ChatRunConsumedError(run_id)
            self._active.pop(run_id, None)
            self._closed[run_id] = ("completed", self._clock())

    def fail(self, run_id: str) -> None:
        with self._lock:
            self._cleanup_locked()
            if run_id in self._active:
                self._active.pop(run_id, None)
                self._closed[run_id] = ("failed", self._clock())

    def clear(self) -> None:
        with self._lock:
            self._active.clear()
            self._closed.clear()

    def __len__(self) -> int:
        with self._lock:
            self._cleanup_locked()
            return len(self._active)


def _tool_evidence(request: ChatToolResultRequest, run_id: str) -> EvidenceLink:
    if request.name == CALENDAR_TOOL_NAME:
        title = "Google Calendarから導出した空き時間"
        source_type = "calendar"
        locator = f"{CALENDAR_AVAILABILITY_LOCATOR_PREFIX}{uuid4().hex}"
    elif request.name == "scombz_page_summary":
        title = "SCombZページから導出したページ概要"
        source_type = "scombz"
        locator = f"{SCOMBZ_PAGE_SUMMARY_LOCATOR_PREFIX}{uuid4().hex}"
    else:
        raise ValueError("The chat tool is not enabled in the current API build.")
    return EvidenceLink(
        evidence_id=(
            f"calendar-availability-v1-{run_id}"
            if request.name == CALENDAR_TOOL_NAME
            else f"scombz-page-summary-v1-{run_id}"
        ),
        title=title,
        source_type=source_type,  # type: ignore[arg-type]
        locator=locator,
        data_classification="personal",
    )


def _canonical_response(
    draft: ChatDraft,
    context: list[EvidenceLink],
    *,
    action_id_prefix: str,
) -> ChatRunCompleted:
    evidence_by_id = {item.evidence_id: item for item in context}
    if len(set(draft.evidence_ids)) != len(draft.evidence_ids):
        raise ValueError("ChatDraft contains duplicate evidence IDs.")
    unknown = [item for item in draft.evidence_ids if item not in evidence_by_id]
    if unknown:
        raise ValueError("ChatDraft contains unknown evidence IDs.")
    selected = [evidence_by_id[item] for item in draft.evidence_ids]
    proposal: ActionProposal | None = None
    if draft.action is not None:
        unknown_action = [item for item in draft.action.evidence_ids if item not in evidence_by_id]
        if unknown_action:
            raise ValueError("Chat action contains unknown evidence IDs.")
        proposal = ActionProposal(
            action_id=f"{action_id_prefix}-{uuid4()}",
            title=draft.action.title,
            reason=draft.action.reason,
            duration_minutes=draft.action.duration_minutes,
            evidence=[evidence_by_id[item] for item in draft.action.evidence_ids],
            external_action=draft.action.external_action,
            requires_confirmation=draft.action.requires_confirmation,
            prompt_version=CHAT_PROMPT_VERSION,
        )
        for item in proposal.evidence:
            if item not in selected:
                selected.append(item)
    return ChatRunCompleted(
        status="completed",
        message=ChatAssistantMessage(
            message_id=f"msg-{uuid4()}",
            content_markdown=draft.content_markdown,
            evidence=selected,
        ),
        proposal=proposal,
    )


class ChatRunService:
    def __init__(
        self,
        *,
        store: ChatRunStore | None = None,
        backend_factory: Callable[[], ChatBackend],
    ) -> None:
        self.store = store or ChatRunStore()
        self.backend_factory = backend_factory

    @staticmethod
    def _tool_required(run_id: str, deferred: DeferredChatRun) -> ChatRunToolRequired:
        return ChatRunToolRequired(
            status="tool_required",
            run_id=run_id,
            calls=[
                ChatToolCall(
                    tool_call_id=deferred.tool_call_id,
                    name=deferred.tool_name,
                    version=deferred.tool_version,
                    arguments={},
                )
            ],
        )

    async def start(self, request: ChatRunRequest) -> ChatRunResponse:
        advertised = set(tool.name for tool in request.client_tools)
        backend = self.backend_factory()
        execution = await backend.start_chat(
            conversation_id=request.conversation_id,
            message=request.message,
            history=list(request.history),
            context=[],
            advertised_tools=advertised,
        )
        if execution.draft is not None:
            return _canonical_response(
                execution.draft,
                [],
                action_id_prefix="act-chat",
            )
        if execution.deferred is None:
            raise RuntimeError("The chat agent returned neither a response nor a tool request.")
        run_id = self.store.put(
            backend_name=os.getenv("ORBIT_AGENT_BACKEND", "fixture"),
            conversation_id=request.conversation_id,
            deferred=execution.deferred,
            context=[],
            advertised_tools=request.client_tools,
        )
        return self._tool_required(run_id, execution.deferred)

    async def submit_tool_result(
        self,
        run_id: str,
        request: ChatToolResultRequest,
    ) -> ChatRunResponse:
        self.store.peek(run_id)
        if os.getenv("ORBIT_OBSERVABILITY", "off") != "off":
            raise ValueError("Live client tools require ORBIT_OBSERVABILITY=off.")
        if isinstance(request.result, CalendarAvailabilityResult) and request.result.status in {
            "reauth_required",
            "unavailable",
        }:
            raise ValueError(
                "Calendar authorization or availability must be restored before resuming."
            )
        claimed = self.store.claim(
            run_id,
            tool_call_id=request.tool_call_id,
            tool_name=request.name,
            tool_version=request.version,
        )
        try:
            context = [*claimed.context, _tool_evidence(request, run_id)]
            backend_name = os.getenv("ORBIT_AGENT_BACKEND", "fixture")
            if backend_name != claimed.backend_name:
                raise RuntimeError("The chat backend changed while the run was pending.")
            execution = await self.backend_factory().resume_chat(
                deferred=claimed.deferred,
                tool_result=request.result,
                context=context,
                advertised_tools={tool.name for tool in claimed.advertised_tools},
                seen_tool_call_ids=claimed.seen_tool_call_ids,
            )
            if execution.draft is not None:
                response = _canonical_response(
                    execution.draft,
                    context,
                    action_id_prefix="act-chat",
                )
                self.store.complete(run_id, generation=claimed.generation)
                return response
            if execution.deferred is None:
                raise RuntimeError("The chat agent returned neither a response nor a tool request.")
            self.store.continue_run(
                run_id,
                deferred=execution.deferred,
                context=context,
                generation=claimed.generation,
                claimed_call_id=claimed.deferred.tool_call_id,
            )
            return self._tool_required(run_id, execution.deferred)
        except BaseException:
            self.store.fail(run_id)
            raise


__all__ = [
    "CHAT_MAX_TOOL_CALLS",
    "CHAT_RUN_TTL_SECONDS",
    "ChatBackend",
    "ChatRunConsumedError",
    "ChatRunExpiredError",
    "ChatRunService",
    "ChatRunStore",
    "ChatRunUnknownError",
    "FixtureChatBackend",
    "StoredChatRun",
]
