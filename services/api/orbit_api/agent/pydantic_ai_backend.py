"""PydanticAI-backed proposal generation and deferred Calendar tool boundary."""

import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic_ai import Agent, CallDeferred, DeferredToolRequests, DeferredToolResults
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.openai import OpenAIResponsesModel, OpenAIResponsesModelSettings
from pydantic_ai.providers import Provider
from pydantic_ai.usage import RunUsage

from orbit_api.models import (
    ActionProposal,
    CalendarAvailabilityResult,
    EvidenceLink,
    OrbitEvent,
)

from .base import AgentBackend

PROMPT_VERSION = "pydantic-ai-next-action-v1"
CALENDAR_TOOL_NAME = "google_calendar_availability"
CALENDAR_TOOL_VERSION = "v1"
CALENDAR_AVAILABILITY_LOCATOR_PREFIX = "orbit-calendar://availability/"
SAFE_CLASSIFICATIONS = {"synthetic", "public"}


class ActionDraft(BaseModel):
    """Model-owned fields only; IDs and evidence are server-owned."""

    model_config = ConfigDict(extra="forbid", strict=True)

    title: str = Field(min_length=1, max_length=200)
    reason: str = Field(min_length=1, max_length=1000)
    duration_minutes: int = Field(ge=1, le=180)
    external_action: Literal["none", "calendar_draft", "checklist_update"] = "none"
    requires_confirmation: bool = True
    evidence_ids: list[str] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def external_actions_require_confirmation(self) -> "ActionDraft":
        if self.external_action != "none" and not self.requires_confirmation:
            raise ValueError("External actions must require explicit confirmation.")
        return self


@dataclass(frozen=True)
class DeferredActionRun:
    messages: list[ModelMessage]
    tool_call_id: str
    conversation_id: str


@dataclass(frozen=True)
class AgentExecution:
    draft: ActionDraft | None = None
    deferred: DeferredActionRun | None = None


def is_derived_calendar_evidence(evidence: EvidenceLink) -> bool:
    return (
        evidence.source_type == "calendar"
        and evidence.data_classification == "personal"
        and evidence.locator.startswith(CALENDAR_AVAILABILITY_LOCATOR_PREFIX)
        and len(evidence.locator.removeprefix(CALENDAR_AVAILABILITY_LOCATOR_PREFIX)) >= 16
        and evidence.evidence_id.startswith("calendar-availability-v1-")
    )


def validate_agent_data(
    event: OrbitEvent,
    context: list[EvidenceLink],
    *,
    allow_calendar_availability: bool = False,
) -> None:
    if event.data_classification not in SAFE_CLASSIFICATIONS:
        raise ValueError("The agent backend accepts only synthetic or public event data.")
    for evidence in context:
        if evidence.data_classification in SAFE_CLASSIFICATIONS:
            continue
        if allow_calendar_availability and is_derived_calendar_evidence(evidence):
            continue
        raise ValueError(
            "The agent backend rejects personal or restricted evidence unless it is "
            "derived calendar availability."
        )


