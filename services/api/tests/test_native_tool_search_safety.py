from __future__ import annotations

from collections.abc import Callable
from typing import Any, cast

import pytest
from orbit_api.agent.native_tool_search import StrictNativeToolSearch
from orbit_api.agent.pydantic_ai_backend import (
    CAST_SEARCH_TOOL_NAME,
    ChatDraft,
    ChatToolDependencies,
    PydanticAIAgentBackend,
    cast_search,
    scombz_course_list,
    scombz_course_read,
)
from orbit_api.agent.tool_catalog import TOOL_SPEC_BY_NAME
from orbit_api.models import (
    EvidenceLink,
    ScombzCourseListResult,
    ScombzCourseSummary,
    ScombzCoverage,
)
from pydantic_ai import Agent, DeferredToolRequests, NativeOutput
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    NativeToolSearchReturnPart,
    ToolCallPart,
    ToolSearchMatch,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.native_tools._tool_search import ToolSearchTool
from pydantic_ai.providers.azure import AzureProvider


def azure_backend() -> PydanticAIAgentBackend:
    """Build an Azure-shaped backend without making a provider request."""

    return PydanticAIAgentBackend(
        model_name="gpt-5-6-terra",
        provider=AzureProvider(
            azure_endpoint="https://example.openai.azure.com/openai/v1",
            api_key="synthetic-test-key",
        ),
        provider_name="Azure OpenAI",
        action_id_prefix="test",
        canonical_model_name="gpt-5.6-terra",
    )


def native_reveal(*names: str) -> NativeToolSearchReturnPart:
    return NativeToolSearchReturnPart(
        content={"discovered_tools": [ToolSearchMatch(name=name) for name in names]}
    )


def chat_agent(
    model_function: Callable[[list[ModelMessage], AgentInfo], ModelResponse],
    tools: list[Callable[..., Any]],
    *,
    deps_type: type[Any] | None = None,
) -> Agent[Any, Any]:
    kwargs: dict[str, Any] = {}
    if deps_type is not None:
        kwargs["deps_type"] = deps_type
    return Agent(
        FunctionModel(model_function, model_name="native-tool-search-safety"),
        output_type=[NativeOutput(ChatDraft), DeferredToolRequests],
        instructions="offline safety test",
        tools=tools,
        **kwargs,
    )


@pytest.mark.asyncio
async def test_function_model_rejects_call_without_native_reveal() -> None:
    def model_function(_: list[ModelMessage], __: AgentInfo) -> ModelResponse:
        return ModelResponse(
            parts=[
                ToolCallPart(
                    CAST_SEARCH_TOOL_NAME,
                    {"kind": "hiring_record", "filters": {}},
                    tool_call_id="unrevealed-call",
                )
            ]
        )

    backend = azure_backend()
    agent = chat_agent(model_function, [cast_search])
    backend._chat_agent = lambda **_: agent  # type: ignore[method-assign]

    with pytest.raises(RuntimeError, match="before native Tool Search revealed"):
        await backend.start_chat(
            conversation_id="unrevealed",
            message="求人実績を確認したい",
            history=[],
            context=[],
            advertised_tools={CAST_SEARCH_TOOL_NAME},
        )


