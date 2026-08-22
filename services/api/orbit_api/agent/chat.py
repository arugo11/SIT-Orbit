"""Short-lived Chat turns and their deferred client-tool checkpoints."""

from __future__ import annotations

import os
import re
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Protocol
from uuid import uuid4

from orbit_api.models import (
    ActionProposal,
    BrowserReadResult,
    CalendarAvailabilityResult,
    CastAlumniReadResult,
    CastReadResult,
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
    LibraryActionOptionsResult,
    LibraryCatalogBrowseResult,
    LibraryCatalogSearchResult,
    LibraryDiscoverySearchResult,
    LibraryItemReadResult,
    MoodleReadResult,
    MyLibraryReadResult,
    MyLibraryScope,
    ScombzPageSummaryResult,
    ScombzReadResult,
    ScopedMyLibraryReadResult,
    SitrusGradeResult,
    SyllabusSearchResult,
)

from .pydantic_ai_backend import (
    BROWSER_READ_TOOL_NAME,
    CALENDAR_AVAILABILITY_LOCATOR_PREFIX,
    CALENDAR_TOOL_NAME,
    CAST_ALUMNI_LOCATOR_PREFIX,
    CAST_ALUMNI_TOOL_NAME,
    CAST_LOCATOR_PREFIX,
    CAST_TOOL_NAME,
    LIBRARY_ACTION_OPTIONS_TOOL_NAME,
    LIBRARY_CATALOG_BROWSE_TOOL_NAME,
    LIBRARY_CATALOG_SEARCH_TOOL_NAME,
    LIBRARY_DISCOVERY_SEARCH_TOOL_NAME,
    LIBRARY_ITEM_READ_TOOL_NAME,
    LIBRARY_LOCATOR_PREFIX,
    MOODLE_TOOL_NAME,
    MY_LIBRARY_TOOL_NAME,
    SCOMBZ_PAGE_SUMMARY_LOCATOR_PREFIX,
    SCOMBZ_READ_TOOL_NAME,
    SYLLABUS_SEARCH_TOOL_NAME,
    ChatAgentExecution,
    ChatDraft,
    DeferredChatRun,
    is_derived_cast_alumni_evidence,
    is_derived_cast_evidence,
    is_derived_library_action_evidence,
    is_derived_library_evidence,
    is_derived_moodle_evidence,
    is_derived_my_library_evidence,
    is_derived_scombz_read_evidence,
    is_derived_sitrus_evidence,
    validate_library_operation_evidence,
    validate_my_library_result_page,
)

CHAT_RUN_TTL_SECONDS = 600
CHAT_MAX_TOOL_CALLS = 8
CHAT_PROMPT_VERSION = "pydantic-ai-chat-v1"
_FIXTURE_SCOMBZ_QUERY = re.compile(
    r"(?:scombz|sc?omb|時間割|授業|講義|課題|締切|休講|補講|お知らせ|成績|出席|評価)",
    re.IGNORECASE,
)
_FIXTURE_SITRUS_QUERY = re.compile(r"(?:成績|単位|GPA|評価|取得済み)", re.IGNORECASE)
_FIXTURE_MOODLE_QUERY = re.compile(r"(?:moodle|ムードル|教材|コース|活動|未提出)", re.IGNORECASE)
_FIXTURE_MY_LIBRARY_QUERY = re.compile(
    r"(?:my\s*library|図書館|貸出|返却|延滞|予約|履歴|購入|相互貸借|ILL)",
    re.IGNORECASE,
)
_FIXTURE_CAST_QUERY = re.compile(
    r"(?:cast|キャリア|就活|求人|インターン|会社説明会|相談予約)", re.IGNORECASE
)
_FIXTURE_CAST_ALUMNI_QUERY = re.compile(
    r"(?:就活サポーター|キャリアサポーター|OB.?OG|卒業生|alumni|supporter|"
    r"面談可能|回答可能テーマ|就活支援者)",
    re.IGNORECASE,
)
_FIXTURE_LIBRARY_CATALOG_QUERY = re.compile(
    r"(?:opac|蔵書|図書館|書籍|本を?検索|資料を?検索|catalog|isbn)", re.IGNORECASE
)
_FIXTURE_LIBRARY_BROWSE_QUERY = re.compile(
    r"(?:新着図書|新着本|貸出ランキング|ランキング|loan\s*ranking)", re.IGNORECASE
)
_FIXTURE_LIBRARY_DISCOVERY_QUERY = re.compile(
    r"(?:sit\s*search|電子ジャーナル|電子書籍|論文|文献|discovery)", re.IGNORECASE
)


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
        tool_result: (
            CalendarAvailabilityResult
            | ScombzPageSummaryResult
            | ScombzReadResult
            | SyllabusSearchResult
            | BrowserReadResult
            | SitrusGradeResult
            | MoodleReadResult
            | MyLibraryReadResult
            | CastReadResult
            | CastAlumniReadResult
            | LibraryCatalogSearchResult
            | LibraryItemReadResult
            | LibraryCatalogBrowseResult
            | LibraryDiscoverySearchResult
            | LibraryActionOptionsResult
        ),
        context: list[EvidenceLink],
        advertised_tools: set[str],
        seen_tool_call_ids: set[str] | frozenset[str] = frozenset(),
    ) -> ChatAgentExecution: ...


