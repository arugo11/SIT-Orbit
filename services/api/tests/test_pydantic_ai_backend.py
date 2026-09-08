from __future__ import annotations

from types import SimpleNamespace

import pydantic_ai.models
import pytest
from orbit_api.agent.azure_openai_backend import AzureOpenAIAgent
from orbit_api.agent.native_tool_search import (
    TOOL_ADDITION_MODE,
    TOOL_DEFERRAL_MODE,
)
from orbit_api.agent.pydantic_ai_backend import (
    CALENDAR_AVAILABILITY_LOCATOR_PREFIX,
    CALENDAR_TOOL_NAME,
    ActionDraft,
    PydanticAIAgentBackend,
    _discovered_tools_from_result,
)
from orbit_api.models import (
    CalendarAvailabilityInterval,
    CalendarAvailabilityResult,
    EvidenceLink,
    OrbitEvent,
)
from pydantic_ai import Agent, CallDeferred, DeferredToolRequests
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    NativeToolSearchReturnPart,
    ToolAvailabilityDeltaPart,
    ToolCallPart,
    ToolReturnPart,
    ToolSearchMatch,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.openai import OpenAIResponsesModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.providers.azure import AzureProvider
from pydantic_ai.usage import RunUsage


def make_event() -> OrbitEvent:
    return OrbitEvent(
        event_type="campus_entered",
        scenario_id="b1-omiya-calculus",
        campus="omiya",
        data_classification="synthetic",
    )


def make_evidence(evidence_id: str = "ev-assignment") -> EvidenceLink:
    return EvidenceLink(
        evidence_id=evidence_id,
        title="合成データの課題根拠",
        source_type="assignment",
        locator="demo://assignment/calculus-1",
        data_classification="synthetic",
    )


def action_args(*evidence_ids: str) -> dict[str, object]:
    return {
        "title": "合成関数の微分を確認する",
        "reason": "合成fixtureの空き時間に収まるためです。",
        "duration_minutes": 12,
        "external_action": "checklist_update",
        "requires_confirmation": True,
        "evidence_ids": list(evidence_ids),
    }


async def google_calendar_availability() -> CalendarAvailabilityResult:
    raise CallDeferred()


def azure_backend(*, usage_callback=None) -> AzureOpenAIAgent:
    return AzureOpenAIAgent(
        api_key="synthetic-test-key",
        model="gpt-5-6-terra",
        endpoint="https://example.openai.azure.com",
        base_model="gpt-5.6-terra",
        usage_callback=usage_callback,
    )


def test_action_agent_with_test_model_advertises_only_connected_calendar() -> None:
    async def run() -> None:
        for calendar_connected, expected_tools in ((False, []), (True, [CALENDAR_TOOL_NAME])):
            model = TestModel(call_tools=[])
            agent = Agent(
                model,
                output_type=[ActionDraft, DeferredToolRequests],
                instructions="test",
                tools=[google_calendar_availability] if calendar_connected else [],
            )
            result = await agent.run("synthetic proposal")
            assert isinstance(result.output, ActionDraft)
            assert model.last_model_request_parameters is not None
            assert [
                tool.name for tool in model.last_model_request_parameters.declared_function_tools
            ] == expected_tools

    import asyncio

    asyncio.run(run())


@pytest.mark.asyncio
async def test_action_proposal_keeps_server_owned_evidence() -> None:
    backend = azure_backend()
    evidence = make_evidence()
    model = TestModel(custom_output_args=action_args(evidence.evidence_id))
    test_agent = Agent(
        model,
        output_type=[ActionDraft, DeferredToolRequests],
        instructions="test",
    )
    backend._agent = lambda *, advertised_tools: test_agent  # type: ignore[method-assign]
    proposal = await backend.propose_action(make_event(), [evidence])
    assert proposal.action_id.startswith("act-azure-openai-")
    assert proposal.evidence == [evidence]
    assert proposal.requires_confirmation is True


@pytest.mark.asyncio
async def test_unknown_evidence_id_is_rejected() -> None:
    backend = azure_backend()
    model = TestModel(custom_output_args=action_args("ev-not-supplied"))
    test_agent = Agent(model, output_type=[ActionDraft, DeferredToolRequests], instructions="test")
    backend._agent = lambda *, advertised_tools: test_agent  # type: ignore[method-assign]
    with pytest.raises(ValueError, match="unknown evidence IDs"):
        await backend.propose_action(make_event(), [make_evidence()])


@pytest.mark.asyncio
async def test_usage_callback_receives_aggregate_usage() -> None:
    usages: list[RunUsage] = []
    backend = azure_backend(usage_callback=usages.append)
    evidence = make_evidence()
    test_agent = Agent(
        TestModel(custom_output_args=action_args(evidence.evidence_id)),
        output_type=[ActionDraft, DeferredToolRequests],
        instructions="test",
    )
    backend._agent = lambda *, advertised_tools: test_agent  # type: ignore[method-assign]
    await backend.propose_action(make_event(), [evidence])
    assert len(usages) == 1
    assert usages[0].requests == 1


