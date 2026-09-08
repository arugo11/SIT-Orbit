"""Empty injected stores must retain their configured lifecycle and ownership."""

from unittest.mock import Mock

from orbit_api.agent.chat import ChatRunService, ChatRunStore
from orbit_api.agent.runs import AgentRunService, RunStore


def test_agent_service_preserves_empty_injected_store() -> None:
    store = RunStore(ttl_seconds=1)
    service = AgentRunService(store=store, backend_factory=Mock())

    assert service.store is store


def test_chat_service_preserves_empty_injected_store() -> None:
    store = ChatRunStore(ttl_seconds=1)
    service = ChatRunService(store=store, backend_factory=Mock())

    assert service.store is store
