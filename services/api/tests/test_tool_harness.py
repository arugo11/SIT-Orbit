from typing import get_args

import pytest
from orbit_api.agent.pydantic_ai_backend import CHAT_TOOL_HANDLERS
from orbit_api.agent.tool_catalog import (
    CHAT_TOOL_NAMES,
    LIVE_SCOMBZ_TOOL_NAMES,
    LIVE_SITRUS_TOOL_NAMES,
    TOOL_SPEC_BY_NAME,
    TOOL_SPECS,
    ToolFamily,
    capability_tool_names,
)
from orbit_api.agent.tool_router import ToolSelectionContext, select_client_tools
from orbit_api.models.agent import ChatToolName


def test_tool_catalog_matches_public_contract_and_handlers() -> None:
    assert CHAT_TOOL_NAMES == get_args(ChatToolName)
    assert len(TOOL_SPECS) == 22
    assert set(CHAT_TOOL_HANDLERS) == set(CHAT_TOOL_NAMES)
    assert all(spec.read_only and spec.version == 1 for spec in TOOL_SPECS)
    assert all(spec.handler_name in CHAT_TOOL_HANDLERS for spec in TOOL_SPECS)
    assert all(spec.result_types for spec in TOOL_SPECS)


def test_capability_catalog_gates_live_scombz_without_reordering() -> None:
    default = capability_tool_names(
        backend="fixture",
        observability="off",
        scombz_student_read_mode="fixture",
        sitrus_personal_context_mode="off",
    )
    live = capability_tool_names(
        backend="azure_openai",
        observability="off",
        scombz_student_read_mode="live",
        sitrus_personal_context_mode="live",
    )

    assert LIVE_SCOMBZ_TOOL_NAMES.issubset(default)
    assert not LIVE_SITRUS_TOOL_NAMES.intersection(default)
    assert live == CHAT_TOOL_NAMES
    assert tuple(name for name in live if name in default) == default


@pytest.mark.parametrize(
    "message",
    [
        "私の成績を教えて",
        "成績はどうだった？",
        "何単位取れている？",
        "取得済み科目を確認して",
        "落とした科目はある？",
    ],
)
def test_router_shortlists_sitrus_for_personal_academic_records(message: str) -> None:
    decision = select_client_tools(
        ToolSelectionContext(
            message=message,
            available_tools=frozenset({"sitrus_read", "syllabus_search"}),
        )
    )

    assert decision.candidates == ("sitrus_read",)
    assert decision.families[0] == ToolFamily.SITRUS


@pytest.mark.parametrize(
    "message",
    ["この授業の成績評価方法を教えて", "成績を上げる一般的な方法を知りたい"],
)
def test_router_does_not_read_sitrus_for_general_grade_questions(message: str) -> None:
    decision = select_client_tools(
        ToolSelectionContext(
            message=message,
            available_tools=frozenset({"sitrus_read", "syllabus_search"}),
        )
    )

    assert "sitrus_read" not in decision.candidates


def test_router_does_not_inherit_sitrus_for_new_general_advice() -> None:
    decision = select_client_tools(
        ToolSelectionContext(
            message="成績を上げる一般的な方法を知りたい",
            recent_messages=("私の成績を教えて", "取得済み科目を確認しました"),
            last_tool_family=ToolFamily.SITRUS,
            available_tools=frozenset({"sitrus_read", "syllabus_search"}),
        )
    )

    assert "sitrus_read" not in decision.candidates


def test_router_keeps_general_conversation_on_no_tool_path() -> None:
    decision = select_client_tools(
        ToolSelectionContext(
            message="この企画の長所と弱点を整理して",
            available_tools=frozenset(CHAT_TOOL_NAMES),
        )
    )

    assert decision.candidates == ()
    assert decision.reason_code == "general_no_tool"


@pytest.mark.parametrize(
    "message",
    (
        "芝浦で、この興味を授業・仕事体験・読める本につなげたい。次に何ができる？",
        "この学びを、授業、キャリア、資料の3方向から広げたい。",
    ),
)
def test_router_balances_abstract_campus_exploration_across_families(
    message: str,
) -> None:
    decision = select_client_tools(
        ToolSelectionContext(
            message=message,
            available_tools=frozenset(CHAT_TOOL_NAMES),
        )
    )

    assert decision.reason_code == "campus_exploration"
    assert decision.families == (
        ToolFamily.SYLLABUS,
        ToolFamily.CAST,
        ToolFamily.LIBRARY,
    )
    assert decision.candidates == (
        "syllabus_search",
        "syllabus_read",
        "cast_search",
        "library_catalog_search",
        "library_item_read",
    )


def test_router_keeps_named_service_intent_more_specific_than_exploration() -> None:
    decision = select_client_tools(
        ToolSelectionContext(
            message="CASTで、この関心を仕事体験につなげる方法を探して",
            available_tools=frozenset(CHAT_TOOL_NAMES),
        )
    )

    assert decision.reason_code == "explicit_intent"
    assert decision.families[0] == ToolFamily.CAST


def test_router_shortlists_question_relevant_scombz_tools() -> None:
    decision = select_client_tools(
        ToolSelectionContext(
            message="SCombZの機械学習の教材PDFから正則化の説明を探して",
            available_tools=frozenset(CHAT_TOOL_NAMES),
        )
    )

    assert decision.candidates == (
        "scombz_material_search",
        "scombz_course_read",
        "scombz_course_list",
    )
    assert decision.families[0] == ToolFamily.SCOMBZ


