from typing import Any, cast

import pytest
from orbit_api.agent.openai_backend import OpenAIAgent
from orbit_api.agent.pydantic_ai_backend import (
    BROWSER_READ_TOOL_NAME,
    ChatDraft,
    browser_read_url,
)
from orbit_api.models import (
    BrowserReadResult,
    ChatToolResultRequest,
    EvidenceLink,
)
from pydantic import ValidationError
from pydantic_ai import Agent, DeferredToolRequests, ModelResponse, ToolCallPart
from pydantic_ai.models.function import FunctionModel


def test_browser_result_rejects_raw_markup_and_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        BrowserReadResult(
            status="known",
            url="https://example.com",
            text="<script>alert(1)</script>",
        )
    with pytest.raises(ValidationError):
        ChatToolResultRequest(
            tool_call_id="call-1",
            name=BROWSER_READ_TOOL_NAME,
            version=1,
            result=cast(Any, {
                "status": "known",
                "url": "https://example.com",
                "text": "safe",
                "unknown": "must-reject",
            }),
        )
    with pytest.raises(ValidationError):
        BrowserReadResult(
            status="known",
            url="javascript:alert(1)",
            text="safe",
        )
    with pytest.raises(ValidationError):
        BrowserReadResult(
            status="known",
            url="https://example.com",
            text="safe",
            links=cast(Any, [{"label": "unsafe", "url": "javascript:alert(1)"}]),
        )


@pytest.mark.asyncio
async def test_function_model_preserves_browser_url_arguments(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    calls = [0]

    def model_function(_messages, _info):
        calls[0] += 1
        if calls[0] == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        BROWSER_READ_TOOL_NAME,
                        {"url": "https://example.com/course"},
                        tool_call_id="browser-call-1",
                    )
                ]
            )
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "final_result",
                    {
                        "content_markdown": "公開ページを確認しました。",
                        "evidence_ids": ["browser-read-v1-run"],
                    },
                    tool_call_id="final-1",
                )
            ]
        )

    model = FunctionModel(model_function, model_name="browser-test")
    agent = Agent(
        model,
        output_type=[ChatDraft, DeferredToolRequests],
        instructions="test",
        tools=[browser_read_url],
    )
    backend = OpenAIAgent(api_key="synthetic-key", model="synthetic-model")
    backend._chat_agent = lambda *, advertised_tools: agent  # type: ignore[method-assign]
    first = await backend.start_chat(
        conversation_id="conversation-browser",
        message="公開ページを確認して",
        history=[],
        advertised_tools={BROWSER_READ_TOOL_NAME},
    )
    assert first.deferred is not None
    assert first.deferred.arguments == {"url": "https://example.com/course"}
    evidence = EvidenceLink(
        evidence_id="browser-read-v1-run",
        title="Webページ",
        source_type="web",
        locator="orbit-browser://read/1234567890abcdef",
        data_classification="public",
    )
    second = await backend.resume_chat(
        deferred=first.deferred,
        tool_result=BrowserReadResult(
            status="known",
            url="https://example.com/course",
            title="Course",
            text="公開された説明",
            links=[],
            data_classification="public",
        ),
        context=[evidence],
        advertised_tools={BROWSER_READ_TOOL_NAME},
        seen_tool_call_ids=set(),
    )
    assert second.draft is not None
    assert second.draft.evidence_ids == ["browser-read-v1-run"]