class FixtureChatBackend:
    """No-network Chat backend used by local development and CI."""

    @staticmethod
    def _requests_scombz_read(
        message: str,
        history: Sequence[ChatHistoryMessage],
        advertised_tools: set[str],
    ) -> bool:
        if SCOMBZ_READ_TOOL_NAME not in advertised_tools:
            return False
        recent_text = "\n".join(item.content for item in history[-4:])
        return bool(_FIXTURE_SCOMBZ_QUERY.search(f"{recent_text}\n{message}"))

    @staticmethod
    def _requests_sitrus_read(
        message: str,
        history: Sequence[ChatHistoryMessage],
        advertised_tools: set[str],
    ) -> bool:
        if "sitrus_read" not in advertised_tools:
            return False
        recent_text = "\n".join(item.content for item in history[-4:])
        return bool(_FIXTURE_SITRUS_QUERY.search(f"{recent_text}\n{message}"))

    @staticmethod
    def _requests_moodle_read(
        message: str,
        history: Sequence[ChatHistoryMessage],
        advertised_tools: set[str],
    ) -> bool:
        if MOODLE_TOOL_NAME not in advertised_tools:
            return False
        recent_text = "\n".join(item.content for item in history[-4:])
        return bool(_FIXTURE_MOODLE_QUERY.search(f"{recent_text}\n{message}"))

    @staticmethod
    def _requests_my_library_read(
        message: str,
        history: Sequence[ChatHistoryMessage],
        advertised_tools: set[str],
    ) -> bool:
        if MY_LIBRARY_TOOL_NAME not in advertised_tools:
            return False
        recent_text = "\n".join(item.content for item in history[-4:])
        return bool(_FIXTURE_MY_LIBRARY_QUERY.search(f"{recent_text}\n{message}"))

    @staticmethod
    def _my_library_scope(message: str) -> MyLibraryScope:
        """Choose one deterministic fixture scope from the latest request."""

        # Preserve the original aggregate fixture behavior for a combined
        # "loans and reservations" request; callers asking for one section
        # get the corresponding new scoped projection below.
        if re.search(r"貸出.*予約|予約.*貸出", message, re.IGNORECASE):
            return "current_loans"
        if re.search(r"購入|購入依頼|リクエスト", message, re.IGNORECASE):
            return "purchase_requests"
        if re.search(r"相互貸借|ILL|図書館間", message, re.IGNORECASE):
            return "interlibrary_requests"
        if re.search(r"履歴|過去の貸出|借りた本", message, re.IGNORECASE):
            return "loan_history"
        if re.search(r"予約", message, re.IGNORECASE):
            return "reservations"
        return "current_loans"

    @staticmethod
    def _requests_cast_read(
        message: str,
        history: Sequence[ChatHistoryMessage],
        advertised_tools: set[str],
    ) -> bool:
        if CAST_TOOL_NAME not in advertised_tools:
            return False
        recent_text = "\n".join(item.content for item in history[-4:])
        return bool(_FIXTURE_CAST_QUERY.search(f"{recent_text}\n{message}"))

    @staticmethod
    def _requests_cast_alumni_read(
        message: str,
        history: Sequence[ChatHistoryMessage],
        advertised_tools: set[str],
    ) -> bool:
        if CAST_ALUMNI_TOOL_NAME not in advertised_tools:
            return False
        recent_text = "\n".join(item.content for item in history[-4:])
        return bool(_FIXTURE_CAST_ALUMNI_QUERY.search(f"{recent_text}\n{message}"))

    @staticmethod
    def _requests_library_catalog_search(
        message: str,
        history: Sequence[ChatHistoryMessage],
        advertised_tools: set[str],
    ) -> bool:
        if LIBRARY_CATALOG_SEARCH_TOOL_NAME not in advertised_tools:
            return False
        del history
        text = message
        return bool(_FIXTURE_LIBRARY_CATALOG_QUERY.search(text)) and not bool(
            _FIXTURE_LIBRARY_DISCOVERY_QUERY.search(text)
        )

    @staticmethod
    def _requests_library_catalog_browse(
        message: str,
        history: Sequence[ChatHistoryMessage],
        advertised_tools: set[str],
    ) -> bool:
        if LIBRARY_CATALOG_BROWSE_TOOL_NAME not in advertised_tools:
            return False
        del history
        return bool(_FIXTURE_LIBRARY_BROWSE_QUERY.search(message))

    @staticmethod
    def _requests_library_discovery_search(
        message: str,
        history: Sequence[ChatHistoryMessage],
        advertised_tools: set[str],
    ) -> bool:
        if LIBRARY_DISCOVERY_SEARCH_TOOL_NAME not in advertised_tools:
            return False
        del history
        return bool(_FIXTURE_LIBRARY_DISCOVERY_QUERY.search(message))

    @staticmethod
    def _requests_library_item_read(
        message: str,
        history: Sequence[ChatHistoryMessage],
        advertised_tools: set[str],
    ) -> bool:
        if LIBRARY_ITEM_READ_TOOL_NAME not in advertised_tools:
            return False
        del history
        return "orbit-library://record/" in message

    @staticmethod
    def _requests_library_action_options(
        message: str,
        history: Sequence[ChatHistoryMessage],
        advertised_tools: set[str],
    ) -> bool:
        if LIBRARY_ACTION_OPTIONS_TOOL_NAME not in advertised_tools:
            return False
        del history
        return bool(re.search(r"orbit-library://record/[A-Za-z0-9_-]{16,128}", message))

    async def start_chat(
        self,
        *,
        conversation_id: str,
        message: str,
        history: list[ChatHistoryMessage],
        context: list[EvidenceLink] | None = None,
        advertised_tools: set[str] | None = None,
    ) -> ChatAgentExecution:
        del context
        advertised = set(advertised_tools or set())
        if self._requests_library_action_options(message, history, advertised):
            match = re.search(r"orbit-library://record/[A-Za-z0-9_-]{16,128}", message)
            if match is not None:
                return ChatAgentExecution(
                    deferred=DeferredChatRun(
                        messages=[],
                        tool_call_id=f"fixture-library-action-options-{uuid4().hex}",
                        conversation_id=conversation_id,
                        tool_name=LIBRARY_ACTION_OPTIONS_TOOL_NAME,
                        arguments={"resource_ref": match.group(0)},
                    )
                )
        if self._requests_library_item_read(message, history, advertised):
            match = re.search(r"orbit-library://record/[A-Za-z0-9_-]{16,128}", message)
            if match is not None:
                return ChatAgentExecution(
                    deferred=DeferredChatRun(
                        messages=[],
                        tool_call_id=f"fixture-library-item-{uuid4().hex}",
                        conversation_id=conversation_id,
                        tool_name=LIBRARY_ITEM_READ_TOOL_NAME,
                        arguments={"resource_ref": match.group(0)},
                    )
                )
        if self._requests_library_discovery_search(message, history, advertised):
            return ChatAgentExecution(
                deferred=DeferredChatRun(
                    messages=[],
                    tool_call_id=f"fixture-library-discovery-{uuid4().hex}",
                    conversation_id=conversation_id,
                    tool_name=LIBRARY_DISCOVERY_SEARCH_TOOL_NAME,
                    arguments={"query": message.strip()[:200], "limit": 10},
                )
            )
        if self._requests_library_catalog_browse(message, history, advertised):
            kind = (
                "loan_ranking"
                if re.search(r"ランキング|loan\s*ranking", message, re.IGNORECASE)
                else "new_books"
            )
            return ChatAgentExecution(
                deferred=DeferredChatRun(
                    messages=[],
                    tool_call_id=f"fixture-library-browse-{uuid4().hex}",
                    conversation_id=conversation_id,
                    tool_name=LIBRARY_CATALOG_BROWSE_TOOL_NAME,
                    arguments={"kind": kind, "campus": "any", "limit": 10},
                )
            )
        if self._requests_library_catalog_search(message, history, advertised):
            return ChatAgentExecution(
                deferred=DeferredChatRun(
                    messages=[],
                    tool_call_id=f"fixture-library-catalog-{uuid4().hex}",
                    conversation_id=conversation_id,
                    tool_name=LIBRARY_CATALOG_SEARCH_TOOL_NAME,
                    arguments={"query": message.strip()[:200], "limit": 10},
                )
            )
        if self._requests_cast_alumni_read(message, history, advertised):
            return ChatAgentExecution(
                deferred=DeferredChatRun(
                    messages=[],
                    tool_call_id=f"fixture-cast-alumni-{uuid4().hex}",
                    conversation_id=conversation_id,
                    tool_name=CAST_ALUMNI_TOOL_NAME,
                )
            )
        if self._requests_cast_read(message, history, advertised):
            return ChatAgentExecution(
                deferred=DeferredChatRun(
                    messages=[],
                    tool_call_id=f"fixture-cast-{uuid4().hex}",
                    conversation_id=conversation_id,
                    tool_name=CAST_TOOL_NAME,
                )
            )
        if self._requests_my_library_read(message, history, advertised):
            scope = self._my_library_scope(message)
            return ChatAgentExecution(
                deferred=DeferredChatRun(
                    messages=[],
                    tool_call_id=f"fixture-my-library-{uuid4().hex}",
                    conversation_id=conversation_id,
                    tool_name=MY_LIBRARY_TOOL_NAME,
                    arguments={"scope": scope, "query": None, "offset": 0, "limit": 20},
                )
            )
        if self._requests_moodle_read(message, history, advertised):
            return ChatAgentExecution(
                deferred=DeferredChatRun(
                    messages=[],
                    tool_call_id=f"fixture-moodle-{uuid4().hex}",
                    conversation_id=conversation_id,
                    tool_name=MOODLE_TOOL_NAME,
                )
            )
        if self._requests_sitrus_read(message, history, advertised):
            return ChatAgentExecution(
                deferred=DeferredChatRun(
                    messages=[],
                    tool_call_id=f"fixture-sitrus-{uuid4().hex}",
                    conversation_id=conversation_id,
                    tool_name="sitrus_read",
                )
            )
        if self._requests_scombz_read(message, history, advertised):
            return ChatAgentExecution(
                deferred=DeferredChatRun(
                    messages=[],
                    tool_call_id=f"fixture-scombz-{uuid4().hex}",
                    conversation_id=conversation_id,
                    tool_name=SCOMBZ_READ_TOOL_NAME,
                )
            )
        return ChatAgentExecution(
            draft=ChatDraft(
                content_markdown=(
                    "これはローカルの合成Agentです。\n\n"
                    f"受け取った内容: {message}\n\n"
                    "実データを取得する場合は、接続設定と許可を確認してから実行します。"
                )
            )
        )

    async def resume_chat(
        self,
        *,
        deferred: DeferredChatRun,
        tool_result: (
            CalendarAvailabilityResult
            | ScombzPageSummaryResult
            | ScombzReadResult
            | SyllabusSearchResult
            | BrowserReadResult
            | SitrusGradeResult
            | MoodleReadResult
            | MyLibraryReadResult
            | CastReadResult
            | CastAlumniReadResult
            | LibraryCatalogSearchResult
            | LibraryItemReadResult
            | LibraryCatalogBrowseResult
            | LibraryDiscoverySearchResult
            | LibraryActionOptionsResult
        ),
        context: list[EvidenceLink],
        advertised_tools: set[str],
        seen_tool_call_ids: set[str] | frozenset[str] = frozenset(),
    ) -> ChatAgentExecution:
        del advertised_tools, seen_tool_call_ids
        if deferred.tool_name in {
            LIBRARY_CATALOG_SEARCH_TOOL_NAME,
            LIBRARY_ITEM_READ_TOOL_NAME,
            LIBRARY_CATALOG_BROWSE_TOOL_NAME,
            LIBRARY_DISCOVERY_SEARCH_TOOL_NAME,
            LIBRARY_ACTION_OPTIONS_TOOL_NAME,
        }:
            if not isinstance(
                tool_result,
                (
                    LibraryCatalogSearchResult,
                    LibraryItemReadResult,
                    LibraryCatalogBrowseResult,
                    LibraryDiscoverySearchResult,
                    LibraryActionOptionsResult,
                ),
            ):
                raise ValueError("The fixture library call received an invalid result.")
            evidence = next(
                (
                    item
                    for item in context
                    if (
                        is_derived_library_action_evidence(item)
                        and isinstance(tool_result, LibraryActionOptionsResult)
                        and item.locator == tool_result.resource_ref
                        if deferred.tool_name == LIBRARY_ACTION_OPTIONS_TOOL_NAME
                        else is_derived_library_evidence(item)
                    )
                ),
                None,
            )
            if evidence is None:
                raise ValueError("A resumed fixture Chat run requires library evidence.")
            if deferred.tool_name == LIBRARY_ACTION_OPTIONS_TOOL_NAME:
                if not isinstance(tool_result, LibraryActionOptionsResult):
                    raise ValueError(
                        "The fixture action call requires a LibraryActionOptionsResult."
                    )
                lines = ["図書館の現在の操作可否を確認しました。"]
                for option in tool_result.options:
                    state = "利用可能" if option.available else "利用不可"
                    lines.append(f"- {option.action_type}: {state}")
            elif deferred.tool_name == LIBRARY_ITEM_READ_TOOL_NAME:
                if not isinstance(tool_result, LibraryItemReadResult):
                    raise ValueError("The fixture item call requires a LibraryItemReadResult.")
                lines = ["図書館の公開カタログ詳細を確認しました。"]
                if tool_result.item is not None:
                    lines.append(f"- 書名: {tool_result.item.title}")
                    if tool_result.item.authors:
                        lines.append(f"- 著者: {', '.join(tool_result.item.authors)}")
                    if tool_result.item.publication_year:
                        lines.append(f"- 出版年: {tool_result.item.publication_year}")
                else:
                    lines.append("- 公開レコードの詳細は取得できませんでした。")
            elif deferred.tool_name == LIBRARY_DISCOVERY_SEARCH_TOOL_NAME:
                if not isinstance(tool_result, LibraryDiscoverySearchResult):
                    raise ValueError(
                        "The fixture discovery call requires a LibraryDiscoverySearchResult."
                    )
                lines = ["SIT Searchの公開メタデータを確認しました。"]
                for item in tool_result.items:
                    lines.append(f"- {item.title}")
                if not tool_result.items:
                    lines.append("- 表示された公開メタデータはありませんでした。")
            else:
                if isinstance(tool_result, LibraryCatalogSearchResult):
                    heading = "図書館の公開カタログ検索結果を確認しました。"
                    items = tool_result.items
                elif isinstance(tool_result, LibraryCatalogBrowseResult):
                    heading = "図書館の公開カタログ一覧を確認しました。"
                    items = tool_result.items
                else:
                    raise ValueError("The fixture library result type does not match the call.")
                lines = [heading]
                for item in items:
                    lines.append(f"- {item.title}")
                if not items:
                    lines.append("- 表示された公開レコードはありませんでした。")
            return ChatAgentExecution(
                draft=ChatDraft(
                    content_markdown="\n".join(lines),
                    evidence_ids=[evidence.evidence_id],
                )
            )
        if deferred.tool_name == CAST_TOOL_NAME:
            if not isinstance(tool_result, CastReadResult):
                raise ValueError("The fixture CAST call requires a CastReadResult.")
            evidence = next(
                (item for item in context if is_derived_cast_evidence(item)),
                None,
            )
            if evidence is None:
                raise ValueError("A resumed fixture Chat run requires CAST evidence.")
            lines = ["CASTのトップ画面を確認しました。"]
            lines.append(f"- お知らせ: {tool_result.notice_count}件")
            lines.append(f"- 新着求人: {tool_result.new_job_count}件")
            lines.append(f"- 新着インターン: {tool_result.new_internship_count}件")
            lines.append(f"- 新着説明会: {tool_result.new_event_count}件")
            lines.append(
                "- 相談予約: あり" if tool_result.has_counseling_reservation else "- 相談予約: なし"
            )
            if tool_result.nearest_notice_date:
                lines.append(f"- 直近掲載日: {tool_result.nearest_notice_date}")
            return ChatAgentExecution(
                draft=ChatDraft(
                    content_markdown="\n".join(lines),
                    evidence_ids=[evidence.evidence_id],
                )
            )
        if deferred.tool_name == CAST_ALUMNI_TOOL_NAME:
            if not isinstance(tool_result, CastAlumniReadResult):
                raise ValueError("The fixture CAST alumni call requires a CastAlumniReadResult.")
            evidence = next(
                (item for item in context if is_derived_cast_alumni_evidence(item)),
                None,
            )
            if evidence is None:
                raise ValueError("A resumed fixture Chat run requires CAST alumni evidence.")
            lines = ["CASTの就活サポーター情報を確認しました。"]
            lines.append(f"- 登録プロフィール: {tool_result.profile_count}件")
            if tool_result.topic_categories:
                lines.append(f"- 回答可能テーマ: {', '.join(tool_result.topic_categories)}")
            if tool_result.availability_frequencies:
                lines.append(
                    "- 面談可能頻度: "
                    + ", ".join(tool_result.availability_frequencies)
                )
            if tool_result.meeting_modes:
                lines.append(f"- 面談形式: {', '.join(tool_result.meeting_modes)}")
            if tool_result.shareable_insight_categories:
                lines.append(
                    "- 匿名共有可能な知見: "
                    + ", ".join(tool_result.shareable_insight_categories)
                )
            lines.append(
                "- 連絡先の有無: 端末内でのみ確認しました。"
                if tool_result.contact_present
                else "- 連絡先: 表示されていません。"
            )
            return ChatAgentExecution(
                draft=ChatDraft(
                    content_markdown="\n".join(lines),
                    evidence_ids=[evidence.evidence_id],
                )
            )
        if deferred.tool_name == MY_LIBRARY_TOOL_NAME:
            if not isinstance(tool_result, MyLibraryReadResult):
                raise ValueError("The fixture My Library call requires a MyLibraryReadResult.")
            validate_my_library_result_page(tool_result, deferred.arguments)
            evidence = next(
                (item for item in context if is_derived_my_library_evidence(item)),
                None,
            )
            if evidence is None:
                raise ValueError("A resumed fixture Chat run requires My Library evidence.")
            lines = ["My Libraryの利用状況を確認しました。"]
            if tool_result.loan_count is not None:
                lines.append(f"- 貸出中: {tool_result.loan_count}件")
            if tool_result.reservation_count is not None:
                lines.append(f"- 予約中: {tool_result.reservation_count}件")
            if tool_result.overdue_count is not None:
                lines.append(f"- 延滞: {tool_result.overdue_count}件")
            if tool_result.renewable_count is not None:
                lines.append(f"- 延長可能: {tool_result.renewable_count}件")
            if tool_result.earliest_due_date:
                lines.append(f"- 最短返却期限: {tool_result.earliest_due_date}")
            if isinstance(tool_result, ScopedMyLibraryReadResult) and tool_result.items:
                lines.append("\n**対象項目**")
                for item in tool_result.items:
                    details = [item.title]
                    if item.author:
                        details.append(f"著者: {item.author}")
                    if item.status:
                        details.append(f"状態: {item.status}")
                    if item.due_date:
                        details.append(f"返却期限: {item.due_date}")
                    if item.renewable is not None:
                        details.append("延長可能" if item.renewable else "延長不可")
                    if item.activity_date:
                        details.append(f"日付: {item.activity_date}")
                    if item.request_type:
                        details.append(f"種別: {item.request_type}")
                    lines.append(f"- {' / '.join(details)}")
            return ChatAgentExecution(
                draft=ChatDraft(
                    content_markdown="\n".join(lines),
                    evidence_ids=[evidence.evidence_id],
                )
            )
        if deferred.tool_name == MOODLE_TOOL_NAME:
            if not isinstance(tool_result, MoodleReadResult):
                raise ValueError("The fixture Moodle call requires a MoodleReadResult.")
            evidence = next(
                (item for item in context if is_derived_moodle_evidence(item)),
                None,
            )
            if evidence is None:
                raise ValueError("A resumed fixture Chat run requires Moodle evidence.")
            lines = ["Moodleのダッシュボードを確認しました。"]
            lines.append(f"- コース: {tool_result.course_count}件")
            lines.append(f"- 直近の活動・課題: {tool_result.upcoming_item_count}件")
            lines.append(f"- 期限超過: {tool_result.overdue_count}件")
            lines.append(f"- 未読通知: {tool_result.unread_notification_count}件")
            if tool_result.earliest_due_at:
                lines.append(f"- 最短期限: {tool_result.earliest_due_at}")
            return ChatAgentExecution(
                draft=ChatDraft(
                    content_markdown="\n".join(lines),
                    evidence_ids=[evidence.evidence_id],
                )
            )
        if deferred.tool_name == "sitrus_read":
            if not isinstance(tool_result, SitrusGradeResult):
                raise ValueError("The fixture SITRUS call requires a SitrusGradeResult.")
            evidence = next(
                (item for item in context if is_derived_sitrus_evidence(item)),
                None,
            )
            if evidence is None:
                raise ValueError("A resumed fixture Chat run requires SITRUS evidence.")
            lines = [
                "SITRUSの成績一覧を確認しました。"
                if tool_result.report_label == "取得済み科目"
                else "SITRUSの成績通知書を確認しました。"
            ]
            if tool_result.grades:
                lines.append("\n**成績**")
                lines.extend(
                    f"- {grade.subject}"
                    + (f"（{grade.course_code}）" if grade.course_code else "")
                    + f": {grade.grade}"
                    + (f" / {grade.credits}単位" if grade.credits is not None else "")
                    for grade in tool_result.grades
                )
            else:
                lines.append("\n表示できる成績行はありませんでした。")
            if tool_result.cumulative_gpa is not None:
                lines.append(f"\n累積GPA: {tool_result.cumulative_gpa:g}")
            return ChatAgentExecution(
                draft=ChatDraft(
                    content_markdown="\n".join(lines),
                    evidence_ids=[evidence.evidence_id],
                )
            )
        if deferred.tool_name != SCOMBZ_READ_TOOL_NAME:
            raise RuntimeError("The fixture Chat backend only executes the local SCombZ read tool.")
        if not isinstance(tool_result, ScombzReadResult):
            raise ValueError("The fixture SCombZ call requires a ScombzReadResult.")
        evidence = next(
            (item for item in context if is_derived_scombz_read_evidence(item)),
            None,
        )
        if evidence is None:
            raise ValueError("A resumed fixture Chat run requires SCombZ evidence.")

        lines = [f"SCombZの{tool_result.route}ページを確認しました。"]
        if tool_result.tasks:
            lines.append("\n**課題**")
            lines.extend(
                f"- {task.course}: {task.title}（期限: {task.deadline}）"
                for task in tool_result.tasks
            )
        if tool_result.announcements:
            lines.append("\n**お知らせ**")
            lines.extend(f"- {item.title}" for item in tool_result.announcements)
        if tool_result.timetable:
            lines.append("\n**時間割**")
            lines.extend(
                f"- {item.title}（{item.starts_at or '時刻未取得'}）"
                for item in tool_result.timetable
            )
        if tool_result.current_course:
            lines.append(f"\n現在の科目: {tool_result.current_course}")
        if tool_result.restricted_present:
            lines.append(
                "\n成績・出席・個人評価に関係する表示を検出しました。"
                "値はこのローカルChatの結果にも含めません。"
            )
        has_structured_items = any(
            (tool_result.tasks, tool_result.announcements, tool_result.timetable)
        )
        if (
            not has_structured_items
            and tool_result.current_course is None
            and not tool_result.restricted_present
        ):
            lines.append("\n構造化できる課題・お知らせ・時間割はありませんでした。")
        return ChatAgentExecution(
            draft=ChatDraft(
                content_markdown="\n".join(lines),
                evidence_ids=[evidence.evidence_id],
            )
        )


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
            library_action_options={},
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
        library_action_options: Mapping[str, LibraryActionOptionsResult] | None = None,
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
    if request.name == CALENDAR_TOOL_NAME:
        title = "Google Calendarから導出した空き時間"
        source_type = "calendar"
        locator = f"{CALENDAR_AVAILABILITY_LOCATOR_PREFIX}{uuid4().hex}"
    elif request.name == "scombz_page_summary":
        title = "SCombZページから導出したページ概要"
        source_type = "scombz"
        locator = f"{SCOMBZ_PAGE_SUMMARY_LOCATOR_PREFIX}{uuid4().hex}"
    elif request.name == SCOMBZ_READ_TOOL_NAME:
        title = "SCombZから取得した表示情報"
        source_type = "scombz"
        locator = f"orbit-scombz://read/{uuid4().hex}"
    elif request.name == SYLLABUS_SEARCH_TOOL_NAME:
        title = "芝浦工業大学公式シラバス検索"
        source_type = "syllabus"
        locator = f"orbit-syllabus://search/{uuid4().hex}"
    elif request.name == BROWSER_READ_TOOL_NAME:
        title = "許可されたWebページの表示情報"
        source_type = "web"
        locator = f"orbit-browser://read/{uuid4().hex}"
    elif request.name == "sitrus_read":
        title = "SITRUSから取得した成績の最小化表示"
        source_type = "learning_history"
        locator = f"orbit-sitrus://grades/{uuid4().hex}"
    elif request.name == MOODLE_TOOL_NAME:
        title = "Moodleから導出した学習状況の概要"
        source_type = "assignment"
        locator = f"orbit-moodle://summary/{uuid4().hex}"
    elif request.name == MY_LIBRARY_TOOL_NAME:
        title = "My Libraryから導出した利用状況の概要"
        source_type = "library"
        locator = f"orbit-library://summary/{uuid4().hex}"
    elif request.name == CAST_TOOL_NAME:
        title = "CASTから導出したキャリア情報の概要"
        source_type = "career"
        locator = f"{CAST_LOCATOR_PREFIX}{uuid4().hex}"
    elif request.name == CAST_ALUMNI_TOOL_NAME:
        title = "CASTから取得した就活サポーター情報（一般化）"
        source_type = "career"
        locator = f"{CAST_ALUMNI_LOCATOR_PREFIX}{uuid4().hex}"
    elif request.name == LIBRARY_CATALOG_SEARCH_TOOL_NAME:
        title = "芝浦工業大学公式OPACの公開カタログ検索"
        source_type = "library"
        locator = f"{LIBRARY_LOCATOR_PREFIX}{run_id}"
    elif request.name == LIBRARY_ITEM_READ_TOOL_NAME:
        title = "芝浦工業大学公式OPACの公開書誌レコード"
        source_type = "library"
        locator = f"{LIBRARY_LOCATOR_PREFIX}{run_id}"
    elif request.name == LIBRARY_CATALOG_BROWSE_TOOL_NAME:
        title = "芝浦工業大学公式OPACの新着・貸出ランキング"
        source_type = "library"
        locator = f"{LIBRARY_LOCATOR_PREFIX}{run_id}"
    elif request.name == LIBRARY_DISCOVERY_SEARCH_TOOL_NAME:
        title = "芝浦工業大学公式SIT Searchの公開メタデータ"
        source_type = "library"
        locator = f"{LIBRARY_LOCATOR_PREFIX}{run_id}"
    elif request.name == LIBRARY_ACTION_OPTIONS_TOOL_NAME:
        if not isinstance(request.result, LibraryActionOptionsResult):
            raise ValueError("Library action evidence requires LibraryActionOptionsResult.")
        title = "芝浦工業大学公式図書館の現在の操作可否"
        source_type = "library"
        # The opaque ref itself is the only locator needed to bind a proposal;
        # no provider URL, material ID, cookie, or form state crosses this API.
        locator = request.result.resource_ref
    else:
        raise ValueError("The chat tool is not enabled in the current API build.")
    evidence_prefix = {
        CALENDAR_TOOL_NAME: "calendar-availability-v1",
        "scombz_page_summary": "scombz-page-summary-v1",
        SCOMBZ_READ_TOOL_NAME: "scombz-read-v1",
        SYLLABUS_SEARCH_TOOL_NAME: "syllabus-search-v1",
        BROWSER_READ_TOOL_NAME: "browser-read-v1",
        "sitrus_read": "sitrus-grades-v1",
        MOODLE_TOOL_NAME: "moodle-summary-v1",
        MY_LIBRARY_TOOL_NAME: "my-library-summary-v1",
        CAST_TOOL_NAME: "cast-summary-v1",
        CAST_ALUMNI_TOOL_NAME: "cast-alumni-v1",
        LIBRARY_CATALOG_SEARCH_TOOL_NAME: "library-catalog-search-v1",
        LIBRARY_ITEM_READ_TOOL_NAME: "library-item-read-v1",
        LIBRARY_CATALOG_BROWSE_TOOL_NAME: "library-catalog-browse-v1",
        LIBRARY_DISCOVERY_SEARCH_TOOL_NAME: "library-discovery-search-v1",
        LIBRARY_ACTION_OPTIONS_TOOL_NAME: "library-action-options-v1",
    }[request.name]
    return EvidenceLink(
        evidence_id=f"{evidence_prefix}-{run_id}",
        title=title,
        source_type=source_type,  # type: ignore[arg-type]
        locator=locator,
        data_classification=(
            request.result.data_classification
            if isinstance(request.result, LibraryActionOptionsResult)
            else (
                "public"
                if request.name
                in {
                    SYLLABUS_SEARCH_TOOL_NAME,
                    LIBRARY_CATALOG_SEARCH_TOOL_NAME,
                    LIBRARY_ITEM_READ_TOOL_NAME,
                    LIBRARY_CATALOG_BROWSE_TOOL_NAME,
                    LIBRARY_DISCOVERY_SEARCH_TOOL_NAME,
                }
                else (
                    request.result.data_classification
                    if isinstance(request.result, BrowserReadResult)
                    else "personal"
                )
            )
        ),
    )


