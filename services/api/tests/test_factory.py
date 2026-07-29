import pytest
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
