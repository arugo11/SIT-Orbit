from datetime import UTC, datetime
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field, model_validator

DataClassification = Literal["synthetic", "public", "personal", "restricted"]
Campus = Literal["omiya", "toyosu", "other"]
ExternalAction = Literal["none", "calendar_draft", "checklist_update"]


class EvidenceLink(BaseModel):
    """A compact link to the evidence used by an action proposal."""

    evidence_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    source_type: Literal[
        "syllabus",
        "assignment",
        "learning_history",
        "calendar",
        "scombz",
        "library",
        "google_drive",
    ]
    locator: str = Field(min_length=1)
    data_classification: DataClassification = "synthetic"


class OrbitEvent(BaseModel):
    """An observed event in the student's campus journey."""

    event_id: str = Field(default_factory=lambda: f"evt-{uuid4()}")
    event_type: Literal["campus_entered", "action_completed"]
    scenario_id: str = Field(min_length=1)
    occurred_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    campus: Campus
    data_classification: DataClassification = "synthetic"
    payload: dict[str, Any] = Field(default_factory=dict)


class ActionProposal(BaseModel):
    """An evidence-backed next action that remains a proposal until approved."""

    action_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    reason: str = Field(min_length=1)
    duration_minutes: int = Field(ge=1, le=180)
    evidence: list[EvidenceLink] = Field(min_length=1)
    external_action: ExternalAction = "none"
    requires_confirmation: bool = True
    prompt_version: str = Field(min_length=1)

    @model_validator(mode="after")
    def external_actions_require_confirmation(self) -> "ActionProposal":
        if self.external_action != "none" and not self.requires_confirmation:
            raise ValueError("External actions must require explicit confirmation.")
        return self


class ProposeActionRequest(BaseModel):
    event: OrbitEvent
    context: list[EvidenceLink] = Field(min_length=1)


class VerifyActionRequest(BaseModel):
    scenario_id: str = Field(min_length=1)
    campus: Campus
    approved: bool
    completed: bool
    notes: str = Field(default="", max_length=500)
