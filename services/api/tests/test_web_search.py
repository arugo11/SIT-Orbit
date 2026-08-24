from __future__ import annotations

from dataclasses import dataclass

import pytest
from orbit_api.agent.azure_openai_backend import AzureOpenAIAgent
from orbit_api.agent.chat import ChatRunService
from orbit_api.agent.openai_backend import OpenAIAgent
from orbit_api.agent.pydantic_ai_backend import (
    MY_LIBRARY_TOOL_NAME,
    ChatDraft,
    ChatWebSearchState,
    my_library_read,
)
from orbit_api.agent.web_search import (
    AzureNativeWebSearchExecutor,
    WebSearchResponse,
    WebSearchSource,
    _normalize_sources,
    normalize_public_source_url,
    validate_public_search_query,
)
from orbit_api.models import (
    ChatRunCompleted,
    ChatRunRequest,
    EvidenceLink,
    MyLibraryItem,
    ScopedMyLibraryReadResult,
)
from pydantic_ai import Agent, DeferredToolRequests, ModelResponse, ToolCallPart
from pydantic_ai.messages import NativeToolReturnPart, ToolReturnPart
from pydantic_ai.models.function import FunctionModel


@dataclass
class FakeWebSearchExecutor:
    calls: list[str]

    async def search(self, query: str) -> WebSearchResponse:
        self.calls.append(query)
        return WebSearchResponse(
            query=query,
            summary="芝浦工業大学の公開情報を確認しました。",
            sources=(
                WebSearchSource(
                    title="芝浦工業大学 公式サイト",
                    url="https://www.shibaura-it.ac.jp/",
                ),
            ),
        )


@pytest.mark.parametrize(
    "query",
    [
        "al23088@sic.shibaura-it.ac.jp の情報",
        "AL23088 の成績",
        "oauth token=secret",
        "orbit-sitrus://grades/opaque",
        "scombz.shibaura-it.ac.jp の課題",
    ],
)
def test_public_search_query_rejects_private_values(query: str) -> None:
    with pytest.raises(ValueError):
        validate_public_search_query(query)


def test_public_search_query_normalizes_public_text() -> None:
    assert validate_public_search_query("  芝浦工業大学   AI 研究  ") == "芝浦工業大学 AI 研究"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (
            "https://example.com/article?q=orbit&utm_source=test#section",
            "https://example.com/article?q=orbit",
        ),
        ("http://localhost/private", None),
        ("https://127.0.0.1/private", None),
        ("javascript:alert(1)", None),
    ],
)
def test_source_url_normalization(raw: str, expected: str | None) -> None:
    assert normalize_public_source_url(raw) == expected


def test_search_sources_are_deduplicated_and_limited_to_ten() -> None:
    sources = [
        {"url": f"https://example.com/{index}", "title": f"Source {index}"}
        for index in range(12)
    ]
    sources.insert(1, {"url": "https://example.com/0#duplicate", "title": "duplicate"})
    messages = [
        ModelResponse(
            parts=[
                NativeToolReturnPart(
                    tool_name="web_search",
                    tool_call_id="native-search-1",
                    content={"status": "completed", "sources": sources},
                )
            ]
        )
    ]

    normalized = _normalize_sources(messages)

    assert len(normalized) == 10
    assert normalized[0].url == "https://example.com/0"
    assert len({source.url for source in normalized}) == 10


@pytest.mark.asyncio
async def test_ninth_search_call_is_rejected_without_invoking_executor() -> None:
    executor = FakeWebSearchExecutor(calls=[])
    state = ChatWebSearchState(executor=executor, tool_call_count=8)

    with pytest.raises(RuntimeError, match="at most eight tools"):
        await state.general_web_search("芝浦工業大学 AI研究")

    assert executor.calls == []