@pytest.mark.asyncio
async def test_function_model_rejects_native_reveal_outside_eligible_snapshot() -> None:
    def model_function(_: list[ModelMessage], __: AgentInfo) -> ModelResponse:
        return ModelResponse(
            parts=[
                native_reveal(CAST_SEARCH_TOOL_NAME, "sitrus_read"),
                ToolCallPart(
                    CAST_SEARCH_TOOL_NAME,
                    {"kind": "hiring_record", "filters": {}},
                    tool_call_id="outside-snapshot-call",
                ),
            ]
        )

    backend = azure_backend()
    agent = chat_agent(model_function, [cast_search])
    backend._chat_agent = lambda **_: agent  # type: ignore[method-assign]

    with pytest.raises(RuntimeError, match="outside the eligible catalog"):
        await backend.start_chat(
            conversation_id="outside-snapshot",
            message="求人実績を確認したい",
            history=[],
            context=[],
            advertised_tools={CAST_SEARCH_TOOL_NAME},
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("next_step", ["valid", "unknown_ref", "duplicate"])
async def test_function_model_resume_preserves_provenance_and_rejects_invalid_next_call(
    monkeypatch: pytest.MonkeyPatch,
    next_step: str,
) -> None:
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    monkeypatch.setenv("ORBIT_SCOMBZ_STUDENT_READ", "live")

    course_ref = "orbit-scombz://course/" + "a" * 16
    other_course_ref = "orbit-scombz://course/" + "b" * 16
    response_count = 0

    def model_function(_: list[ModelMessage], __: AgentInfo) -> ModelResponse:
        nonlocal response_count
        response_count += 1
        if response_count == 1:
            return ModelResponse(
                parts=[
                    native_reveal("scombz_course_list"),
                    ToolCallPart(
                        "scombz_course_list",
                        {"query": "微積分"},
                        tool_call_id="course-list-call",
                    ),
                ]
            )
        if next_step == "duplicate":
            return ModelResponse(
                parts=[
                    native_reveal("scombz_course_list"),
                    ToolCallPart(
                        "scombz_course_list",
                        {"query": "微積分"},
                        tool_call_id="duplicate-list-call",
                    ),
                ]
            )
        ref = course_ref if next_step == "valid" else other_course_ref
        return ModelResponse(
            parts=[
                native_reveal("scombz_course_read"),
                ToolCallPart(
                    "scombz_course_read",
                    {"course_refs": [ref]},
                    tool_call_id="course-read-call",
                ),
            ]
        )

    backend = azure_backend()
    agent = chat_agent(model_function, [scombz_course_list, scombz_course_read])
    backend._chat_agent = lambda **_: agent  # type: ignore[method-assign]
    first = await backend.start_chat(
        conversation_id=f"course-resume-{next_step}",
        message="履修科目を確認したい",
        history=[],
        context=[],
        advertised_tools={"scombz_course_list", "scombz_course_read"},
    )
    assert first.deferred is not None

    course_result = ScombzCourseListResult(
        status="known",
        courses=[
            ScombzCourseSummary(
                course_ref=course_ref,
                display_name="微積分",
                academic_year=2026,
                term="前期",
            )
        ],
        coverage=ScombzCoverage(
            scope="all",
            requested=1,
            attempted=1,
            succeeded=1,
            failed=0,
        ),
        observed_at="2026-09-08T00:00:00+09:00",
    )
    course_evidence = EvidenceLink(
        evidence_id="scombz-course-list-v1-" + "a" * 16,
        title="SCombZから取得した学生向け情報",
        source_type="scombz",
        locator="orbit-scombz://read/" + "b" * 16,
        data_classification="personal",
    )

    if next_step == "valid":
        resumed = await backend.resume_chat(
            deferred=first.deferred,
            tool_result=course_result,
            context=[course_evidence],
            tool_evidence=course_evidence,
            advertised_tools={"scombz_course_list", "scombz_course_read"},
        )
        assert resumed.deferred is not None
        assert resumed.deferred.tool_name == "scombz_course_read"
        assert resumed.deferred.arguments == {"course_refs": [course_ref]}
        assert resumed.deferred.available_sequence_refs == {course_ref}
        assert dict(resumed.deferred.opaque_ref_producers) == {
            course_ref: "scombz_course_list"
        }
    else:
        expected = "repeated an unchanged tool request" if next_step == "duplicate" else "must use"
        with pytest.raises(RuntimeError, match=expected):
            await backend.resume_chat(
                deferred=first.deferred,
                tool_result=course_result,
                context=[course_evidence],
                tool_evidence=course_evidence,
                advertised_tools={"scombz_course_list", "scombz_course_read"},
            )


@pytest.mark.asyncio
async def test_function_model_capability_description_cannot_enable_external_tool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    response_count = 0

    def model_function(_: list[ModelMessage], __: AgentInfo) -> ModelResponse:
        nonlocal response_count
        response_count += 1
        if response_count == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        "describe_available_capabilities",
                        {},
                        tool_call_id="capability-call",
                    )
                ]
            )
        return ModelResponse(
            parts=[
                native_reveal(CAST_SEARCH_TOOL_NAME),
                ToolCallPart(
                    CAST_SEARCH_TOOL_NAME,
                    {"kind": "hiring_record", "filters": {}},
                    tool_call_id="external-after-capability-call",
                ),
            ]
        )

    backend = azure_backend()
    capability_handler = backend._capability_handler(
        (TOOL_SPEC_BY_NAME[CAST_SEARCH_TOOL_NAME],)
    )
    agent = chat_agent(
        model_function,
        [capability_handler, cast_search],
        deps_type=ChatToolDependencies,
    )
    backend._chat_agent = lambda **_: agent  # type: ignore[method-assign]

    with pytest.raises(RuntimeError, match="metadata-only"):
        await backend.start_chat(
            conversation_id="capability-only",
            message="利用できる機能を教えて",
            history=[],
            context=[],
            advertised_tools={CAST_SEARCH_TOOL_NAME},
        )
    assert response_count == 2


def test_native_tool_search_advertises_required_selector_without_local_fallback() -> None:
    backend = azure_backend()
    agent = backend._chat_agent(advertised_tools={CAST_SEARCH_TOOL_NAME})
    tools = agent._function_toolset.tools

    assert set(tools) == {CAST_SEARCH_TOOL_NAME, "describe_available_capabilities"}
    assert all(tool.defer_loading and tool.sequential for tool in tools.values())
    assert "search_tools" not in tools

    native_tools = list(agent._cap_native_tools)
    assert len(native_tools) == 1
    assert isinstance(native_tools[0], ToolSearchTool)
    assert native_tools[0].optional is False

    root_capability = agent._effective_root_capability()
    wrapper = root_capability.get_wrapper_toolset(agent._function_toolset)
    assert wrapper is not None
    wrapper_config = cast(Any, wrapper)
    assert wrapper_config.search_fn is None
    assert wrapper_config.enable_fallback is False
    assert isinstance(agent._root_capability.capabilities[0], StrictNativeToolSearch)
