"""Short-lived Chat turns and their deferred client-tool checkpoints."""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Protocol, cast
from uuid import uuid4

from orbit_api.models import (
    ActionProposal,
    BrowserReadResult,
    CalendarAvailabilityResult,
    CastAlumniReadResult,
    CastCareerSearchResult,
    CastReadResult,
    CastSearchResult,
    ChatAssistantMessage,
    ChatClientTool,
    ChatContextManifest,
    ChatHistoryMessage,
    ChatLibraryContextRecord,
    ChatRunBackground,
    ChatRunCompleted,
    ChatRunProgressEvent,
    ChatRunRequest,
    ChatRunResponse,
    ChatRunStatusResponse,
    ChatRunToolRequired,
    ChatToolCall,
    ChatToolResultRequest,
    EvidenceLink,
    LibraryActionOptionsResult,
    LibraryCatalogBrowseResult,
    LibraryCatalogSearchResult,
    LibraryDiscoverySearchResult,
    LibraryItemReadResult,
    MoodleReadResult,
    MyLibraryReadResult,
    RelatedBookCandidate,
    ScombzCourseListResult,
    ScombzCourseReadResult,
    ScombzMaterialSearchResult,
    ScombzPageSummaryResult,
    ScombzPortalReadResult,
    ScombzReadResult,
    ScopedMyLibraryReadResult,
    SitrusGradeResult,
    SyllabusReadResult,
    SyllabusSearchResult,
)

from .pydantic_ai_backend import (
    CAST_ALUMNI_TOOL_NAME,
    CAST_CAREER_SEARCH_TOOL_NAME,
    CAST_SEARCH_TOOL_NAME,
    LIBRARY_ACTION_OPTIONS_TOOL_NAME,
    LIBRARY_CATALOG_BROWSE_TOOL_NAME,
    LIBRARY_CATALOG_SEARCH_TOOL_NAME,
    LIBRARY_DISCOVERY_SEARCH_TOOL_NAME,
    LIBRARY_ITEM_READ_TOOL_NAME,
    MY_LIBRARY_TOOL_NAME,
    SCOMBZ_COURSE_LIST_TOOL_NAME,
    SCOMBZ_COURSE_READ_TOOL_NAME,
    SCOMBZ_MATERIAL_SEARCH_TOOL_NAME,
    SCOMBZ_PORTAL_READ_TOOL_NAME,
    ChatAgentExecution,
    ChatDraft,
    DeferredChatRun,
    research_trace_for_message,
    tool_call_fingerprint,
    validate_library_operation_evidence,
)
from .tool_catalog import TOOL_SPEC_BY_NAME

logger = logging.getLogger("uvicorn.error")
logger.setLevel(logging.INFO)

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
        library_context: list[ChatLibraryContextRecord] | None = None,
        related_book_context: list[RelatedBookCandidate] | None = None,
        advertised_tools: set[str] | None = None,
    ) -> ChatAgentExecution: ...

    async def resume_chat(
        self,
        *,
        deferred: DeferredChatRun,
        tool_result: (
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
            | CastCareerSearchResult
            | LibraryCatalogSearchResult
            | LibraryItemReadResult
            | LibraryCatalogBrowseResult
            | LibraryDiscoverySearchResult
            | LibraryActionOptionsResult
        ),
        context: list[EvidenceLink],
        tool_evidence: EvidenceLink | None = None,
        advertised_tools: set[str],
        seen_tool_call_ids: set[str] | frozenset[str] = frozenset(),
    ) -> ChatAgentExecution: ...


