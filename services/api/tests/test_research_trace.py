from __future__ import annotations

from dataclasses import dataclass

import pytest
from orbit_api.agent.openai_backend import OpenAIAgent
from orbit_api.agent.pydantic_ai_backend import (
    CAST_CAREER_SEARCH_TOOL_NAME,
    ChatDraft,
    ChatWebSearchState,
    ResearchTrace,
    can_search_public_web_with_context,
    cast_career_search,
    research_trace_for_message,
    tool_call_fingerprint,
)
from orbit_api.agent.web_search import (
    WebSearchResponse,
    WebSearchSource,
    validate_public_search_query,
)
from orbit_api.models import (
    CastCareerAggregate,
    CastCareerSearchResult,
    CastCareerSurfaceCoverage,
    EvidenceLink,
)
from orbit_api.models.agent import CastCareerSurface
from pydantic_ai import Agent, DeferredToolRequests, ModelResponse, ToolCallPart
from pydantic_ai.messages import ToolReturnPart
from pydantic_ai.models.function import FunctionModel


@dataclass
class _FakeWebSearchExecutor:
    calls: list[str]

    async def search(self, query: str) -> WebSearchResponse:
        self.calls.append(query)
        return WebSearchResponse(
            query=query,
            summary="公開情報の要約",
            sources=(
                WebSearchSource(
                    title="公開情報の出典",
                    url="https://www.shibaura-it.ac.jp/",
                ),
            ),
        )


def test_campus_career_question_requires_cast_without_cast_keyword() -> None:
    trace = research_trace_for_message(
        "MLエンジニアとしては芝浦工業大学は今までどのような人がいましたか?"
    )

    assert trace.required_sources == frozenset({"cast"})
    assert trace.preferred_sources == frozenset({"web"})
    assert trace.missing_required_sources == frozenset({"cast"})


def test_research_trace_tracks_failure_as_resolved_limitation() -> None:
    trace = ResearchTrace(required_sources=frozenset({"cast"}))
    failed = trace.mark_tool_result(CAST_CAREER_SEARCH_TOOL_NAME, "form_changed")

    assert failed.missing_required_sources == frozenset()
    assert failed.failed_sources == frozenset({"cast"})


def test_duplicate_tool_fingerprint_is_stable_for_mapping_order() -> None:
    first = tool_call_fingerprint("cast_career_search", {"b": 2, "a": [1, 2]})
    second = tool_call_fingerprint("cast_career_search", {"a": [1, 2], "b": 2})

    assert first == second
    assert len(first) == 64


def test_public_web_search_can_follow_aggregate_cast_only() -> None:
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
async def test_duplicate_public_search_fingerprint_is_rejected_without_second_call() -> None:
    executor = _FakeWebSearchExecutor(calls=[])
    state = ChatWebSearchState(executor=executor)

    first = await state.general_web_search("公開 AI 職種")
    second = await state.general_web_search("公開 AI 職種")

    assert first["status"] == "known"
    assert second["status"] == "rejected"
    assert second["reason_code"] == "public_query_rejected"
    assert executor.calls == ["公開 AI 職種"]


@pytest.mark.asyncio
async def test_research_loop_rejects_the_ninth_tool_without_provider_call() -> None:
    executor = _FakeWebSearchExecutor(calls=[])
    state = ChatWebSearchState(executor=executor, tool_call_count=8)

    with pytest.raises(RuntimeError, match="at most eight tools"):
        await state.general_web_search("公開 AI 職種")

    assert executor.calls == []


@pytest.mark.asyncio
async def test_campus_career_question_forces_cast_before_public_answer() -> None:
    def model_function(_messages, _info):
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "final_result",
                    {"content_markdown": "Webだけで回答", "evidence_ids": []},
                    tool_call_id="premature-final-1",
                )
            ]
        )

    agent = Agent(
        FunctionModel(model_function, model_name="mandatory-cast-gate-test"),
        output_type=[ChatDraft, DeferredToolRequests],
        instructions="test",
    )
    backend = OpenAIAgent(api_key="synthetic-key", model="synthetic-model")
    backend._chat_agent = lambda *, advertised_tools: agent  # type: ignore[method-assign]

    execution = await backend.start_chat(
        conversation_id="mandatory-cast-gate",
        message="MLエンジニアとしては芝浦工業大学は今までどのような人がいましたか?",
        history=[],
        advertised_tools={CAST_CAREER_SEARCH_TOOL_NAME},
    )

    assert execution.draft is None
    assert execution.deferred is not None
    assert execution.deferred.tool_name == CAST_CAREER_SEARCH_TOOL_NAME
    assert execution.deferred.arguments["surfaces"] == ["company", "hiring_record"]
    assert execution.deferred.arguments["filters"]["graduation_years"] == [
        2026,
        2025,
        2024,
        2023,
        2022,
    ]


