from __future__ import annotations

from dataclasses import dataclass

import pytest
from orbit_api.agent.azure_openai_backend import AzureOpenAIAgent
from orbit_api.agent.chat import ChatRunService
from orbit_api.agent.openai_backend import OpenAIAgent
from orbit_api.agent.pydantic_ai_backend import ChatWebSearchState
from orbit_api.agent.web_search import (
    AzureNativeWebSearchExecutor,
    WebSearchResponse,
    WebSearchSource,
    _normalize_sources,
    normalize_public_source_url,
    validate_public_search_query,
)
from orbit_api.models import ChatRunCompleted, ChatRunRequest
from pydantic_ai import ModelResponse, ToolCallPart
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
