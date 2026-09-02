"""Deterministic candidate retrieval for the Chat model's client tools.

This is an eligibility-preserving shortlist, not a second autonomous agent.
The model still decides whether to call an exact tool from the returned set.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, cast

from orbit_api.models.agent import ChatToolName

from .tool_catalog import TOOL_SPEC_BY_NAME, ToolFamily

SelectionReason = Literal[
    "explicit_intent",
    "campus_exploration",
    "elliptical_followup",
    "current_page_context",
    "ambiguous_campus_intent",
    "general_no_tool",
    "no_eligible_tools",
]


@dataclass(frozen=True, slots=True)
class ToolSelectionContext:
    message: str
    available_tools: frozenset[str]
    recent_messages: tuple[str, ...] = ()
    current_page_family: ToolFamily | None = None
    last_tool_family: ToolFamily | None = None


@dataclass(frozen=True, slots=True)
class ToolSelectionDecision:
    candidates: tuple[ChatToolName, ...]
    families: tuple[ToolFamily, ...]
    reason_code: SelectionReason
    confidence: float
    no_tool_reason: str | None = None


_FAMILY_PATTERNS: dict[ToolFamily, re.Pattern[str]] = {
    ToolFamily.SCOMBZ: re.compile(
        r"scombz|scomb\s*z|人工知能|どんなことを学ぶ|学ぶ内容|授業では|"
        r"今受けている授業|最近の授業|授業で扱|授業の中で|"
        r"課題|授業ページ|履修|時間割|教材|講義資料|お知らせ",
        re.IGNORECASE,
    ),
    ToolFamily.CALENDAR: re.compile(
        r"google\s*calendar|カレンダー|空き時間|空いて(?:る|いる)|予定を確認",
        re.IGNORECASE,
    ),
    ToolFamily.SYLLABUS: re.compile(
        r"シラバス|syllabus|授業概要|講義概要|授業全体|科目全体|位置づけ|カリキュラム上",
        re.IGNORECASE,
    ),
    ToolFamily.BROWSER: re.compile(
        r"https?://|この(?:web)?ページ|この記事|urlを|ページを読|公開ページ",
        re.IGNORECASE,
    ),
    ToolFamily.SITRUS: re.compile(
        r"sitrus|成績通知|成績一覧|\bgpa\b|私の成績|"
        r"成績(?:はどう|どうだった|を(?:教えて|見せて|確認))|"
        r"何単位|取得(?:済み)?単位|取得済み科目|落とした科目|"
        r"単位(?:は足り|を取|を取得|取れて)",
        re.IGNORECASE,
    ),
    ToolFamily.MOODLE: re.compile(r"moodle|ムードル|課題|コース活動", re.IGNORECASE),
    ToolFamily.MY_LIBRARY: re.compile(
        r"my\s*library|マイライブラリ|貸出中|借りている本|返却期限|貸出履歴|予約状況",
        re.IGNORECASE,
    ),
    ToolFamily.CAST: re.compile(
        r"\bcast\b|就活|求人|インターン|卒業生|ob.?og|キャリア|先輩|採用実績|"
        r"ML.?エンジニア|機械学習エンジニア|仕事(?:として)?(?:体験|経験)|"
        r"職業体験|参加できる|参加可能",
        re.IGNORECASE,
    ),
    ToolFamily.LIBRARY: re.compile(
        r"opac|sit\s*search|図書館|蔵書|本を探|書誌|請求記号|配架|新着図書|貸出ランキング|借りられ(?:る|ます)?|所蔵|在架|貸出(?:可|状況|中)?|借りたい|大学に(?:ある|所蔵)|大学で借り",
        re.IGNORECASE,
    ),
}
_ELLIPTICAL_RE = re.compile(
    r"^(?:それ|その|これ|この|さっき|続き|詳しく|他には|じゃあ|では)|"
    r"(?:どこ|いつ|どう|もっと|具体的に).{0,20}[？?]?$",
    re.IGNORECASE,
)
_ELLIPTICAL_TOOL_ACTION_RE = re.compile(
    r"どこ|いつ|どう|詳しく|具体的|確認|検索|探して|読んで|見せて|教えて",
    re.IGNORECASE,
)
_BROAD_CAMPUS_RE = re.compile(r"学内|大学の|芝浦工大|芝浦工業大学|キャンパス")
_CAMPUS_EXPLORATION_RE = re.compile(
    r"(?=.*(?:芝浦|学内|大学|キャンパス))"
    r"(?=.*(?:興味|関心|テーマ|学び))"
    r"(?=.*(?:広げ|深め|つなげ|次の一歩|できること|何ができる))|"
    r"(?=.*(?:授業|学び))(?=.*(?:仕事体験|キャリア))(?=.*(?:本|資料))",
    re.IGNORECASE,
)
_NAMED_SERVICE_RE = re.compile(
    r"scombz|scomb\s*z|シラバス|syllabus|\bcast\b|opac|sit\s*search|図書館",
    re.IGNORECASE,
)
_EXPLORATION_TOOLS: tuple[ChatToolName, ...] = (
    "syllabus_search",
    "syllabus_read",
    "cast_search",
    "library_catalog_search",
    "library_item_read",
)


def _family_tools(family: ToolFamily, text: str) -> tuple[ChatToolName, ...]:
    if family == ToolFamily.SCOMBZ:
        if re.search(r"今受けている授業|最近の授業|授業の中で", text):
            return ("scombz_course_list", "scombz_course_read")
        if re.search(r"人工知能|どんなことを学ぶ|学ぶ内容", text, re.IGNORECASE):
            return ("scombz_course_read", "scombz_course_list", "scombz_portal_read")
        if re.search(r"教材|資料|pdf|スライド|本文", text, re.IGNORECASE):
            return ("scombz_material_search", "scombz_course_read", "scombz_course_list")
        if re.search(r"履修|時間割|科目一覧|授業一覧", text):
            return ("scombz_course_list", "scombz_course_read")
        if re.search(r"ポータル|お知らせ|連絡", text):
            return ("scombz_portal_read", "scombz_course_read")
        if re.search(r"このページ|表示中|開いて", text):
            return ("scombz_read", "scombz_page_summary")
        if re.search(r"課題|締切|授業内容|アナウンス", text):
            return ("scombz_course_read", "scombz_course_list", "scombz_portal_read")
        return (
            "scombz_course_list",
            "scombz_portal_read",
            "scombz_course_read",
            "scombz_material_search",
        )
    if family == ToolFamily.CALENDAR:
        return ("google_calendar_availability",)
    if family == ToolFamily.SYLLABUS:
        return ("syllabus_search", "syllabus_read")
    if family == ToolFamily.BROWSER:
        return ("browser_read_url",)
    if family == ToolFamily.SITRUS:
        return ("sitrus_read",)
    if family == ToolFamily.MOODLE:
        return ("moodle_read",)
    if family == ToolFamily.MY_LIBRARY:
        return ("my_library_read",)
    if family == ToolFamily.CAST:
        if re.search(
            r"卒業生|ob.?og|先輩|サポーター|ML.?エンジニア|機械学習エンジニア",
            text,
            re.IGNORECASE,
        ):
            return ("cast_career_search", "cast_alumni_read", "cast_search")
        if re.search(
            r"仕事|求人|インターン|採用|企業|検索|参加できる|参加可能|体験|経験",
            text,
            re.IGNORECASE,
        ):
            return ("cast_search", "cast_read")
        return ("cast_read", "cast_search", "cast_alumni_read")
    if re.search(r"新着|ランキング", text):
        return ("library_catalog_browse", "library_item_read")
    if re.search(r"予約|延長|取り寄せ|購入依頼|ill|利用でき", text, re.IGNORECASE):
        return (
            "library_catalog_search",
            "library_item_read",
            "library_action_options",
        )
    if re.search(
        r"配架|場所|どこ|棚|請求記号|借りられ|所蔵|在架|貸出|大学に(?:ある|所蔵)|大学で借り",
        text,
    ):
        return ("library_catalog_search", "library_item_read")
    if re.search(r"おすすめ|関連|発見|探して", text):
        return (
            "library_discovery_search",
            "library_catalog_search",
            "library_item_read",
        )
    return ("library_catalog_search", "library_item_read", "library_discovery_search")


def select_client_tools(
    context: ToolSelectionContext,
    *,
    max_candidates: int = 5,
) -> ToolSelectionDecision:
    """Return a stable, eligible shortlist without exposing all connectors."""

    available = {
        name
        for name in context.available_tools
        if name in TOOL_SPEC_BY_NAME and TOOL_SPEC_BY_NAME[name].read_only
    }
    if not available:
        return ToolSelectionDecision(
            candidates=(),
            families=(),
            reason_code="no_eligible_tools",
            confidence=1.0,
            no_tool_reason="No authenticated client tool is eligible for this run.",
        )

    message = context.message.strip()

    # An intentionally broad campus question should let the model compare
    # learning, career, and reading options without requiring the user to know
    # connector names. Keep the shortlist balanced across those three families
    # instead of allowing the first family to consume all five slots.
    campus_exploration = bool(_CAMPUS_EXPLORATION_RE.search(message)) and not bool(
        _NAMED_SERVICE_RE.search(message)
    )
    if campus_exploration:
        candidates = cast(
            tuple[ChatToolName, ...],
            tuple(name for name in _EXPLORATION_TOOLS if name in available)[
                : max(1, min(max_candidates, 5))
            ],
        )
        if candidates:
            families = tuple(
                family
                for family in (ToolFamily.SYLLABUS, ToolFamily.CAST, ToolFamily.LIBRARY)
                if any(TOOL_SPEC_BY_NAME[name].family == family for name in candidates)
            )
            return ToolSelectionDecision(
                candidates=candidates,
                families=families,
                reason_code="campus_exploration",
                confidence=0.85,
            )

    def family_scores(text: str) -> dict[ToolFamily, int]:
        return {
            family: len(pattern.findall(text)) * 4
            for family, pattern in _FAMILY_PATTERNS.items()
            if pattern.findall(text)
        }

    # An opener such as 「それを」 is not by itself a follow-up.  First inspect
    # the latest message in isolation so an explicit new intent cannot inherit
    # a stale SCombZ/syllabus/CAST/browser family from the transcript.
    latest_scores = family_scores(message)
    explicit_intent = bool(latest_scores)
    # A demonstrative noun phrase such as 「その3冊」 identifies an entity but
    # does not express a connector intent.  Reuse the previous family only
    # when the latest turn also contains an action/question cue such as
    # 「どこ」「確認」「詳しく」. Entity resolution remains the model's job.
    elliptical = (
        bool(_ELLIPTICAL_RE.search(message))
        and bool(_ELLIPTICAL_TOOL_ACTION_RE.search(message))
        and not explicit_intent
    )
    routing_text = message
    if elliptical and context.recent_messages:
        routing_text = "\n".join((*context.recent_messages[-2:], message))

    scores = latest_scores if explicit_intent else family_scores(routing_text)
    scored: list[tuple[int, int, ToolFamily]] = [
        (score, order, family)
        for order, (family, _pattern) in enumerate(_FAMILY_PATTERNS.items())
        for score in (scores.get(family, 0),)
        if score > 0
    ]

    reason: SelectionReason = "explicit_intent"
    if elliptical and scored:
        reason = "elliptical_followup"
    if not scored and context.current_page_family is not None and _BROAD_CAMPUS_RE.search(message):
        scored.append((0, 0, context.current_page_family))
        reason = "current_page_context"
    elif not scored and _BROAD_CAMPUS_RE.search(message):
        fallback = context.last_tool_family
        if fallback is not None:
            scored.append((0, 0, fallback))
            reason = "ambiguous_campus_intent"

    if not scored:
        return ToolSelectionDecision(
            candidates=(),
            families=(),
            reason_code="general_no_tool",
            confidence=1.0,
            no_tool_reason="The request does not require authenticated campus data.",
        )

    # Page and previous-tool context only break equal-intent ties.  They never
    # outweigh a stronger explicit intent in the latest message.
    scored.sort(
        key=lambda item: (
            -item[0],
            0 if item[2] == context.current_page_family else 1,
            0 if elliptical and item[2] == context.last_tool_family else 1,
            item[1],
        )
    )
    families = tuple(item[2] for item in scored)
    selected: list[ChatToolName] = []
    for family in families:
        before_family = len(selected)
        for name in _family_tools(family, routing_text):
            if name in available and name not in selected:
                selected.append(name)
                if len(selected) >= max(1, min(max_candidates, 5)):
                    break
        # Specific intent may prefer a newer cross-page tool that the current
        # deployment has not advertised. Retain an eligible legacy/read-only
        # member of the same family instead of dropping the whole family.
        if len(selected) == before_family:
            for spec in TOOL_SPEC_BY_NAME.values():
                name = spec.name
                if spec.family == family and name in available and name not in selected:
                    selected.append(name)
                    if len(selected) >= max(1, min(max_candidates, 5)):
                        break
        if len(selected) >= max(1, min(max_candidates, 5)):
            break

    if not selected:
        return ToolSelectionDecision(
            candidates=(),
            families=families,
            reason_code="no_eligible_tools",
            confidence=1.0,
            no_tool_reason="The matching campus tools are not eligible for this run.",
        )
    confidence = 0.65 if reason == "ambiguous_campus_intent" else 0.9
    return ToolSelectionDecision(
        candidates=tuple(selected),
        families=families,
        reason_code=reason,
        confidence=confidence,
    )


__all__ = [
    "SelectionReason",
    "ToolSelectionContext",
    "ToolSelectionDecision",
    "select_client_tools",
]
