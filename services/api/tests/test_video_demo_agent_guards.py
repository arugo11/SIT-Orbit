from __future__ import annotations

import pytest
from orbit_api.agent.chat import FixtureChatBackend
from orbit_api.agent.native_tool_search import NativeToolSearchProfileError
from orbit_api.agent.pydantic_ai_backend import DeferredChatRun


@pytest.mark.asyncio
async def test_fixture_chat_does_not_reproduce_the_removed_demo_script() -> None:
    backend = FixtureChatBackend()
    for message in ("何ができるの？", "おすすめの本を探して", "未知の入力"):
        result = await backend.start_chat(
            conversation_id="removed-demo",
            message=message,
            history=[],
            advertised_tools={"general_web_search", "cast_search"},
        )
        assert result.draft is not None
        assert result.deferred is None


@pytest.mark.asyncio
async def test_fixture_resume_explicitly_explains_azure_requirement() -> None:
    with pytest.raises(ValueError, match="Azure backend"):
        await FixtureChatBackend().resume_chat(
            deferred=DeferredChatRun(
                messages=[],
                tool_call_id="call-1",
                conversation_id="removed-demo",
                tool_name="cast_search",
            ),
            tool_result=object(),
            context=[],
            advertised_tools={"cast_search"},
        )


def test_unsupported_native_profile_is_fail_closed() -> None:
    from orbit_api.agent.native_tool_search import build_native_tool_search_profile

    with pytest.raises(NativeToolSearchProfileError):
        build_native_tool_search_profile("gpt-5.6-sol")
