from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

DataClassification = Literal["synthetic", "public", "personal", "restricted"]
Campus = Literal["omiya", "toyosu", "other"]
ExternalAction = Literal[
    "none",
    "calendar_draft",
    "checklist_update",
    "library_write",
]

LibraryActionType = Literal[
    "visit_shelf",
    "open_online",
    "reserve",
    "intercampus_transfer",
    "renew",
    "purchase_request",
    "ill_loan",
    "ill_copy",
]
LibraryWriteActionType = Literal[
    "reserve",
    "intercampus_transfer",
    "renew",
    "purchase_request",
    "ill_loan",
    "ill_copy",
]
LibraryActionInput = Literal[
    "pickup_campus",
    "reason",
    "receiver",
    "payment",
    "fee",
    "page_range",
]

OpaqueLibraryResourceRef = Annotated[
    str,
    Field(
        min_length=1,
        max_length=160,
        pattern=r"^orbit-library://record/[A-Za-z0-9_-]{16,128}$",
    ),
]


class _LibraryOperationBase(BaseModel):
    """Strict base for an operation reference; form values stay in Chrome memory."""

    model_config = ConfigDict(extra="forbid", strict=True)


class VisitShelfOperation(_LibraryOperationBase):
    action_type: Literal["visit_shelf"]
    resource_ref: OpaqueLibraryResourceRef


class OpenOnlineOperation(_LibraryOperationBase):
    action_type: Literal["open_online"]
    resource_ref: OpaqueLibraryResourceRef


class ReserveOperation(_LibraryOperationBase):
    action_type: Literal["reserve"]
    resource_ref: OpaqueLibraryResourceRef


class IntercampusTransferOperation(_LibraryOperationBase):
    action_type: Literal["intercampus_transfer"]
    resource_ref: OpaqueLibraryResourceRef


class RenewOperation(_LibraryOperationBase):
    action_type: Literal["renew"]
    resource_ref: OpaqueLibraryResourceRef


class PurchaseRequestOperation(_LibraryOperationBase):
    action_type: Literal["purchase_request"]
    resource_ref: OpaqueLibraryResourceRef


class IllLoanOperation(_LibraryOperationBase):
    action_type: Literal["ill_loan"]
    resource_ref: OpaqueLibraryResourceRef


class IllCopyOperation(_LibraryOperationBase):
    action_type: Literal["ill_copy"]
    resource_ref: OpaqueLibraryResourceRef


LibraryOperation = Annotated[
    VisitShelfOperation
    | OpenOnlineOperation
    | ReserveOperation
    | IntercampusTransferOperation
    | RenewOperation
    | PurchaseRequestOperation
    | IllLoanOperation
    | IllCopyOperation,
    Field(discriminator="action_type"),
]


class LibraryActionOption(BaseModel):
    """One current-provider action capability for an opaque resource."""

    model_config = ConfigDict(extra="forbid", strict=True)

    action_type: LibraryActionType
    available: bool
    reason_code: str = Field(min_length=1, max_length=100, pattern=r"^[a-z][a-z0-9_]*$")
    required_inputs: list[LibraryActionInput] = Field(default_factory=list, max_length=8)
    verification_level: Literal["none", "entry_visible"] = "none"

    @model_validator(mode="after")
    def capability_is_consistent(self) -> "LibraryActionOption":
        expected_inputs: dict[LibraryActionType, list[LibraryActionInput]] = {
            "visit_shelf": [],
            "open_online": [],
            "reserve": ["pickup_campus"],
            "intercampus_transfer": ["pickup_campus"],
            "renew": [],
            "purchase_request": ["reason"],
            "ill_loan": ["receiver", "payment", "fee"],
            "ill_copy": ["receiver", "payment", "fee", "page_range"],
        }
        if self.required_inputs != expected_inputs[self.action_type]:
            raise ValueError("Library action inputs must match the action type.")
        if self.available != (self.reason_code == "available"):
            raise ValueError("Library action availability must match its reason code.")
        if self.available and self.verification_level != "entry_visible":
            raise ValueError(
                "Available library actions require a verified visible entry point."
            )
        if not self.available and self.verification_level != "none":
            raise ValueError(
                "Unavailable library actions cannot carry an entry verification."
            )
        return self


