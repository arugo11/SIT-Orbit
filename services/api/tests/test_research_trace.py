from dataclasses import dataclass

import pytest
from orbit_api.agent.pydantic_ai_backend import (
    CAST_CAREER_SEARCH_TOOL_NAME,
    ChatWebSearchState,
    ResearchTrace,
    can_search_public_web_with_context,
    research_trace_for_message,
    tool_call_fingerprint,
)
from orbit_api.agent.web_search import WebSearchResponse, WebSearchSource
from orbit_api.models import EvidenceLink


@dataclass
class _FakeWebSearchExecutor:
    calls: list[str]

    async def search(self, query: str) -> WebSearchResponse:
        self.calls.append(query)
        return WebSearchResponse(
            query=query,
            summary="公開情報の要約",
            sources=(WebSearchSource(title="公開情報の出典", url="https://www.shibaura-it.ac.jp/"),),
        )


def test_research_trace_does_not_classify_user_wording() -> None:
    trace = research_trace_for_message("CASTとの連携機能では何ができる？")
    assert trace.request_message.startswith("CAST")
    assert trace.resolved_sources == frozenset()
    assert trace.failed_sources == frozenset()


def test_research_trace_records_only_observed_tool_results() -> None:
    trace = ResearchTrace()
    observed = trace.mark_tool_result(CAST_CAREER_SEARCH_TOOL_NAME, "form_changed")
    assert observed.resolved_sources == frozenset({"cast"})
    assert observed.failed_sources == frozenset({"cast"})


def test_duplicate_tool_fingerprint_is_stable_for_mapping_order() -> None:
    first = tool_call_fingerprint("cast_career_search", {"b": 2, "a": [1, 2]})
    second = tool_call_fingerprint("cast_career_search", {"a": [1, 2], "b": 2})
    assert first == second
    assert len(first) == 64


def test_public_web_search_requires_safe_public_or_aggregate_context() -> None:
    cast_evidence = EvidenceLink(
        evidence_id="cast-career-search-v1-1234567890abcdef",
        title="CAST横断検索から導出した匿名集計",
        source_type="career",
        locator="orbit-cast://career-search/1234567890abcdef",
        data_classification="personal",
    )
    private_evidence = EvidenceLink(
        evidence_id="scombz-read-v1-1234567890abcdef",
        title="SCombZから取得した表示情報",
        source_type="scombz",
        locator="orbit-scombz://read/1234567890abcdef",
        data_classification="personal",
    )
    assert can_search_public_web_with_context([cast_evidence]) is True
    assert can_search_public_web_with_context([cast_evidence, private_evidence]) is False


@pytest.mark.asyncio
async def test_duplicate_public_search_is_rejected_without_second_call() -> None:
    executor = _FakeWebSearchExecutor(calls=[])
    state = ChatWebSearchState(executor=executor)
    first = await state.general_web_search("公開 AI 職種")
    second = await state.general_web_search("公開 AI 職種")
    assert first["status"] == "known"
    assert second["status"] == "rejected"
    assert executor.calls == ["公開 AI 職種"]


@pytest.mark.asyncio
async def test_web_search_budget_is_eight_external_calls() -> None:
    executor = _FakeWebSearchExecutor(calls=[])
    state = ChatWebSearchState(executor=executor, tool_call_count=8)
    with pytest.raises(RuntimeError, match="at most eight tools"):
        await state.general_web_search("公開 AI 職種")
    assert executor.calls == []
