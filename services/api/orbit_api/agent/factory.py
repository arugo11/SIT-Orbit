import os

from .azure_openai_backend import AzureOpenAIAgent, build_azure_openai_agent
from .base import AgentBackend
from .chat import ChatBackend, FixtureChatBackend
from .fixture import FixtureAgent
from .runtime_profile import validate_runtime_backend


def _backend_name() -> str:
    backend = os.getenv("ORBIT_AGENT_BACKEND", "fixture")
    validate_runtime_backend(backend)
    return backend


def _build_provider_backend(backend: str) -> AzureOpenAIAgent:
    if backend == "azure_openai":
        return build_azure_openai_agent()
    raise RuntimeError(f"Unsupported ORBIT_AGENT_BACKEND: {backend}")


def get_agent_backend() -> AgentBackend:
    backend = _backend_name()
    if backend == "fixture":
        return FixtureAgent()
    return _build_provider_backend(backend)


def get_chat_backend() -> ChatBackend:
    """Build the Chat adapter using the same explicit backend switch."""

    backend = _backend_name()
    if backend == "fixture":
        return FixtureChatBackend()
    return _build_provider_backend(backend)