class LibraryActionOptionsResult(BaseModel):
    """Read-only action capabilities derived from the current official page."""

    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal["v1"] = "v1"
    status: Literal["known", "reauth_required", "unavailable"]
    resource_ref: OpaqueLibraryResourceRef
    options: list[LibraryActionOption] = Field(default_factory=list, max_length=8)
    data_classification: Literal["public", "personal"] = "public"
    reason_code: str | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def options_match_status(self) -> "LibraryActionOptionsResult":
        action_types = [item.action_type for item in self.options]
        if len(set(action_types)) != len(action_types):
            raise ValueError("Library action options must contain unique action types.")
        if self.status == "known" and set(action_types) != {
            "visit_shelf",
            "open_online",
            "reserve",
            "intercampus_transfer",
            "renew",
            "purchase_request",
            "ill_loan",
            "ill_copy",
        }:
            raise ValueError("Known library action options must list all action types.")
        if self.status != "known" and self.options:
            raise ValueError(
                "Unavailable library action options cannot include provider capabilities."
            )
        return self


class EvidenceLink(BaseModel):
    """A compact link to the evidence used by an action proposal."""

    model_config = ConfigDict(extra="forbid")

    evidence_id: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=200)
    source_type: Literal[
        "syllabus",
        "assignment",
        "learning_history",
        "calendar",
        "scombz",
        "library",
        "career",
        "google_drive",
        "web",
    ]
    locator: str = Field(min_length=1, max_length=500)
    data_classification: DataClassification = "synthetic"


class OrbitEvent(BaseModel):
    """An observed event in the student's campus journey."""

    model_config = ConfigDict(extra="forbid")

    event_id: str = Field(default_factory=lambda: f"evt-{uuid4()}")
    event_type: Literal["campus_entered", "action_completed"]
    scenario_id: str = Field(min_length=1)
    occurred_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    campus: Campus
    data_classification: DataClassification = "synthetic"
    payload: dict[str, Any] = Field(default_factory=dict)


class ActionProposal(BaseModel):
    """An evidence-backed next action that remains a proposal until approved."""

    model_config = ConfigDict(extra="forbid")

    action_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    reason: str = Field(min_length=1)
    duration_minutes: int = Field(ge=1, le=180)
    evidence: list[EvidenceLink] = Field(min_length=1, max_length=100)
    external_action: ExternalAction = "none"
    requires_confirmation: bool = True
    prompt_version: str = Field(min_length=1)
    operation: LibraryOperation | None = None

    @model_validator(mode="after")
    def external_actions_require_confirmation(self) -> "ActionProposal":
        evidence_ids = [item.evidence_id for item in self.evidence]
        if len(set(evidence_ids)) != len(evidence_ids):
            raise ValueError("Action evidence IDs must be unique.")
        if self.external_action != "none" and not self.requires_confirmation:
            raise ValueError("External actions must require explicit confirmation.")
        if self.operation is not None:
            if not self.requires_confirmation:
                raise ValueError("Library operations require explicit confirmation.")
            write_action = self.operation.action_type in {
                "reserve",
                "intercampus_transfer",
                "renew",
                "purchase_request",
                "ill_loan",
                "ill_copy",
            }
            if write_action and self.external_action != "library_write":
                raise ValueError("Library write operations must use external_action=library_write.")
            if not write_action and self.external_action == "library_write":
                raise ValueError(
                    "Read-only library operations cannot use external_action=library_write."
                )
        elif self.external_action == "library_write":
            raise ValueError("library_write requires a library operation.")
        return self


class ProposeActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event: OrbitEvent
    context: list[EvidenceLink] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def context_evidence_ids_are_unique(self) -> "ProposeActionRequest":
        evidence_ids = [item.evidence_id for item in self.context]
        if len(set(evidence_ids)) != len(evidence_ids):
            raise ValueError("Context evidence IDs must be unique.")
        return self


class VerifyActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scenario_id: str = Field(min_length=1)
    campus: Campus
    approved: bool
    completed: bool
    notes: str = Field(default="", max_length=500)