@pytest.mark.asyncio
async def test_deferred_calendar_result_is_minimized_before_resume() -> None:
    requests: list[list[ModelMessage]] = []

    def model_function(messages: list[ModelMessage], _: AgentInfo) -> ModelResponse:
        requests.append(messages)
        if len(requests) == 1:
            return ModelResponse(
                parts=[
                    # Action Agent's deferred boundary intentionally remains
                    # independent from Chat's native Tool Search.
                    ToolCallPart(
                        CALENDAR_TOOL_NAME, {}, tool_call_id="calendar-call-1"
                    )
                ]
            )
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "final_result",
                    action_args("ev-assignment", "calendar-availability-v1-run-1"),
                    tool_call_id="proposal-call-1",
                )
            ]
        )

    model = FunctionModel(model_function, model_name="deterministic-action-test")
    test_agent = Agent(
        model,
        output_type=[ActionDraft, DeferredToolRequests],
        instructions="test",
        tools=[google_calendar_availability],
    )
    backend = azure_backend()
    backend._agent = lambda *, advertised_tools: test_agent  # type: ignore[method-assign]
    evidence = make_evidence()
    calendar_evidence = EvidenceLink(
        evidence_id="calendar-availability-v1-run-1",
        title="Google Calendarから導出した空き時間",
        source_type="calendar",
        locator=f"{CALENDAR_AVAILABILITY_LOCATOR_PREFIX}derived-availability-1",
        data_classification="personal",
    )
    calendar_result = CalendarAvailabilityResult(
        status="known",
        time_zone="Asia/Tokyo",
        window_start="2026-08-17T00:00:00+09:00",
        window_end="2026-08-24T00:00:00+09:00",
        available_minutes=10080,
        busy_minutes=0,
        free_intervals=[
            CalendarAvailabilityInterval(
                start="2026-08-17T00:00:00+09:00",
                end="2026-08-24T00:00:00+09:00",
            )
        ],
        reason_code=None,
    )
    proposal, deferred = await backend.start_run(
        make_event(), [evidence], calendar_connected=True
    )
    assert proposal is None and deferred is not None
    resumed = await backend.resume_run(
        make_event(), [evidence, calendar_evidence], deferred, calendar_result
    )
    assert resumed.evidence == [evidence, calendar_evidence]
    tool_returns = [
        part
        for message in requests[1]
        for part in message.parts
        if isinstance(part, ToolReturnPart)
    ]
    assert len(tool_returns) == 1
    assert tool_returns[0].content == {
        "evidence_id": calendar_evidence.evidence_id,
        "availability": calendar_result.model_dump(mode="json"),
    }


def test_azure_model_profile_declares_native_responses_modes() -> None:
    backend = azure_backend()
    assert isinstance(backend.model, OpenAIResponsesModel)
    profile = backend.model.profile
    assert profile.get("tool_deferral_mode") == TOOL_DEFERRAL_MODE
    assert profile.get("tool_addition_mode") == TOOL_ADDITION_MODE
    assert backend.model.settings == {"openai_store": False}


def test_chat_agent_initial_surface_contains_only_deferred_catalog_tools() -> None:
    backend = PydanticAIAgentBackend(
        model_name="gpt-5-6-terra",
        provider=AzureProvider(
            azure_endpoint="https://example.openai.azure.com/openai/v1",
            api_key="synthetic-key",
        ),
        provider_name="Azure OpenAI",
        action_id_prefix="test",
        canonical_model_name="gpt-5.6-terra",
    )
    agent = backend._chat_agent(advertised_tools={"cast_search", "syllabus_search"})
    assert set(agent._function_toolset.tools) == {
        "cast_search",
        "syllabus_search",
        "describe_available_capabilities",
    }
    assert all(
        tool.defer_loading and tool.sequential
        for tool in agent._function_toolset.tools.values()
    )
    assert "search_tools" not in agent._function_toolset.tools
    assert agent.model_settings == {"openai_store": False, "parallel_tool_calls": False}


def test_native_tool_search_reveals_are_read_from_typed_return_content() -> None:
    class Result:
        def all_messages(self):
            return [
                SimpleNamespace(
                    parts=[
                        NativeToolSearchReturnPart(
                            content={
                                "discovered_tools": [
                                    ToolSearchMatch(name="cast_search"),
                                    {"name": "syllabus_search"},
                                ]
                            }
                        ),
                        ToolAvailabilityDeltaPart(tools_added=["library_item_read"]),
                    ]
                )
            ]

    assert _discovered_tools_from_result(Result()) == {
        "cast_search",
        "syllabus_search",
        "library_item_read",
    }


@pytest.mark.asyncio
async def test_global_model_requests_guard_remains_enabled() -> None:
    assert pydantic_ai.models.ALLOW_MODEL_REQUESTS is False
    backend = azure_backend()
    with pytest.raises(RuntimeError, match="ALLOW_MODEL_REQUESTS"):
        await backend.propose_action(make_event(), [make_evidence()])
