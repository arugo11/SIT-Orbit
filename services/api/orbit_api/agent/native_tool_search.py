"""Strict PydanticAI/Azure native Tool Search profile support.

PydanticAI's Azure provider can identify native tools from a canonical model
profile, but it does not infer the Responses wire modes for Azure deployments.
This module composes those modes explicitly and fails closed for every other
profile. It contains no provider fallback or local search strategy.
"""

from __future__ import annotations

from typing import Any

from pydantic_ai.capabilities import ToolSearch
from pydantic_ai.models.openai import OpenAIResponsesModel
from pydantic_ai.native_tools._tool_search import ToolSearchTool
from pydantic_ai.profiles import ModelProfile, merge_profile
from pydantic_ai.profiles.openai import OpenAIModelProfile, openai_model_profile
from pydantic_ai.toolsets._tool_search import ToolSearchToolset

CANONICAL_AZURE_PROFILES = frozenset({"gpt-5.6-terra"})
CANONICAL_AZURE_DEPLOYMENTS = {"gpt-5.6-terra": "gpt-5-6-terra"}
TOOL_DEFERRAL_MODE = "with_tool_search"
TOOL_ADDITION_MODE = "with_definitions"


class NativeToolSearchProfileError(ValueError):
    """Raised when a model profile cannot support hosted native Tool Search."""


class StrictNativeToolSearch(ToolSearch[Any]):
    """Tool Search capability that cannot silently fall back to local search.

    The public ``ToolSearch()`` default is intentionally portable and emits a
    local ``search_tools`` function when a provider lacks native support. Chat
    is stricter: startup has already validated the Azure Responses profile, so
    an unsupported adapter must fail instead of exposing a second selector.
    """

    def get_native_tools(self):
        return [ToolSearchTool(optional=False)]

    def get_wrapper_toolset(self, toolset):
        return ToolSearchToolset(
            wrapped=toolset,
            search_fn=None,
            max_results=self.max_results,
            tool_description=self.tool_description,
            parameter_description=self.parameter_description,
            enable_fallback=False,
        )


def validate_azure_native_tool_search_configuration(
    *,
    deployment: str | None,
    canonical_model: str | None,
    endpoint: str | None = None,
    api_key: str | None = None,
) -> None:
    """Validate the local Azure startup contract without making a network call.

    The deployment alias and canonical PydanticAI profile are deliberately
    separate values.  Requiring both (plus endpoint/key when supplied by a
    runtime) makes an unsupported model fail before an Agent or request is
    created; there is no provider fallback.
    """

    if not deployment:
        raise NativeToolSearchProfileError("AZURE_OPENAI_MODEL is required.")
    if not canonical_model:
        raise NativeToolSearchProfileError("AZURE_OPENAI_BASE_MODEL is required.")
    if endpoint is not None and not endpoint.strip():
        raise NativeToolSearchProfileError("AZURE_OPENAI_ENDPOINT is required.")
    if api_key is not None and not api_key.strip():
        raise NativeToolSearchProfileError("AZURE_OPENAI_API_KEY is required.")
    validate_azure_deployment_profile(deployment, canonical_model)
    validate_native_tool_search_profile(canonical_model)


