from __future__ import annotations

import pytest
from orbit_api.agent.chat import FixtureChatBackend
from orbit_api.models import ChatClientTool, ChatRunCompleted, ChatRunRequest


@pytest.mark.asyncio
async def test_chat_fixture_is_not_a_natural_language_demo() -> None:
    backend = FixtureChatBackend()
    response = await backend.start_chat(
        conversation_id="fixture",
        message="CASTとの連携機能では何ができる？",
        history=[],
        advertised_tools={"cast_search", "scombz_course_list"},
    )
    assert response.draft is not None
    assert response.deferred is None
    assert response.generated_evidence == []
    assert "一般的なTool選択を再現しません" in response.draft.content_markdown


@pytest.mark.asyncio
async def test_chat_fixture_service_returns_generic_response_for_unknown_input() -> None:
    from orbit_api.agent.chat import ChatRunService

    service = ChatRunService(backend_factory=FixtureChatBackend)
    response = await service.start(
        ChatRunRequest(
            conversation_id="fixture-unknown",
            message="これは脚本外の入力です",
            client_tools=[ChatClientTool(name="cast_search", version=1)],
        )
    )
    assert isinstance(response, ChatRunCompleted)
    assert response.message.content_markdown == FixtureChatBackend._MESSAGE
    assert response.message.evidence == []