# Deterministic compatibility implementation for development and CI.
class FixtureChatBackend:
    """Deterministic no-network Chat backend with no tool selection."""

    _MESSAGE = "fixtureでは一般的なTool選択を再現しません。Azure backendで確認が必要です。"

    async def start_chat(
        self,
        *,
        conversation_id: str,
        message: str,
        history: list[ChatHistoryMessage],
        context: list[EvidenceLink] | None = None,
        library_context: list[ChatLibraryContextRecord] | None = None,
        related_book_context: list[RelatedBookCandidate] | None = None,
        advertised_tools: set[str] | None = None,
    ) -> ChatAgentExecution:
        del (
            conversation_id,
            message,
            history,
            context,
            library_context,
            related_book_context,
            advertised_tools,
        )
        return ChatAgentExecution(draft=ChatDraft(content_markdown=self._MESSAGE))

    async def resume_chat(
        self,
        *,
        deferred: DeferredChatRun,
        tool_result: Any,
        context: list[EvidenceLink],
        tool_evidence: EvidenceLink | None = None,
        advertised_tools: set[str],
        seen_tool_call_ids: set[str] | frozenset[str] = frozenset(),
    ) -> ChatAgentExecution:
        del (
            deferred,
            tool_result,
            context,
            tool_evidence,
            advertised_tools,
            seen_tool_call_ids,
        )
        raise ValueError(self._MESSAGE)


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
    library_action_options: dict[str, LibraryActionOptionsResult]
    advertised_tools: tuple[ChatClientTool, ...]
    seen_tool_call_ids: frozenset[str]
    generation: int
    expires_at: float
    library_context: list[ChatLibraryContextRecord] = field(default_factory=list)
    related_books: list[RelatedBookCandidate] = field(default_factory=list)
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
        library_context: Sequence[ChatLibraryContextRecord] = (),
        related_books: Sequence[RelatedBookCandidate] = (),
    ) -> str:
        snapshot = set(deferred.eligible_catalog_snapshot)
        if snapshot and deferred.tool_name not in snapshot:
            raise ValueError("The initial deferred Tool is outside the eligible catalog snapshot.")
        if snapshot and deferred.tool_name not in deferred.discovered_tool_names:
            raise ValueError("The initial deferred Tool was not discovered by native Tool Search.")
        if not deferred.unused_search_tools.issubset(
            snapshot or set(deferred.selected_client_tools)
        ):
            raise ValueError("The initial deferred unused Tool Search state is invalid.")
        now = self._clock()
        run_id = f"chat-run-{uuid4()}"
        stored = StoredChatRun(
            run_id=run_id,
            backend_name=backend_name,
            conversation_id=conversation_id,
            deferred=deferred,
            context=list(context),
            library_action_options={},
            advertised_tools=self._validate_tools(advertised_tools),
            seen_tool_call_ids=frozenset(),
            generation=0,
            expires_at=now + self.ttl_seconds,
            library_context=list(library_context),
            related_books=list(related_books),
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
            snapshot = set(run.deferred.eligible_catalog_snapshot)
            if snapshot and tool_name not in snapshot:
                raise ValueError("The chat tool is outside the eligible Tool catalog snapshot.")
            if snapshot and tool_name not in run.deferred.discovered_tool_names:
                raise ValueError("The chat tool was not discovered by native Tool Search.")
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
        library_action_options: Mapping[str, LibraryActionOptionsResult] | None = None,
        library_context: Sequence[ChatLibraryContextRecord] | None = None,
        related_books: Sequence[RelatedBookCandidate] | None = None,
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
            prior_snapshot = run.deferred.eligible_catalog_snapshot
            if prior_snapshot and deferred.eligible_catalog_snapshot != prior_snapshot:
                raise ValueError("The deferred eligible Tool catalog changed while resuming.")
            if prior_snapshot and deferred.tool_name not in set(prior_snapshot):
                raise ValueError("The deferred Tool is outside the eligible catalog snapshot.")
            if deferred.tool_call_count <= run.deferred.tool_call_count:
                raise ValueError("The deferred Tool execution count regressed while resuming.")
            prior_discovered = run.deferred.discovered_tool_names
            if not prior_discovered.issubset(deferred.discovered_tool_names):
                raise ValueError("The deferred Tool Search discovery state regressed.")
            if not deferred.unused_search_tools.issubset(run.deferred.unused_search_tools):
                raise ValueError("The deferred unused Tool Search state regressed.")
            prior_fingerprints = run.deferred.tool_call_fingerprints
            if not prior_fingerprints.issubset(deferred.tool_call_fingerprints):
                raise ValueError("The deferred duplicate-call state regressed.")
            prior_provenance = dict(run.deferred.opaque_ref_producers)
            next_provenance = dict(deferred.opaque_ref_producers)
            if any(
                next_provenance.get(ref) != producer
                for ref, producer in prior_provenance.items()
            ):
                raise ValueError("The deferred opaque-ref provenance regressed.")
            if (
                run.deferred.selected_client_tools
                and deferred.selected_client_tools != run.deferred.selected_client_tools
            ):
                raise ValueError("The deferred client Tool advertisement changed while resuming.")
            if deferred.tool_name not in deferred.discovered_tool_names:
                raise ValueError("The deferred Tool was not discovered by native Tool Search.")
            if not deferred.unused_search_tools.issubset(
                set(deferred.eligible_catalog_snapshot)
            ):
                raise ValueError("The deferred unused Tool Search state is invalid.")
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
                library_context=list(
                    library_context if library_context is not None else run.library_context
                ),
                related_books=list(
                    related_books if related_books is not None else run.related_books
                ),
                library_action_options=dict(
                    library_action_options
                    if library_action_options is not None
                    else run.library_action_options
                ),
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
    spec = TOOL_SPEC_BY_NAME.get(request.name)
    if spec is None or not isinstance(request.result, spec.result_types):
        raise ValueError("The chat tool result does not match the Tool Catalog.")
    if not spec.evidence_title or not spec.evidence_source_type or not spec.evidence_id_prefix:
        raise ValueError("The Tool Catalog has incomplete evidence metadata.")
    if spec.evidence_locator_mode == "resource_ref":
        if not isinstance(request.result, LibraryActionOptionsResult):
            raise ValueError("Library action evidence requires LibraryActionOptionsResult.")
        locator = request.result.resource_ref
    elif spec.evidence_locator_mode == "run":
        locator = f"{spec.evidence_locator_prefix}{run_id}"
    elif spec.evidence_locator_mode == "uuid":
        locator = f"{spec.evidence_locator_prefix}{uuid4().hex}"
    else:
        raise ValueError("The Tool Catalog has an unsupported evidence locator mode.")
    classification = (
        getattr(request.result, "data_classification", None)
        if spec.evidence_classification == "from_result"
        else spec.evidence_classification
    )
    if classification not in {"synthetic", "public", "personal", "restricted"}:
        raise ValueError("The chat tool result has no valid data classification.")
    return EvidenceLink(
        # Every invocation gets a distinct receipt even when the underlying
        # connector result was deduplicated inside the current run.
        evidence_id=f"{spec.evidence_id_prefix}-{uuid4().hex}",
        title=spec.evidence_title,
        source_type=cast(Any, spec.evidence_source_type),
        locator=locator,
        data_classification=cast(Any, classification),
    )


def _canonical_response(
    draft: ChatDraft,
    context: list[EvidenceLink],
    *,
    action_id_prefix: str,
    library_action_options: Mapping[str, LibraryActionOptionsResult] | None = None,
    related_books: Sequence[RelatedBookCandidate] = (),
    library_context: Sequence[ChatLibraryContextRecord] = (),
) -> ChatRunCompleted:
    canonical_context = _merge_evidence(context)
    evidence_by_id = {item.evidence_id: item for item in canonical_context}
    if len(set(draft.evidence_ids)) != len(draft.evidence_ids):
        raise ValueError("ChatDraft contains duplicate evidence IDs.")
    unknown = [item for item in draft.evidence_ids if item not in evidence_by_id]
    if unknown:
        raise ValueError("ChatDraft contains unknown evidence IDs.")
    selected = [evidence_by_id[item] for item in draft.evidence_ids]
    related_by_ref = {item.candidate_ref: item for item in related_books}
    if any(
        candidate_ref not in related_by_ref for candidate_ref in draft.related_book_candidate_refs
    ):
        raise ValueError("ChatDraft contains an unknown related-book candidate ref.")
    selected_related_books = [
        related_by_ref[candidate_ref] for candidate_ref in draft.related_book_candidate_refs
    ]
    for candidate in selected_related_books:
        for evidence_id in candidate.evidence_ids:
            evidence = evidence_by_id.get(evidence_id)
            if evidence is None:
                raise ValueError("Related-book candidate contains unknown evidence.")
            if evidence not in selected:
                selected.append(evidence)
    proposal: ActionProposal | None = None
    if draft.action is not None:
        unknown_action = [item for item in draft.action.evidence_ids if item not in evidence_by_id]
        if unknown_action:
            raise ValueError("Chat action contains unknown evidence IDs.")
        action_evidence = [evidence_by_id[item] for item in draft.action.evidence_ids]
        if draft.action.operation is not None:
            validate_library_operation_evidence(draft.action.operation, action_evidence)
            current_options = (library_action_options or {}).get(
                draft.action.operation.resource_ref
            )
            if current_options is None or current_options.status != "known":
                raise ValueError("Library operations require current known action options.")
            matching_option = next(
                (
                    option
                    for option in current_options.options
                    if option.action_type == draft.action.operation.action_type
                ),
                None,
            )
            if (
                matching_option is None
                or not matching_option.available
                or (
                    draft.action.operation.action_type == "reserve"
                    and matching_option.verification_level != "entry_visible"
                )
            ):
                raise ValueError("The proposed library operation is not currently available.")
        proposal = ActionProposal(
            action_id=f"{action_id_prefix}-{uuid4()}",
            title=draft.action.title,
            reason=draft.action.reason,
            duration_minutes=draft.action.duration_minutes,
            evidence=action_evidence,
            external_action=draft.action.external_action,
            requires_confirmation=draft.action.requires_confirmation,
            prompt_version=CHAT_PROMPT_VERSION,
            operation=draft.action.operation,
        )
        for item in proposal.evidence:
            if item not in selected:
                selected.append(item)
    manifest_evidence = [
        item for item in canonical_context if item.data_classification in {"public", "synthetic"}
    ]
    manifest_evidence_ids = {item.evidence_id for item in manifest_evidence}
    manifest_related_books = [
        item
        for item in selected_related_books
        if all(evidence_id in manifest_evidence_ids for evidence_id in item.evidence_ids)
    ]
    return ChatRunCompleted(
        status="completed",
        message=ChatAssistantMessage(
            message_id=f"msg-{uuid4()}",
            content_markdown=draft.content_markdown,
            evidence=selected,
            related_books=selected_related_books,
        ),
        proposal=proposal,
        context_manifest=(
            ChatContextManifest(
                evidence=manifest_evidence,
                library_records=list(library_context),
                related_books=manifest_related_books,
            )
            if manifest_evidence or library_context or manifest_related_books
            else None
        ),
    )


class ChatEvidenceConflictError(ValueError):
    """Evidence IDs may repeat only when their public metadata is identical."""


def _evidence_metadata(item: EvidenceLink) -> tuple[object, ...]:
    return (
        item.title,
        item.source_type,
        item.locator,
        item.data_classification,
    )


def _merge_evidence(*groups: Sequence[EvidenceLink]) -> list[EvidenceLink]:
    """Deduplicate evidence in encounter order and fail on conflicting IDs."""

    merged: dict[str, EvidenceLink] = {}
    for group in groups:
        for item in group:
            previous = merged.get(item.evidence_id)
            if previous is None:
                merged[item.evidence_id] = item
                continue
            if _evidence_metadata(previous) != _evidence_metadata(item):
                raise ChatEvidenceConflictError(
                    "Chat completion contains conflicting evidence metadata."
                )
    return list(merged.values())


@dataclass
class _BackgroundChatRun:
    run_id: str
    started_at: float = field(default_factory=time.monotonic)
    events: list[ChatRunProgressEvent] = field(default_factory=list)
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task[Any] | None = None
    result: ChatRunResponse | None = None
    error: str | None = None
    done: bool = False

    def emit(
        self,
        stage: str,
        title: str,
        completed: int,
        total: int | None,
    ) -> None:
        if len(self.events) >= 1000:
            return
        elapsed_ms = min(int((time.monotonic() - self.started_at) * 1000), 600_000)
        self.events.append(
            ChatRunProgressEvent(
                sequence=len(self.events) + 1,
                stage=cast(Any, stage),
                title=title[:80],
                completed=completed,
                total=total,
                elapsed_ms=elapsed_ms,
            )
        )
        self.wake.set()


class ChatRunService:
    def __init__(
        self,
        *,
        store: ChatRunStore | None = None,
        backend_factory: Callable[[], ChatBackend],
    ) -> None:
        self.store = store if store is not None else ChatRunStore()
        self.backend_factory = backend_factory
        self._background: dict[str, _BackgroundChatRun] = {}
        self._background_expired: dict[str, float] = {}
        # A receipt is scoped to the one deferred submission that produced it.
        # The HTTP layer consumes it immediately to emit response headers; it
        # is never persisted in a run, prompt, or observability payload.
        self._tool_receipts: dict[str, tuple[str, str]] = {}

    @staticmethod
    def _progress_title(tool_name: str) -> str:
        return {
            LIBRARY_CATALOG_SEARCH_TOOL_NAME: "OPACで書誌候補を確認中",
            LIBRARY_ITEM_READ_TOOL_NAME: "OPACで所蔵詳細を確認中",
            LIBRARY_CATALOG_BROWSE_TOOL_NAME: "OPACの一覧を確認中",
            LIBRARY_DISCOVERY_SEARCH_TOOL_NAME: "図書館の関連資料を確認中",
            LIBRARY_ACTION_OPTIONS_TOOL_NAME: "図書館の操作可否を確認中",
            "general_web_search": "公開情報を検索中",
        }.get(tool_name, "参照結果を整理中")

    def _cleanup_background(self) -> None:
        now = time.monotonic()
        for run_id, state in list(self._background.items()):
            if now - state.started_at <= CHAT_RUN_TTL_SECONDS:
                continue
            if state.task is not None and not state.task.done():
                state.task.cancel()
            del self._background[run_id]
            self._background_expired[run_id] = now
        for run_id, expired_at in list(self._background_expired.items()):
            if now - expired_at > CHAT_RUN_TTL_SECONDS:
                del self._background_expired[run_id]
        # Keep the tombstone map bounded even if a process receives a burst of
        # abandoned background runs. Dict insertion order is stable on Python 3.13.
        while len(self._background_expired) > 256:
            self._background_expired.pop(next(iter(self._background_expired)))

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
                    arguments=deferred.arguments,
                )
            ],
        )

    async def _start_sync(
        self,
        request: ChatRunRequest,
        *,
        emit: Callable[[str, str, int, int | None], None] | None = None,
    ) -> ChatRunResponse:
        if emit is not None:
            emit("planning", "会話文脈を整理中", 0, None)
        backend = self.backend_factory()
        if hasattr(backend, "progress_callback"):
            cast(Any, backend).progress_callback = emit
        advertised = set(tool.name for tool in request.client_tools)
        advertised.update(getattr(backend, "server_tool_names", frozenset()))
        live_scombz_tools = {
            SCOMBZ_COURSE_LIST_TOOL_NAME,
            SCOMBZ_PORTAL_READ_TOOL_NAME,
            SCOMBZ_COURSE_READ_TOOL_NAME,
            SCOMBZ_MATERIAL_SEARCH_TOOL_NAME,
        }
        if live_scombz_tools.intersection(advertised):
            live_allowed = (
                os.getenv("ORBIT_AGENT_BACKEND", "fixture") == "azure_openai"
                and os.getenv("ORBIT_OBSERVABILITY", "off") == "off"
                and os.getenv("ORBIT_SCOMBZ_STUDENT_READ", "off") == "live"
            )
            if not live_allowed:
                raise ValueError("SCombZ student tools require an explicit Azure live runtime.")
        manifest = request.context_manifest
        execution = await cast(Any, backend).start_chat(
            conversation_id=request.conversation_id,
            message=request.message,
            history=list(request.history),
            context=list(manifest.evidence) if manifest is not None else [],
            library_context=list(manifest.library_records) if manifest is not None else [],
            related_book_context=list(manifest.related_books) if manifest is not None else [],
            advertised_tools=advertised,
        )
        if emit is not None and execution.generated_evidence:
            emit(
                "tool_result",
                "参照結果を受け取りました",
                min(len(execution.generated_evidence), 8),
                8,
            )
        context = _merge_evidence(
            manifest.evidence if manifest is not None else [],
            execution.generated_evidence,
        )
        if execution.draft is not None:
            if emit is not None:
                emit("synthesizing", "回答をまとめています", 0, None)
            return _canonical_response(
                execution.draft,
                context,
                action_id_prefix="act-chat",
                related_books=execution.generated_related_books,
                library_context=execution.library_context,
            )
        if execution.deferred is None:
            raise RuntimeError("The chat agent returned neither a response nor a tool request.")
        current_trace = execution.deferred.research_trace
        if not current_trace.request_message:
            current_trace = research_trace_for_message(request.message, request.history)
        deferred = replace(
            execution.deferred,
            research_trace=current_trace.mark_evidence(context).register_tool(
                execution.deferred.tool_name, execution.deferred.arguments
            ),
        )
        if emit is not None:
            emit(
                "tool_call",
                self._progress_title(deferred.tool_name),
                max(deferred.tool_call_count - 1, 0),
                8,
            )
        run_id = self.store.put(
            backend_name=os.getenv("ORBIT_AGENT_BACKEND", "fixture"),
            conversation_id=request.conversation_id,
            deferred=deferred,
            context=context,
            # The public deferred-run contract stores only client-advertised
            # names.  Server tools (for example hosted web search or OPAC)
            # are eligible inside the provider agent, but are not valid
            # ``ChatClientTool`` enum values and must never be replayed as a
            # client request on resume.
            advertised_tools=request.client_tools,
            library_context=execution.library_context
            or (manifest.library_records if manifest is not None else ()),
            related_books=execution.generated_related_books,
        )
        return self._tool_required(run_id, deferred)

    async def start(self, request: ChatRunRequest) -> ChatRunResponse | ChatRunBackground:
        self._cleanup_background()
        if request.execution_mode != "background":
            return await self._start_sync(request)
        run_id = f"chat-bg-{uuid4()}"
        state = _BackgroundChatRun(run_id=run_id)
        self._background[run_id] = state
        state.task = asyncio.create_task(self._run_background(state, request))
        return ChatRunBackground(status="background", run_id=run_id)

    async def _run_background(
        self,
        state: _BackgroundChatRun,
        request: ChatRunRequest,
    ) -> None:
        deadline = asyncio.timeout(CHAT_RUN_TTL_SECONDS)
        try:
            # Enforce the advertised lifetime even when no client polls again.
            # Cleanup on the next request alone leaves abandoned provider work
            # and its input alive indefinitely.
            async with deadline:
                state.result = await self._start_sync(request, emit=state.emit)
        except TimeoutError:
            if deadline.expired():
                state.error = "background_run_expired"
                self._background.pop(state.run_id, None)
                self._background_expired[state.run_id] = time.monotonic()
            else:
                state.error = "background_run_failed"
        except asyncio.CancelledError:
            state.error = "background_run_cancelled"
            raise
        except Exception:
            # Keep the external response deliberately generic. Detailed
            # upstream reasons stay in local diagnostics, never in SSE.
            state.error = "background_run_failed"
        finally:
            state.done = True
            state.wake.set()

    def background_status(self, run_id: str) -> ChatRunStatusResponse:
        self._cleanup_background()
        state = self._background.get(run_id)
        if state is None:
            if run_id in self._background_expired:
                raise ChatRunExpiredError(run_id)
            raise ChatRunUnknownError(run_id)
        if state.error is not None:
            raise RuntimeError(state.error)
        if state.result is None:
            return ChatRunBackground(status="background", run_id=run_id)
        return state.result

    async def background_events(self, run_id: str):
        self._cleanup_background()
        state = self._background.get(run_id)
        if state is None:
            if run_id in self._background_expired:
                raise ChatRunExpiredError(run_id)
            raise ChatRunUnknownError(run_id)
        index = 0
        while True:
            while index < len(state.events):
                event = state.events[index]
                index += 1
                yield event
            if state.done:
                break
            state.wake.clear()
            await state.wake.wait()

    def clear_background(self) -> None:
        for state in self._background.values():
            if state.task is not None and not state.task.done():
                state.task.cancel()
        self._background.clear()
        self._background_expired.clear()
        self._tool_receipts.clear()

    def take_tool_receipt(self, run_id: str) -> tuple[str, str] | None:
        """Consume the latest call-specific evidence receipt for ``run_id``."""

        return self._tool_receipts.pop(run_id, None)

    async def submit_tool_result(
        self,
        run_id: str,
        request: ChatToolResultRequest,
    ) -> ChatRunResponse:
        self.store.peek(run_id)
        if os.getenv("ORBIT_OBSERVABILITY", "off") != "off":
            raise ValueError("Live client tools require ORBIT_OBSERVABILITY=off.")
        unavailable_read_result = isinstance(
            request.result,
            (
                ScombzCourseListResult,
                ScombzPortalReadResult,
                ScombzCourseReadResult,
                ScombzMaterialSearchResult,
                SyllabusSearchResult,
                SyllabusReadResult,
                LibraryCatalogSearchResult,
                LibraryItemReadResult,
                LibraryCatalogBrowseResult,
                LibraryDiscoverySearchResult,
                LibraryActionOptionsResult,
            ),
        )
        if (
            getattr(request.result, "status", None) in {"reauth_required", "unavailable"}
            and not unavailable_read_result
        ):
            raise ValueError("The client tool was unavailable and cannot resume this chat run.")
        if (
            request.name == CAST_SEARCH_TOOL_NAME
            and getattr(request.result, "status", None) != "known"
        ):
            raise ValueError("CAST search errors cannot resume a chat run.")
        if request.name == CAST_CAREER_SEARCH_TOOL_NAME and getattr(
            request.result, "status", None
        ) not in {"known", "partial"}:
            raise ValueError("CAST career search errors cannot resume a chat run.")
        claimed = self.store.claim(
            run_id,
            tool_call_id=request.tool_call_id,
            tool_name=request.name,
            tool_version=request.version,
        )
        try:
            backend_name = os.getenv("ORBIT_AGENT_BACKEND", "fixture")
            if (
                request.name == MY_LIBRARY_TOOL_NAME
                and isinstance(request.result, ScopedMyLibraryReadResult)
                and backend_name != "azure_openai"
            ):
                raise ValueError(
                    "Scoped My Library data requires the explicitly consented Azure Agent."
                )
            if (
                request.name == LIBRARY_ACTION_OPTIONS_TOOL_NAME
                and isinstance(request.result, LibraryActionOptionsResult)
                and request.result.data_classification == "personal"
                and backend_name != "azure_openai"
            ):
                raise ValueError(
                    "Personal library action capabilities require the explicitly "
                    "consented Azure Agent."
                )
            if (
                request.name == CAST_ALUMNI_TOOL_NAME
                and isinstance(request.result, CastAlumniReadResult)
                and request.result.data_classification == "restricted"
                and backend_name != "azure_openai"
            ):
                raise ValueError(
                    "Restricted CAST alumni data requires the explicitly consented Azure Agent."
                )
            tool_evidence = _tool_evidence(request, run_id)
            self._tool_receipts[run_id] = (request.tool_call_id, tool_evidence.evidence_id)
            context = _merge_evidence(claimed.context, [tool_evidence])
            trace = claimed.deferred.research_trace.mark_tool_result(
                request.name,
                getattr(request.result, "status", None),
            ).mark_evidence(context)
            library_action_options = dict(claimed.library_action_options)
            if request.name == LIBRARY_ACTION_OPTIONS_TOOL_NAME and isinstance(
                request.result, LibraryActionOptionsResult
            ):
                library_action_options[request.result.resource_ref] = request.result
            if backend_name != claimed.backend_name:
                raise RuntimeError("The chat backend changed while the run was pending.")
            execution = await self.backend_factory().resume_chat(
                deferred=claimed.deferred,
                tool_result=request.result,
                context=context,
                tool_evidence=tool_evidence,
                advertised_tools={tool.name for tool in claimed.advertised_tools},
                seen_tool_call_ids=claimed.seen_tool_call_ids,
            )
            context = _merge_evidence(context, execution.generated_evidence)
            if execution.draft is not None:
                response = _canonical_response(
                    execution.draft,
                    context,
                    action_id_prefix="act-chat",
                    library_action_options=library_action_options,
                    related_books=execution.generated_related_books,
                    library_context=execution.library_context,
                )
                self.store.complete(run_id, generation=claimed.generation)
                return response
            if execution.deferred is None:
                raise RuntimeError("The chat agent returned neither a response nor a tool request.")
            next_trace = trace
            if execution.research_trace is not None:
                next_trace = execution.research_trace
            next_fingerprint = tool_call_fingerprint(
                execution.deferred.tool_name,
                execution.deferred.arguments,
            )
            if next_fingerprint in trace.tool_fingerprints:
                raise ValueError("The chat agent repeated an unchanged tool request.")
            next_trace = next_trace.mark_evidence(context).register_tool(
                execution.deferred.tool_name,
                execution.deferred.arguments,
            )
            next_deferred = replace(execution.deferred, research_trace=next_trace)
            self.store.continue_run(
                run_id,
                deferred=next_deferred,
                context=context,
                generation=claimed.generation,
                claimed_call_id=claimed.deferred.tool_call_id,
                library_action_options=library_action_options,
                library_context=execution.library_context or claimed.library_context,
                related_books=execution.generated_related_books,
            )
            return self._tool_required(run_id, next_deferred)
        except BaseException:
            self._tool_receipts.pop(run_id, None)
            self.store.fail(run_id)
            raise


__all__ = [
    "CHAT_MAX_TOOL_CALLS",
    "CHAT_RUN_TTL_SECONDS",
    "ChatBackend",
    "ChatEvidenceConflictError",
    "ChatRunConsumedError",
    "ChatRunExpiredError",
    "ChatRunService",
    "ChatRunStore",
    "ChatRunUnknownError",
    "FixtureChatBackend",
    "StoredChatRun",
]
