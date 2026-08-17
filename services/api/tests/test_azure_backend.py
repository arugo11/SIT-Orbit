from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from orbit_api.agent.azure_openai_backend import AzureOpenAIAgent
from orbit_api.agent.factory import get_agent_backend
from orbit_api.agent.fixture import FixtureAgent
from orbit_api.models import ActionProposal, EvidenceLink, OrbitEvent
from orbit_api.models.domain import DataClassification


def make_event(*, data_classification: DataClassification = "synthetic") -> OrbitEvent:
    return OrbitEvent(
        event_type="campus_entered",
        scenario_id="b1-omiya-calculus",
        campus="omiya",
        data_classification=data_classification,
    )


def make_evidence(*, data_classification: DataClassification = "synthetic") -> EvidenceLink:
    return EvidenceLink(
        evidence_id="ev-demo",
        title="合成データの根拠",
        source_type="assignment",
        locator="demo://evidence/1",
        data_classification=data_classification,
    )


@pytest.mark.parametrize(
    ("missing_variable", "message"),
    [
        ("AZURE_OPENAI_API_KEY", "AZURE_OPENAI_API_KEY"),
        ("AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_ENDPOINT"),
        ("AZURE_OPENAI_MODEL", "AZURE_OPENAI_MODEL"),
    ],
)
def test_azure_backend_missing_configuration_fails_closed(
    monkeypatch,
    missing_variable: str,
    message: str,
) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "azure_openai")
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com")
    monkeypatch.setenv("AZURE_OPENAI_MODEL", "demo-deployment")
    monkeypatch.delenv(missing_variable)

    with pytest.raises(RuntimeError, match=message):
        get_agent_backend()


def test_fixture_backend_does_not_select_azure_implicitly(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "fixture")
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "synthetic-test-key")
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com")
    monkeypatch.setenv("AZURE_OPENAI_MODEL", "demo-deployment")

    assert isinstance(get_agent_backend(), FixtureAgent)


@pytest.mark.asyncio
@pytest.mark.parametrize("location", ["event", "context"])
async def test_azure_backend_rejects_non_demo_data_before_network(
    monkeypatch,
    location: str,
) -> None:
    agent = AzureOpenAIAgent(
        api_key="synthetic-test-key",
        model="demo-deployment",
        endpoint="https://example.openai.azure.com",
    )
    parse = AsyncMock()
    monkeypatch.setattr(agent.client.responses, "parse", parse)

    event = make_event(data_classification="personal" if location == "event" else "synthetic")
    context = [
        make_evidence(data_classification="restricted" if location == "context" else "synthetic")
    ]

    with pytest.raises(ValueError, match="synthetic or public"):
        await agent.propose_action(event, context)

    parse.assert_not_awaited()


@pytest.mark.asyncio
async def test_azure_backend_preserves_structured_action_boundary(monkeypatch) -> None:
    agent = AzureOpenAIAgent(
        api_key="synthetic-test-key",
        model="demo-deployment",
        endpoint="https://example.openai.azure.com",
    )
    evidence = make_evidence()
    parsed = ActionProposal(
        action_id="provider-action-id",
        title="合成データを確認する",
        reason="次の一歩を確認するためです。",
        duration_minutes=10,
        evidence=[evidence],
        external_action="calendar_draft",
        requires_confirmation=True,
        prompt_version="openai-next-action-v1",
    )
    parse = AsyncMock(return_value=SimpleNamespace(output_parsed=parsed))
    monkeypatch.setattr(agent.client.responses, "parse", parse)

    proposal = await agent.propose_action(make_event(), [evidence])

    assert proposal.action_id.startswith("act-azure-openai-")
    assert proposal.evidence == [evidence]
    assert proposal.external_action == "calendar_draft"
    assert proposal.requires_confirmation is True
    call = parse.await_args
    assert call is not None
    assert call.kwargs["model"] == "demo-deployment"
    assert call.kwargs["store"] is False
    assert call.kwargs["text_format"] is ActionProposal


@pytest.mark.asyncio
async def test_azure_backend_rejects_missing_structured_output(monkeypatch) -> None:
    agent = AzureOpenAIAgent(
        api_key="synthetic-test-key",
        model="demo-deployment",
        endpoint="https://example.openai.azure.com",
    )
    parse = AsyncMock(return_value=SimpleNamespace(output_parsed=None))
    monkeypatch.setattr(agent.client.responses, "parse", parse)

    with pytest.raises(RuntimeError, match="Azure OpenAI returned no structured action proposal"):
        await agent.propose_action(make_event(), [make_evidence()])
