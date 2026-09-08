import pytest
from orbit_api.agent.azure_openai_backend import AzureOpenAIAgent
from orbit_api.agent.chat import FixtureChatBackend
from orbit_api.agent.factory import get_agent_backend, get_chat_backend
from orbit_api.agent.fixture import FixtureAgent


def test_fixture_is_default(monkeypatch) -> None:
    monkeypatch.delenv("ORBIT_AGENT_BACKEND", raising=False)
    monkeypatch.delenv("ORBIT_RUNTIME_PROFILE", raising=False)
    assert isinstance(get_agent_backend(), FixtureAgent)
    assert isinstance(get_chat_backend(), FixtureChatBackend)


def test_demo_profile_requires_fixture_backend(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_RUNTIME_PROFILE", "demo")
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "azure_openai")

    with pytest.raises(RuntimeError, match="demo requires.*fixture"):
        get_chat_backend()


def test_production_profile_rejects_fixture_backend(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_RUNTIME_PROFILE", "production")
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "fixture")

    with pytest.raises(RuntimeError, match="production cannot use.*fixture"):
        get_chat_backend()


def test_unknown_backend_is_rejected_consistently(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "unknown")

    with pytest.raises(RuntimeError, match="either 'fixture' or 'azure_openai'"):
        get_agent_backend()
    with pytest.raises(RuntimeError, match="either 'fixture' or 'azure_openai'"):
        get_chat_backend()


def test_removed_openai_backend_is_rejected(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "openai")

    with pytest.raises(RuntimeError, match="either 'fixture' or 'azure_openai'"):
        get_agent_backend()


def test_azure_openai_requires_explicit_configuration(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "azure_openai")
    monkeypatch.delenv("AZURE_OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com")
    monkeypatch.setenv("AZURE_OPENAI_MODEL", "gpt-5-6-terra")
    monkeypatch.setenv("AZURE_OPENAI_BASE_MODEL", "gpt-5.6-terra")

    with pytest.raises(RuntimeError, match="AZURE_OPENAI_API_KEY"):
        get_agent_backend()


def test_azure_openai_uses_v1_endpoint(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "azure_openai")
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com/")
    monkeypatch.setenv("AZURE_OPENAI_MODEL", "gpt-5-6-terra")
    monkeypatch.setenv("AZURE_OPENAI_BASE_MODEL", "gpt-5.6-terra")

    agent = get_agent_backend()

    assert isinstance(agent, AzureOpenAIAgent)
    assert str(agent.client.base_url) == "https://example.openai.azure.com/openai/v1/"
    assert agent.model_name == "gpt-5-6-terra"
    assert agent.model.settings == {"openai_store": False}
