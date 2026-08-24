"""OpenAI provider construction for the shared PydanticAI adapter."""

import os
from collections.abc import Callable

from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.usage import RunUsage

from .pydantic_ai_backend import PydanticAIAgentBackend


class OpenAIAgent(PydanticAIAgentBackend):
    """OpenAI Responses API backend with a stable legacy class name."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str | None = None,
        provider_name: str = "OpenAI",
        action_id_prefix: str = "act-openai",
        usage_callback: Callable[[RunUsage], None] | None = None,
    ) -> None:
        if os.getenv("ORBIT_BOOK_DISCOVERY", "off") != "off":
            raise RuntimeError(
                "ORBIT_BOOK_DISCOVERY is available only with azure_openai."
            )
        provider = OpenAIProvider(base_url=base_url, api_key=api_key)
        super().__init__(
            model_name=model,
            provider=provider,
            provider_name=provider_name,
            action_id_prefix=action_id_prefix,
            usage_callback=usage_callback,
        )


def build_openai_agent() -> OpenAIAgent:
    api_key = os.getenv("OPENAI_API_KEY")
    model = os.getenv("OPENAI_MODEL")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required for ORBIT_AGENT_BACKEND=openai.")
    if not model:
        raise RuntimeError("OPENAI_MODEL is required for ORBIT_AGENT_BACKEND=openai.")
    return OpenAIAgent(api_key=api_key, model=model)


__all__ = ["OpenAIAgent", "build_openai_agent"]