@pytest.mark.asyncio
async def test_chat_runs_server_search_and_restores_evidence(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    executor = FakeWebSearchExecutor(calls=[])
    call_count = 0

    def model_function(messages, _info):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        "general_web_search",
                        {"query": "芝浦工業大学 AI 研究"},
                        tool_call_id="web-search-call-1",
                    )
                ]
            )
        tool_returns = [
            part
            for message in messages
            for part in message.parts
            if isinstance(part, ToolReturnPart)
            and part.tool_name == "general_web_search"
        ]
        assert len(tool_returns) == 1
        content = tool_returns[0].content
        assert isinstance(content, dict)
        sources = content["sources"]
        assert isinstance(sources, list)
        evidence_id = sources[0]["evidence_id"]
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "final_result",
                    {
                        "content_markdown": "公開情報を確認しました。",
                        "evidence_ids": [evidence_id],
                    },
                    tool_call_id="final-result-1",
                )
            ]
        )

    backend = OpenAIAgent(api_key="synthetic-key", model="synthetic-model")
    backend.model = FunctionModel(model_function, model_name="web-search-test")  # type: ignore[assignment]
    backend.web_search_executor = executor
    service = ChatRunService(backend_factory=lambda: backend)

    response = await service.start(
        ChatRunRequest(
            conversation_id="conversation-web-search",
            message="芝浦工業大学のAI研究をWeb検索して",
            history=[],
            client_tools=[],
        )
    )

    assert isinstance(response, ChatRunCompleted)
    assert executor.calls == ["芝浦工業大学 AI 研究"]
    assert len(response.message.evidence) == 1
    assert response.message.evidence[0].evidence_id.startswith("web-search-v1-")
    assert response.message.evidence[0].locator == "https://www.shibaura-it.ac.jp/"


@pytest.mark.asyncio
async def test_book_recommendation_allows_public_search_after_my_library_result(
    monkeypatch,
) -> None:
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    executor = FakeWebSearchExecutor(calls=[])
    calls = 0

    def model_function(messages, _info):
        nonlocal calls
        calls += 1
        if calls == 1:
            return ModelResponse(
                parts=[ToolCallPart(MY_LIBRARY_TOOL_NAME, {}, tool_call_id="library-1")]
            )
        if calls == 2:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        "general_web_search",
                        {"query": "GPU LLM software design books"},
                        tool_call_id="web-search-1",
                    )
                ]
            )
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "final_result",
                    {
                        "content_markdown": "公開検索に基づく推薦です。",
                        "evidence_ids": [
                            "web-search-v1-search-1-1",
                        ],
                    },
                    tool_call_id="final-recommendation-1",
                )
            ]
        )

    def make_agent(*, advertised_tools, web_search_state=None):
        del advertised_tools
        tools = [my_library_read]
        if web_search_state is not None:
            tools.append(web_search_state.general_web_search)
        return Agent(
            FunctionModel(model_function, model_name="recommendation-test"),
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
        conversation_id="conversation-book-recommendation",
        message="借りている本に関連して面白そうな本をおすすめして",
        history=[],
        advertised_tools={MY_LIBRARY_TOOL_NAME},
    )
    assert first.deferred is not None
    assert first.deferred.allow_personal_web_search is True

    result = ScopedMyLibraryReadResult(
        status="known",
        scope="current_loans",
        items=[
            MyLibraryItem(
                resource_ref="orbit-library://record/1234567890abcdef",
                title="合成貸出資料",
                author="公開著者",
                status="loaned",
                due_date="2026-09-01",
                renewable=True,
                activity_date=None,
                request_type=None,
            )
        ],
        total_count=1,
        next_offset=None,
        loan_count=1,
        reservation_count=None,
        overdue_count=0,
        renewable_count=1,
        earliest_due_date="2026-09-01",
        reason_code=None,
    )
    evidence = EvidenceLink(
        evidence_id="my-library-summary-v1-recommendation",
        title="My Library概要",
        source_type="library",
        locator="orbit-library://summary/1234567890abcdef",
        data_classification="personal",
    )
    completed = await backend.resume_chat(
        deferred=first.deferred,
        tool_result=result,
        context=[evidence],
        advertised_tools={MY_LIBRARY_TOOL_NAME},
    )

    assert completed.draft is not None
    assert executor.calls == ["GPU LLM software design books"]


def test_web_search_is_azure_only(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_WEB_SEARCH", "azure")
    azure = AzureOpenAIAgent(
        api_key="synthetic-key",
        model="synthetic-model",
        endpoint="https://example-resource.openai.azure.com",
    )
    openai = OpenAIAgent(api_key="synthetic-key", model="synthetic-model")

    assert isinstance(azure.web_search_executor, AzureNativeWebSearchExecutor)
    assert openai.web_search_executor is None


def test_invalid_web_search_mode_fails_closed(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_WEB_SEARCH", "duckduckgo")
    with pytest.raises(RuntimeError, match="ORBIT_WEB_SEARCH"):
        AzureOpenAIAgent(
            api_key="synthetic-key",
            model="synthetic-model",
            endpoint="https://example-resource.openai.azure.com",
        )