@pytest.mark.asyncio
async def test_cast_then_public_web_search_completes_with_both_evidence_sources() -> None:
    calls = [0]
    executor = _FakeWebSearchExecutor(calls=[])

    def model_function(messages, _info):
        calls[0] += 1
        if calls[0] == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        CAST_CAREER_SEARCH_TOOL_NAME,
                        {
                            "query": "芝浦工業大学のMLエンジニアの就職先",
                            "surfaces": ["company", "hiring_record"],
                            "filters": {
                                "academic_programs": ["情報系"],
                                "graduation_years": [2026, 2025, 2024, 2023, 2022],
                            },
                            "limit": 10,
                            "exhaustive": False,
                        },
                        tool_call_id="cast-before-web-1",
                    )
                ]
            )
        if calls[0] == 2:
            cast_returns = [
                part
                for message in messages
                for part in message.parts
                if isinstance(part, ToolReturnPart)
                and part.tool_name == CAST_CAREER_SEARCH_TOOL_NAME
            ]
            assert len(cast_returns) == 1
            cast_content = cast_returns[0].content
            assert isinstance(cast_content, dict)
            cast_projection = cast_content.get("cast_career_search")
            assert isinstance(cast_projection, dict)
            assert cast_projection.get("status") == "known"
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        "general_web_search",
                        {"query": "ML engineer software robotics job roles"},
                        tool_call_id="web-after-cast-1",
                    )
                ]
            )
        web_returns = [
            part
            for message in messages
            for part in message.parts
            if isinstance(part, ToolReturnPart) and part.tool_name == "general_web_search"
        ]
        assert len(web_returns) == 1
        web_content = web_returns[0].content
        assert isinstance(web_content, dict)
        web_sources = web_content.get("sources")
        assert isinstance(web_sources, list) and web_sources
        first_source = web_sources[0]
        assert isinstance(first_source, dict)
        web_evidence_id = first_source.get("evidence_id")
        assert isinstance(web_evidence_id, str)
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "final_result",
                    {
                        "content_markdown": "CASTと公開Webを組み合わせて確認しました。",
                        "evidence_ids": [
                            "cast-career-search-v1-cast1234567890abcd",
                            web_evidence_id,
                        ],
                    },
                    tool_call_id="cast-web-final-1",
                )
            ]
        )

    def make_agent(*, advertised_tools, web_search_state=None):
        del advertised_tools
        tools = [cast_career_search]
        if web_search_state is not None:
            tools.append(web_search_state.general_web_search)
        return Agent(
            FunctionModel(model_function, model_name="cast-web-loop-test"),
            output_type=[ChatDraft, DeferredToolRequests],
            instructions="test",
            tools=tools,
        )

    backend = OpenAIAgent(
        api_key="synthetic-key",
        model="synthetic-model",
        provider_name="Azure OpenAI",
    )
    backend.web_search_executor = executor
    backend._chat_agent = make_agent  # type: ignore[method-assign]
    first = await backend.start_chat(
        conversation_id="cast-web-loop",
        message="MLエンジニアとしては芝浦工業大学は今までどのような人がいましたか?",
        history=[],
        advertised_tools={CAST_CAREER_SEARCH_TOOL_NAME},
    )

    assert first.deferred is not None
    cast_evidence = EvidenceLink(
        evidence_id="cast-career-search-v1-cast1234567890abcd",
        title="CAST横断検索の匿名集計",
        source_type="career",
        locator="orbit-cast://career-search/cast1234567890abcdef",
        data_classification="personal",
    )
    surfaces: list[CastCareerSurface] = ["company", "hiring_record"]
    cast_result = CastCareerSearchResult(
        status="known",
        searched_surfaces=surfaces,
        surface_coverage=[
            CastCareerSurfaceCoverage(
                surface=surface,
                status="known",
                total_count=8,
                returned_count=8,
                fetched_pages=1,
                page_size=10,
                reason_code=None,
            )
            for surface in surfaces
        ],
        total_count=16,
        returned_count=16,
        anonymous_aggregates=[
            CastCareerAggregate(dimension="surface", value="company", count=8),
            CastCareerAggregate(dimension="industry", value="情報通信", count=8),
        ],
        evidence_ids=[],
        reason_codes=[],
    )
    completed = await backend.resume_chat(
        deferred=first.deferred,
        tool_result=cast_result,
        context=[cast_evidence],
        advertised_tools={CAST_CAREER_SEARCH_TOOL_NAME},
    )

    assert completed.draft is not None
    assert len(completed.draft.evidence_ids) == 2
    assert completed.draft.evidence_ids[0] == cast_evidence.evidence_id
    assert completed.draft.evidence_ids[1].startswith("web-search-v1-")
    assert executor.calls == ["ML engineer software robotics job roles"]


@pytest.mark.parametrize(
    "query",
    [
        "先輩-K7F2 の就職先",
        "2024 情報系学科の卒業生",
        "cast-career-search-v1-1234567890abcdef の詳細",
        "company_code=secret の企業",
    ],
)
def test_public_web_search_rejects_cast_private_identifiers(query: str) -> None:
    with pytest.raises(ValueError):
        validate_public_search_query(query)
