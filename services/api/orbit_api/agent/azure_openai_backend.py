"""Azure OpenAI provider construction for the shared PydanticAI adapter."""

import os
from collections.abc import Callable
from typing import Literal, cast

from pydantic_ai.providers.azure import AzureProvider
from pydantic_ai.usage import RunUsage

from orbit_api.library import get_shared_opac_gateway

from .book_discovery import AzureRelatedBookDiscoveryExecutor
from .native_tool_search import (
    validate_azure_deployment_profile,
    validate_azure_native_tool_search_configuration,
)
from .pydantic_ai_backend import PydanticAIAgentBackend
from .web_search import AzureNativeWebSearchExecutor


def _v1_endpoint(endpoint: str) -> str:
    """Build the Azure OpenAI v1-compatible endpoint used by Responses API."""

    normalized = endpoint.rstrip("/")
    return normalized if normalized.endswith("/openai/v1") else f"{normalized}/openai/v1"


class AzureOpenAIAgent(PydanticAIAgentBackend):
    """Azure OpenAI v1 backend sharing the OpenAI Responses adapter."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        endpoint: str,
        base_model: str | None = None,
        native_tool_search_required: bool = True,
        usage_callback: Callable[[RunUsage], None] | None = None,
    ) -> None:
        provider = AzureProvider(
            azure_endpoint=_v1_endpoint(endpoint),
            api_key=api_key,
        )
        canonical = base_model or os.getenv("AZURE_OPENAI_BASE_MODEL")
        if native_tool_search_required:
            if not canonical:
                raise RuntimeError("AZURE_OPENAI_BASE_MODEL is required for native Tool Search.")
            validate_azure_deployment_profile(model, canonical)
        super().__init__(
            model_name=model,
            provider=provider,
            provider_name="Azure OpenAI",
            action_id_prefix="act-azure-openai",
            canonical_model_name=canonical,
            native_tool_search_required=native_tool_search_required,
            usage_callback=usage_callback,
            opac_gateway=get_shared_opac_gateway(),
        )
        web_search_mode = os.getenv("ORBIT_WEB_SEARCH", "off")
        if web_search_mode not in {"off", "azure"}:
            raise RuntimeError("ORBIT_WEB_SEARCH must be either 'off' or 'azure'.")
        if web_search_mode == "azure":
            self.web_search_executor = AzureNativeWebSearchExecutor(self.model)
        book_discovery_mode = cast(
            Literal["off", "multi_query", "semantic"],
            os.getenv("ORBIT_BOOK_DISCOVERY", "off"),
        )
        if book_discovery_mode not in {"off", "multi_query", "semantic"}:
            raise RuntimeError("ORBIT_BOOK_DISCOVERY must be 'off', 'multi_query', or 'semantic'.")
        if book_discovery_mode != "off" and web_search_mode != "azure":
            raise RuntimeError("ORBIT_BOOK_DISCOVERY requires ORBIT_WEB_SEARCH=azure.")
        if book_discovery_mode in {"multi_query", "semantic"}:
            self.book_discovery_executor = AzureRelatedBookDiscoveryExecutor(
                self.model,
                feature_mode=cast(
                    Literal["multi_query", "semantic"],
                    book_discovery_mode,
                ),
            )


def build_azure_openai_agent() -> AzureOpenAIAgent:
    api_key = os.getenv("AZURE_OPENAI_API_KEY")
    endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
    model = os.getenv("AZURE_OPENAI_MODEL")
    base_model = os.getenv("AZURE_OPENAI_BASE_MODEL")
    if not api_key:
        raise RuntimeError("AZURE_OPENAI_API_KEY is required for ORBIT_AGENT_BACKEND=azure_openai.")
    if not endpoint:
        raise RuntimeError(
            "AZURE_OPENAI_ENDPOINT is required for ORBIT_AGENT_BACKEND=azure_openai."
        )
    if not model:
        raise RuntimeError("AZURE_OPENAI_MODEL is required for ORBIT_AGENT_BACKEND=azure_openai.")
    if not base_model:
        raise RuntimeError("AZURE_OPENAI_BASE_MODEL is required for native Tool Search.")
    validate_azure_native_tool_search_configuration(
        deployment=model,
        canonical_model=base_model,
        endpoint=endpoint,
        api_key=api_key,
    )
    return AzureOpenAIAgent(
        api_key=api_key,
        model=model,
        endpoint=endpoint,
        base_model=base_model,
    )


def validate_azure_runtime_configuration() -> None:
    """Run the non-network Azure/native Tool Search preflight at startup."""

    api_key = os.getenv("AZURE_OPENAI_API_KEY")
    endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
    deployment = os.getenv("AZURE_OPENAI_MODEL")
    canonical_model = os.getenv("AZURE_OPENAI_BASE_MODEL")
    if not api_key:
        raise RuntimeError("AZURE_OPENAI_API_KEY is required for ORBIT_AGENT_BACKEND=azure_openai.")
    if not endpoint:
        raise RuntimeError(
            "AZURE_OPENAI_ENDPOINT is required for ORBIT_AGENT_BACKEND=azure_openai."
        )
    if not deployment:
        raise RuntimeError("AZURE_OPENAI_MODEL is required for ORBIT_AGENT_BACKEND=azure_openai.")
    if not canonical_model:
        raise RuntimeError("AZURE_OPENAI_BASE_MODEL is required for native Tool Search.")
    validate_azure_native_tool_search_configuration(
        deployment=deployment,
        canonical_model=canonical_model,
        endpoint=endpoint,
        api_key=api_key,
    )


__all__ = [
    "AzureOpenAIAgent",
    "build_azure_openai_agent",
    "validate_azure_runtime_configuration",
]
