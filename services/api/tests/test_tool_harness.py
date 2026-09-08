from typing import get_args

import pytest
from orbit_api.agent.pydantic_ai_backend import PydanticAIAgentBackend
from orbit_api.agent.tool_catalog import (
    CHAT_TOOL_NAMES,
    CLIENT_TOOL_SPECS,
    SERVER_TOOL_SPECS,
    TOOL_SPECS,
    eligible_catalog_specs,
    validate_catalog_contract,
)
from orbit_api.models.agent import ChatToolName
from pydantic_ai.providers.azure import AzureProvider


def test_catalog_matches_public_contract_and_has_japanese_policy_fields() -> None:
    validate_catalog_contract()
    assert CHAT_TOOL_NAMES == get_args(ChatToolName)
    assert len(CHAT_TOOL_NAMES) == 22
    assert len({spec.name for spec in TOOL_SPECS}) == len(TOOL_SPECS)
    assert {spec.name for spec in CLIENT_TOOL_SPECS} == set(CHAT_TOOL_NAMES)
    assert {spec.name for spec in SERVER_TOOL_SPECS} == {
        "general_web_search",
        "related_book_discovery",
        "describe_available_capabilities",
    }
    for spec in TOOL_SPECS:
        assert all(
            getattr(spec, field).strip()
            for field in (
                "purpose_ja",
                "use_when_ja",
                "returns_ja",
                "avoid_when_ja",
                "dependencies_ja",
            )
        )
        assert spec.read_only and spec.version == 1
        assert "利用条件:" in spec.model_description
        assert "使わない場面:" in spec.model_description


def test_empty_advertisement_does_not_expose_client_tools() -> None:
    specs = eligible_catalog_specs(
        backend="azure_openai",
        observability="off",
        scombz_student_read_mode="live",
        sitrus_personal_context_mode="live",
        advertised_client_tools=set(),
        authenticated_tools=set(),
        consented_tools=set(),
    )
    assert [spec.name for spec in specs] == ["describe_available_capabilities"]


def test_auth_and_consent_are_intersections_not_model_choices() -> None:
    specs = eligible_catalog_specs(
        backend="azure_openai",
        observability="off",
        scombz_student_read_mode="live",
        sitrus_personal_context_mode="live",
        advertised_client_tools={"scombz_course_list", "sitrus_read", "cast_search"},
        authenticated_tools={"scombz_course_list", "cast_search"},
        consented_tools={"scombz_course_list"},
    )
    names = {spec.name for spec in specs}
    assert "scombz_course_list" in names
    assert "cast_search" in names
    assert "sitrus_read" not in names
    assert "describe_available_capabilities" in names


def test_fixture_never_qualifies_private_live_tools() -> None:
    specs = eligible_catalog_specs(
        backend="fixture",
        observability="off",
        scombz_student_read_mode="fixture",
        sitrus_personal_context_mode="fixture",
        advertised_client_tools=set(CHAT_TOOL_NAMES),
        authenticated_tools=set(CHAT_TOOL_NAMES),
        consented_tools=set(CHAT_TOOL_NAMES),
    )
    names = {spec.name for spec in specs}
    assert "scombz_course_list" not in names
    assert "sitrus_read" not in names


def test_agent_registers_only_deferred_tools_and_native_search() -> None:
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
    tools = agent._function_toolset.tools
    assert set(tools) == {"cast_search", "syllabus_search", "describe_available_capabilities"}
    assert all(tool.defer_loading and tool.sequential for tool in tools.values())
    assert "search_tools" not in tools
    assert agent.model_settings == {
        "openai_store": False,
        "parallel_tool_calls": False,
    }


@pytest.mark.parametrize("profile", ["gpt-5-6-terra", "", "gpt-5.6-sol"])
def test_noncanonical_profile_is_rejected(profile: str) -> None:
    from orbit_api.agent.native_tool_search import (
        NativeToolSearchProfileError,
        build_native_tool_search_profile,
    )

    with pytest.raises(NativeToolSearchProfileError):
        build_native_tool_search_profile(profile)