def _canonical_response(
    draft: ChatDraft,
    context: list[EvidenceLink],
    *,
    action_id_prefix: str,
    library_action_options: Mapping[str, LibraryActionOptionsResult] | None = None,
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
        action_evidence = [evidence_by_id[item] for item in draft.action.evidence_ids]
        if draft.action.operation is not None:
            validate_library_operation_evidence(draft.action.operation, action_evidence)
            current_options = (library_action_options or {}).get(
                draft.action.operation.resource_ref
            )
            if current_options is None or current_options.status != "known":
                raise ValueError(
                    "Library operations require current known action options."
                )
            matching_option = next(
                (
                    option
                    for option in current_options.options
                    if option.action_type == draft.action.operation.action_type
                ),
                None,
            )
            if matching_option is None or not matching_option.available:
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
                    arguments=deferred.arguments,
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
        context = list(execution.generated_evidence)
        if execution.draft is not None:
            return _canonical_response(
                execution.draft,
                context,
                action_id_prefix="act-chat",
            )
        if execution.deferred is None:
            raise RuntimeError("The chat agent returned neither a response nor a tool request.")
        run_id = self.store.put(
            backend_name=os.getenv("ORBIT_AGENT_BACKEND", "fixture"),
            conversation_id=request.conversation_id,
            deferred=execution.deferred,
            context=context,
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
        unavailable_library_result = isinstance(
            request.result,
            (
                LibraryCatalogSearchResult,
                LibraryItemReadResult,
                LibraryCatalogBrowseResult,
                LibraryDiscoverySearchResult,
                LibraryActionOptionsResult,
            ),
        )
        if (
            getattr(request.result, "status", None) in {"reauth_required", "unavailable"}
            and not unavailable_library_result
        ):
            raise ValueError("The client tool was unavailable and cannot resume this chat run.")
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
            context = [*claimed.context, _tool_evidence(request, run_id)]
            library_action_options = dict(claimed.library_action_options)
            if (
                request.name == LIBRARY_ACTION_OPTIONS_TOOL_NAME
                and isinstance(request.result, LibraryActionOptionsResult)
            ):
                library_action_options[request.result.resource_ref] = request.result
            if backend_name != claimed.backend_name:
                raise RuntimeError("The chat backend changed while the run was pending.")
            execution = await self.backend_factory().resume_chat(
                deferred=claimed.deferred,
                tool_result=request.result,
                context=context,
                advertised_tools={tool.name for tool in claimed.advertised_tools},
                seen_tool_call_ids=claimed.seen_tool_call_ids,
            )
            context.extend(execution.generated_evidence)
            if execution.draft is not None:
                response = _canonical_response(
                    execution.draft,
                    context,
                    action_id_prefix="act-chat",
                    library_action_options=library_action_options,
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
                library_action_options=library_action_options,
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
