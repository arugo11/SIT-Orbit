import os
from uuid import uuid4

from openai import AsyncOpenAI

from orbit_api.models import ActionProposal, EvidenceLink, OrbitEvent

PROMPT_VERSION = "openai-next-action-v1"


class OpenAIAgent:
    """Demo-only OpenAI backend using the Responses API and structured output."""

    def __init__(self, *, api_key: str, model: str) -> None:
        self.client = AsyncOpenAI(api_key=api_key)
        self.model = model

    async def propose_action(
        self,
        event: OrbitEvent,
        context: list[EvidenceLink],
    ) -> ActionProposal:
        classifications = {event.data_classification}
        classifications.update(item.data_classification for item in context)
        if not classifications.issubset({"synthetic", "public"}):
            raise ValueError("The OpenAI demo backend accepts only synthetic or public data.")

        evidence_text = "\n".join(
            f"- {item.evidence_id}: {item.title} ({item.source_type}, {item.locator})"
            for item in context
        )
        response = await self.client.responses.parse(
            model=self.model,
            store=False,
            input=[
                {
                    "role": "developer",
                    "content": (
                        "You are the SIT ORBIT next-action planner. Propose exactly one "
                        "small action that fits the available campus context. Use only the "
                        "provided evidence. Any external action must require confirmation. "
                        "Write student-facing fields in concise Japanese."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Event:\n{event.model_dump_json()}\n\n"
                        f"Evidence:\n{evidence_text}\n\n"
                        f"Set prompt_version to {PROMPT_VERSION}."
                    ),
                },
            ],
            text_format=ActionProposal,
        )
        proposal = response.output_parsed
        if proposal is None:
            raise RuntimeError("OpenAI returned no structured action proposal.")
        return proposal.model_copy(update={"action_id": f"act-openai-{uuid4()}"})


def build_openai_agent() -> OpenAIAgent:
    api_key = os.getenv("OPENAI_API_KEY")
    model = os.getenv("OPENAI_MODEL")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required for ORBIT_AGENT_BACKEND=openai.")
    if not model:
        raise RuntimeError("OPENAI_MODEL is required for ORBIT_AGENT_BACKEND=openai.")
    return OpenAIAgent(api_key=api_key, model=model)
