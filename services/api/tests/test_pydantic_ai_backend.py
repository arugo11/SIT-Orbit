
import pydantic_ai.models
import pytest
from orbit_api.agent.openai_backend import OpenAIAgent
from orbit_api.agent.pydantic_ai_backend import (
    CALENDAR_AVAILABILITY_LOCATOR_PREFIX,
    CALENDAR_TOOL_NAME,
    ActionDraft,
)
from orbit_api.models import (
    CalendarAvailabilityInterval,
    CalendarAvailabilityResult,
    EvidenceLink,
    OrbitEvent,
)
from pydantic_ai import (
    Agent,
    CallDeferred,
    DeferredToolRequests,
    ModelMessage,
    ModelResponse,
    ToolCallPart,
)
from pydantic_ai.messages import ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.openai import OpenAIResponsesModel
from pydantic_ai.models.test import TestModel


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


def test_agent_with_test_model_advertises_only_the_connected_calendar_tool() -> None:
    async def run() -> None:
        for calendar_connected, expected_tools in (
            (False, []),
            (True, [CALENDAR_TOOL_NAME]),
        ):
            model = TestModel(call_tools=[])
            tools = [google_calendar_availability] if calendar_connected else []
            agent = Agent(
                model,
                output_type=[ActionDraft, DeferredToolRequests],
                instructions="test",
                tools=tools,
            )

            result = await agent.run("synthetic proposal")

            assert isinstance(result.output, ActionDraft)
            assert model.last_model_request_parameters is not None
            assert [
                tool.name
                for tool in model.last_model_request_parameters.declared_function_tools
            ] == expected_tools
            output_tools = model.last_model_request_parameters.output_tools
            assert output_tools is not None
            assert output_tools[0].parameters_json_schema["additionalProperties"] is False

    import asyncio

    asyncio.run(run())


@pytest.mark.asyncio
async def test_test_model_structured_output_restores_server_owned_evidence() -> None:
    backend = OpenAIAgent(api_key="synthetic-test-key", model="demo-model")
    evidence = make_evidence()
    model = TestModel(custom_output_args=action_args(evidence.evidence_id))
    test_agent = Agent(
        model,
        output_type=[ActionDraft, DeferredToolRequests],
        instructions="test",
    )

    backend._agent = lambda *, calendar_connected: test_agent  # type: ignore[method-assign]
    proposal = await backend.propose_action(make_event(), [evidence])

    assert proposal.action_id.startswith("act-openai-")
    assert proposal.evidence == [evidence]
    assert proposal.evidence[0] is evidence
    assert proposal.requires_confirmation is True
    assert proposal.external_action == "checklist_update"


@pytest.mark.asyncio
async def test_no_tool_path_returns_a_completed_action_proposal() -> None:
    backend = OpenAIAgent(api_key="synthetic-test-key", model="demo-model")
    evidence = make_evidence()
    model = TestModel(custom_output_args=action_args(evidence.evidence_id))
    test_agent = Agent(
        model,
        output_type=[ActionDraft, DeferredToolRequests],
        instructions="test",
    )
    backend._agent = lambda *, calendar_connected: test_agent  # type: ignore[method-assign]

    proposal, deferred = await backend.start_run(
        make_event(),
        [evidence],
        calendar_connected=False,
    )

    assert deferred is None
    assert proposal is not None
    assert proposal.evidence == [evidence]


@pytest.mark.asyncio
async def test_unknown_evidence_id_is_rejected_after_structured_output() -> None:
    backend = OpenAIAgent(api_key="synthetic-test-key", model="demo-model")
    model = TestModel(custom_output_args=action_args("ev-not-supplied"))
    test_agent = Agent(
        model,
        output_type=[ActionDraft, DeferredToolRequests],
        instructions="test",
    )
    backend._agent = lambda *, calendar_connected: test_agent  # type: ignore[method-assign]

    with pytest.raises(ValueError, match="unknown evidence IDs"):
        await backend.propose_action(make_event(), [make_evidence()])


@pytest.mark.asyncio
async def test_function_model_deferred_calendar_result_is_minimized_before_resume() -> None:
    requests: list[list[ModelMessage]] = []

    def model_function(
        messages: list[ModelMessage],
        _: AgentInfo,
    ) -> ModelResponse:
        requests.append(messages)
        if len(requests) == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        CALENDAR_TOOL_NAME,
                        {},
                        tool_call_id="calendar-call-1",
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

    model = FunctionModel(model_function, model_name="deterministic-test")
    test_agent = Agent(
        model,
        output_type=[ActionDraft, DeferredToolRequests],
        instructions="test",
        tools=[google_calendar_availability],
    )
    backend = OpenAIAgent(api_key="synthetic-test-key", model="demo-model")
    backend._agent = lambda *, calendar_connected: test_agent  # type: ignore[method-assign]

    event = make_event()
    evidence = make_evidence()
    deferred_context = EvidenceLink(
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
        event,
        [evidence],
        calendar_connected=True,
    )

    assert proposal is None
    assert deferred is not None
    assert deferred.tool_call_id == "calendar-call-1"

    resumed = await backend.resume_run(
        event,
        [evidence, deferred_context],
        deferred,
        calendar_result,
    )

    assert resumed.evidence == [evidence, deferred_context]
    assert resumed.requires_confirmation is True
    assert len(requests) == 2
    tool_returns = [
        part
        for message in requests[1]
        for part in message.parts
        if isinstance(part, ToolReturnPart)
    ]
    assert len(tool_returns) == 1
    assert tool_returns[0].content == {
        "evidence_id": deferred_context.evidence_id,
        "availability": calendar_result.model_dump(mode="json"),
    }
    serialized_result = str(tool_returns[0].content)
    assert "event_id" not in serialized_result
    assert "title" not in serialized_result
    assert "oauth" not in serialized_result.lower()
    assert "token" not in serialized_result.lower()


def test_agent_settings_disable_provider_storage() -> None:
    backend = OpenAIAgent(api_key="synthetic-test-key", model="demo-model")
    agent = backend._agent(calendar_connected=False)

    assert isinstance(backend.model, OpenAIResponsesModel)
    assert isinstance(agent.model, OpenAIResponsesModel)
    assert backend.model.settings == {"openai_store": False}
    assert agent.model_settings == {"openai_store": False}
    assert agent.model.settings == {"openai_store": False}


@pytest.mark.asyncio
async def test_real_provider_request_is_blocked_by_global_test_guard() -> None:
    assert pydantic_ai.models.ALLOW_MODEL_REQUESTS is False
    backend = OpenAIAgent(api_key="synthetic-test-key", model="demo-model")

    with pytest.raises(RuntimeError, match="ALLOW_MODEL_REQUESTS"):
        await backend.propose_action(make_event(), [make_evidence()])