def build_native_tool_search_profile(canonical_model: str) -> ModelProfile:
    """Return an explicitly composed Responses profile for Azure.

    The canonical profile is intentionally separate from the Azure deployment
    alias (``AZURE_OPENAI_MODEL``).  Only profiles in the allowlist are
    accepted; PydanticAI's local selection path is never selected.
    """

    canonical = canonical_model.strip()
    if canonical not in CANONICAL_AZURE_PROFILES:
        raise NativeToolSearchProfileError(
            f"Unsupported Azure canonical model profile: {canonical_model!r}."
        )
    base = openai_model_profile(canonical)
    supported = base.get("supported_native_tools", frozenset())
    if ToolSearchTool not in supported:
        raise NativeToolSearchProfileError(
            f"Azure profile {canonical!r} does not declare native Tool Search support."
        )
    profile = merge_profile(
        base,
        OpenAIModelProfile(
            tool_deferral_mode=TOOL_DEFERRAL_MODE,
            tool_addition_mode=TOOL_ADDITION_MODE,
        ),
    )
    deferral_mode = profile.get("tool_deferral_mode")
    addition_mode = profile.get("tool_addition_mode")
    if deferral_mode != TOOL_DEFERRAL_MODE:
        raise NativeToolSearchProfileError("Responses Tool Search deferral mode was not composed.")
    if addition_mode != TOOL_ADDITION_MODE:
        raise NativeToolSearchProfileError("Responses Tool Search addition mode was not composed.")
    if ToolSearchTool not in profile.get("supported_native_tools", frozenset()):
        raise NativeToolSearchProfileError("Composed profile lost native Tool Search support.")
    # Validate the wire modes against the installed PydanticAI Responses
    # adapter before an Agent is constructed.  This keeps an SDK upgrade from
    # silently selecting a local selection path.
    supported_deferral = getattr(OpenAIResponsesModel, "supported_tool_deferral_modes", frozenset())
    supported_addition = getattr(OpenAIResponsesModel, "supported_tool_addition_modes", frozenset())
    if profile.get("tool_deferral_mode") not in supported_deferral:
        raise NativeToolSearchProfileError(
            f"OpenAI Responses does not support {profile.get('tool_deferral_mode')!r}."
        )
    if profile.get("tool_addition_mode") not in supported_addition:
        raise NativeToolSearchProfileError(
            f"OpenAI Responses does not support {profile.get('tool_addition_mode')!r}."
        )
    return profile


def validate_native_tool_search_profile(canonical_model: str) -> None:
    """Validate the profile and OpenAI Responses capability before startup."""

    profile = build_native_tool_search_profile(canonical_model)
    supported_deferral = getattr(OpenAIResponsesModel, "supported_tool_deferral_modes", frozenset())
    supported_addition = getattr(OpenAIResponsesModel, "supported_tool_addition_modes", frozenset())
    deferral_mode = profile.get("tool_deferral_mode")
    addition_mode = profile.get("tool_addition_mode")
    if deferral_mode not in supported_deferral:
        raise NativeToolSearchProfileError(
            f"OpenAI Responses does not support {deferral_mode!r}."
        )
    if addition_mode not in supported_addition:
        raise NativeToolSearchProfileError(
            f"OpenAI Responses does not support {addition_mode!r}."
        )


def validate_azure_deployment_profile(deployment: str, canonical_model: str) -> None:
    """Reject a deployment alias that is not bound to the canonical profile."""

    expected = CANONICAL_AZURE_DEPLOYMENTS.get(canonical_model.strip())
    if expected is None:
        raise NativeToolSearchProfileError(
            f"Unsupported Azure canonical model profile: {canonical_model!r}."
        )
    if deployment.strip() != expected:
        raise NativeToolSearchProfileError(
            f"Azure deployment {deployment!r} is not bound to canonical profile "
            f"{canonical_model!r}."
        )


def native_tool_search_capability() -> ToolSearch:
    """Construct the Tool Search capability used by the Chat Agent."""

    # ``strategy=None`` is important: with a validated native profile it maps
    # to Azure Hosted Tool Search. Supplying a callable strategy would
    # reintroduce a client-side selection path. ``StrictNativeToolSearch``
    # disables PydanticAI's otherwise-portable local fallback.
    return StrictNativeToolSearch(strategy=None)


__all__ = [
    "CANONICAL_AZURE_DEPLOYMENTS",
    "CANONICAL_AZURE_PROFILES",
    "NativeToolSearchProfileError",
    "StrictNativeToolSearch",
    "TOOL_ADDITION_MODE",
    "TOOL_DEFERRAL_MODE",
    "build_native_tool_search_profile",
    "native_tool_search_capability",
    "validate_azure_native_tool_search_configuration",
    "validate_azure_deployment_profile",
    "validate_native_tool_search_profile",
]
