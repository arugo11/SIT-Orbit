import pytest
from orbit_api.agent.azure_openai_backend import AzureOpenAIAgent
from orbit_api.agent.factory import get_agent_backend
from orbit_api.agent.fixture import FixtureAgent


def test_fixture_is_default(monkeypatch) -> None:
    monkeypatch.delenv("ORBIT_AGENT_BACKEND", raising=False)
    assert isinstance(get_agent_backend(), FixtureAgent)


def test_openai_requires_api_key(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "openai")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_MODEL", "demo-model")

    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        get_agent_backend()


def test_azure_openai_requires_explicit_configuration(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "azure_openai")
    monkeypatch.delenv("AZURE_OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com")
    monkeypatch.setenv("AZURE_OPENAI_MODEL", "demo-deployment")

    with pytest.raises(RuntimeError, match="AZURE_OPENAI_API_KEY"):
        get_agent_backend()


def test_azure_openai_uses_v1_endpoint(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "azure_openai")
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com/")
    monkeypatch.setenv("AZURE_OPENAI_MODEL", "demo-deployment")

    agent = get_agent_backend()

    assert isinstance(agent, AzureOpenAIAgent)
    assert str(agent.client.base_url) == "https://example.openai.azure.com/openai/v1/"
    assert agent.model == "demo-deployment"