class PydanticAIAgentBackend(AgentBackend):
    """Shared Agent adapter used by both OpenAI and Azure OpenAI providers."""

    def __init__(
        self,
        *,
        model_name: str,
        provider: Provider[Any],
        provider_name: str,
        action_id_prefix: str,
        usage_callback: Callable[[RunUsage], None] | None = None,
    ) -> None:
        self.model_name = model_name
        self.provider = provider
        self.provider_name = provider_name
        self.action_id_prefix = action_id_prefix
        self.usage_callback = usage_callback
        model_settings: OpenAIResponsesModelSettings = {"openai_store": False}
        self.model = OpenAIResponsesModel(
            model_name,
            provider=provider,
            settings=model_settings,
        )

    @property
    def client(self) -> Any:
        """Expose the provider client for diagnostics without using it for runs."""

        return self.model.client

    def _agent(self, *, calendar_connected: bool) -> Agent[Any, Any]:
        tools: list[Any] = []
        if calendar_connected:

            async def google_calendar_availability() -> CalendarAvailabilityResult:
                """Return derived free-time information from the connected Calendar."""

                raise CallDeferred()

            tools.append(google_calendar_availability)

        model_settings: OpenAIResponsesModelSettings = {"openai_store": False}
        return Agent(
            self.model,
            output_type=[ActionDraft, DeferredToolRequests],
            instructions=(
                "You are the SIT ORBIT next-action planner. Propose exactly one small "
                "action using only the supplied event and evidence. The external action "
                "must require confirmation. Write student-facing fields in concise Japanese. "
                "If the calendar tool is available, use it only when availability is needed."
            ),
            tools=tools,
            model_settings=model_settings,
        )

    @staticmethod
    def _prompt(event: OrbitEvent, context: list[EvidenceLink]) -> str:
        evidence = [
            {
                "evidence_id": item.evidence_id,
                "title": item.title,
                "source_type": item.source_type,
                "locator": item.locator,
                "data_classification": item.data_classification,
            }
            for item in context
        ]
        return (
            "Event:\n"
            f"{event.model_dump_json()}\n\n"
            "Evidence:\n"
            f"{evidence}\n"
            "Use only these facts. Return evidence_ids containing one or more exact "
            "evidence_id values from the supplied evidence. Do not invent IDs or event details."
        )

    def _canonicalize(
        self,
        draft: ActionDraft,
        context: list[EvidenceLink],
    ) -> ActionProposal:
        evidence_by_id = {item.evidence_id: item for item in context}
        if len(set(draft.evidence_ids)) != len(draft.evidence_ids):
            raise ValueError("ActionDraft contains duplicate evidence IDs.")
        unknown_ids = [
            evidence_id
            for evidence_id in draft.evidence_ids
            if evidence_id not in evidence_by_id
        ]
        if unknown_ids:
            raise ValueError("ActionDraft contains unknown evidence IDs.")
        selected_evidence = [evidence_by_id[evidence_id] for evidence_id in draft.evidence_ids]
        return ActionProposal(
            action_id=f"{self.action_id_prefix}-{uuid4()}",
            title=draft.title,
            reason=draft.reason,
            duration_minutes=draft.duration_minutes,
            evidence=selected_evidence,
            external_action=draft.external_action,
            requires_confirmation=draft.requires_confirmation,
            prompt_version=PROMPT_VERSION,
        )

    @staticmethod
    def _execution(result: Any) -> AgentExecution:
        output = result.output
        if isinstance(output, ActionDraft):
            return AgentExecution(draft=output)
        if not isinstance(output, DeferredToolRequests):
            raise RuntimeError("The agent returned an unsupported structured output.")
        if output.approvals or len(output.calls) != 1:
            raise RuntimeError("Exactly one deferred external tool call is allowed per run.")
        call = output.calls[0]
        if call.tool_name != CALENDAR_TOOL_NAME or call.args not in ({}, "{}"):
            raise RuntimeError("The agent requested an unsupported calendar tool call.")
        return AgentExecution(
            deferred=DeferredActionRun(
                messages=result.all_messages(),
                tool_call_id=call.tool_call_id,
                conversation_id=result.conversation_id,
            )
        )

    async def _run(
        self,
        event: OrbitEvent,
        context: list[EvidenceLink],
        *,
        calendar_connected: bool,
    ) -> AgentExecution:
        validate_agent_data(event, context)
        if calendar_connected and os.getenv("ORBIT_OBSERVABILITY", "off") != "off":
            raise ValueError("Live calendar tools require ORBIT_OBSERVABILITY=off.")
        result = await self._agent(calendar_connected=calendar_connected).run(
            self._prompt(event, context)
        )
        if self.usage_callback is not None:
            self.usage_callback(result.usage)
        return self._execution(result)

    async def propose_action(
        self,
        event: OrbitEvent,
        context: list[EvidenceLink],
    ) -> ActionProposal:
        execution = await self._run(event, context, calendar_connected=False)
        if execution.draft is None:
            raise RuntimeError("The agent requested a calendar tool in a non-tool run.")
        return self._canonicalize(execution.draft, context)

    async def start_run(
        self,
        event: OrbitEvent,
        context: list[EvidenceLink],
        *,
        calendar_connected: bool,
    ) -> tuple[ActionProposal | None, DeferredActionRun | None]:
        execution = await self._run(
            event,
            context,
            calendar_connected=calendar_connected,
        )
        if execution.draft is not None:
            return self._canonicalize(execution.draft, context), None
        return None, execution.deferred

    async def resume_run(
        self,
        event: OrbitEvent,
        context: list[EvidenceLink],
        deferred: DeferredActionRun,
        calendar_result: CalendarAvailabilityResult,
    ) -> ActionProposal:
        validate_agent_data(event, context, allow_calendar_availability=True)
        calendar_evidence = next(
            (item for item in context if is_derived_calendar_evidence(item)),
            None,
        )
        if calendar_evidence is None:
            raise ValueError("A resumed run requires server-generated calendar evidence.")
        result = await self._agent(calendar_connected=True).run(
            message_history=deferred.messages,
            deferred_tool_results=DeferredToolResults(
                calls={
                    deferred.tool_call_id: {
                        "evidence_id": calendar_evidence.evidence_id,
                        "availability": calendar_result.model_dump(mode="json"),
                    }
                }
            ),
        )
        if self.usage_callback is not None:
            self.usage_callback(result.usage)
        execution = self._execution(result)
        if execution.draft is None:
            raise RuntimeError("A resumed run requested another tool call.")
        return self._canonicalize(execution.draft, context)


__all__ = [
    "ActionDraft",
    "AgentExecution",
    "CALENDAR_AVAILABILITY_LOCATOR_PREFIX",
    "CALENDAR_TOOL_NAME",
    "CALENDAR_TOOL_VERSION",
    "DeferredActionRun",
    "PydanticAIAgentBackend",
    "is_derived_calendar_evidence",
    "validate_agent_data",
]
