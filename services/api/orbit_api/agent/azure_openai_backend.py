import os

from .openai_backend import OpenAIAgent


def _v1_base_url(endpoint: str) -> str:
    """Build the Azure OpenAI v1 base URL from the resource endpoint."""

    return f"{endpoint.rstrip('/')}/openai/v1/"


class AzureOpenAIAgent(OpenAIAgent):
    """Azure OpenAI v1 adapter sharing the existing structured-output boundary."""

    def __init__(self, *, api_key: str, model: str, endpoint: str) -> None:
        super().__init__(
            api_key=api_key,
            model=model,
            base_url=_v1_base_url(endpoint),
            provider_name="Azure OpenAI",
            action_id_prefix="act-azure-openai",
        )


def build_azure_openai_agent() -> AzureOpenAIAgent:
    api_key = os.getenv("AZURE_OPENAI_API_KEY")
    endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
    model = os.getenv("AZURE_OPENAI_MODEL")
    if not api_key:
        raise RuntimeError(
            "AZURE_OPENAI_API_KEY is required for ORBIT_AGENT_BACKEND=azure_openai."
        )
    if not endpoint:
        raise RuntimeError(
            "AZURE_OPENAI_ENDPOINT is required for ORBIT_AGENT_BACKEND=azure_openai."
        )
    if not model:
        raise RuntimeError(
            "AZURE_OPENAI_MODEL is required for ORBIT_AGENT_BACKEND=azure_openai."
        )
    return AzureOpenAIAgent(api_key=api_key, model=model, endpoint=endpoint)