def test_router_uses_recent_family_for_elliptical_followup() -> None:
    decision = select_client_tools(
        ToolSelectionContext(
            message="それはどこにある？",
            recent_messages=("機械学習の本を図書館で探して",),
            available_tools=frozenset(CHAT_TOOL_NAMES),
            current_page_family=ToolFamily.LIBRARY,
            last_tool_family=ToolFamily.LIBRARY,
        )
    )

    assert decision.reason_code == "elliptical_followup"
    assert decision.candidates[:2] == (
        "library_catalog_search",
        "library_item_read",
    )


def test_router_never_returns_unavailable_or_more_than_five_tools() -> None:
    available = frozenset(
        {
            "scombz_course_list",
            "google_calendar_availability",
            "syllabus_search",
            "cast_search",
        }
    )
    decision = select_client_tools(
        ToolSelectionContext(
            message="SCombZとカレンダーとシラバスとCASTを横断して予定を考えて",
            available_tools=available,
        )
    )

    assert 1 <= len(decision.candidates) <= 5
    assert set(decision.candidates) <= available


@pytest.mark.parametrize(
    ("message", "expected_family", "expected_prefix"),
    (
        ("何ができるの？", None, ()),
        (
            "今受けている授業の中で、AIをもっと深く学べそうなテーマを一つ見つけて。",
            ToolFamily.SCOMBZ,
            ("scombz_course_list", "scombz_course_read"),
        ),
        ("人工知能の授業では、どんなことを学ぶの？", ToolFamily.SCOMBZ, ("scombz_course_read",)),
        (
            "強化学習はどのあたり？ 授業全体での位置づけも知りたい。",
            ToolFamily.SYLLABUS,
            ("syllabus_search", "syllabus_read"),
        ),
        (
            "それを仕事として体験するなら、今参加できるものはある？",
            ToolFamily.CAST,
            ("cast_search",),
        ),
        ("理解の助けになる入門書を、3冊候補にして。", None, ()),
        (
            "その3冊、芝浦で今借りられる？",
            ToolFamily.LIBRARY,
            ("library_catalog_search", "library_item_read"),
        ),
        ("冊", None, ()),
        ("3冊", None, ()),
        ("その3冊", None, ()),
    ),
)
def test_router_handles_natural_language_intents_without_service_names(
    message: str,
    expected_family: ToolFamily | None,
    expected_prefix: tuple[str, ...],
) -> None:
    decision = select_client_tools(
        ToolSelectionContext(
            message=message,
            available_tools=frozenset(CHAT_TOOL_NAMES),
        )
    )

    if expected_family is None:
        assert decision.candidates == ()
        assert decision.reason_code == "general_no_tool"
    else:
        assert decision.families[0] == expected_family
        assert decision.candidates[: len(expected_prefix)] == expected_prefix


@pytest.mark.parametrize("message", ("冊", "3冊", "その3冊"))
@pytest.mark.parametrize(
    ("stale_message", "stale_family"),
    (
        ("SCombZの課題と締切を確認して", ToolFamily.SCOMBZ),
        ("CASTの求人を検索して", ToolFamily.CAST),
    ),
)
def test_router_does_not_reuse_stale_campus_context_for_book_count_fragments(
    message: str,
    stale_message: str,
    stale_family: ToolFamily,
) -> None:
    decision = select_client_tools(
        ToolSelectionContext(
            message=message,
            recent_messages=(stale_message,),
            available_tools=frozenset(CHAT_TOOL_NAMES),
            current_page_family=stale_family,
            last_tool_family=stale_family,
        )
    )

    assert decision.candidates == ()
    assert decision.reason_code == "general_no_tool"


@pytest.mark.parametrize(
    ("message", "recent_messages", "current_page_family", "last_tool_family", "expected_family"),
    (
        (
            "強化学習はどのあたり？ 授業全体での位置づけも知りたい。",
            ("SCombZの課題と締切を確認して",),
            ToolFamily.SCOMBZ,
            ToolFamily.SCOMBZ,
            ToolFamily.SYLLABUS,
        ),
        (
            "それを仕事として体験するなら、今参加できるものはある？",
            ("強化学習のシラバスを確認して",),
            ToolFamily.SYLLABUS,
            ToolFamily.SYLLABUS,
            ToolFamily.CAST,
        ),
        (
            "https://example.edu/public/page を読んで",
            ("CASTの求人を検索して",),
            ToolFamily.CAST,
            ToolFamily.CAST,
            ToolFamily.BROWSER,
        ),
        (
            "人工知能の授業では、どんなことを学ぶの？",
            ("https://example.edu/public/page を読んで",),
            ToolFamily.BROWSER,
            ToolFamily.BROWSER,
            ToolFamily.SCOMBZ,
        ),
    ),
)
def test_router_latest_explicit_intent_beats_stale_family_context(
    message: str,
    recent_messages: tuple[str, ...],
    current_page_family: ToolFamily,
    last_tool_family: ToolFamily,
    expected_family: ToolFamily,
) -> None:
    decision = select_client_tools(
        ToolSelectionContext(
            message=message,
            recent_messages=recent_messages,
            available_tools=frozenset(CHAT_TOOL_NAMES),
            current_page_family=current_page_family,
            last_tool_family=last_tool_family,
        )
    )

    assert decision.reason_code == "explicit_intent"
    assert decision.families[0] == expected_family


def test_catalog_marks_sitrus_as_explicit_live_personal_context() -> None:
    spec = TOOL_SPEC_BY_NAME["sitrus_read"]
    assert spec.external_model_allowed is True
    assert spec.availability == "live_sitrus"
