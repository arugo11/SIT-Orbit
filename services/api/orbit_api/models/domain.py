from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

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


class LibraryOperationArguments(BaseModel):
    """Strict base for bounded, operation-specific library arguments."""

    model_config = ConfigDict(extra="forbid", strict=True)


class VisitShelfArguments(LibraryOperationArguments):
    """No user-editable fields are needed to visit a rendered shelf."""


class OpenOnlineArguments(LibraryOperationArguments):
    """The extension opens only the official viewer resolved from the ref."""


class CampusPickupArguments(LibraryOperationArguments):
    pickup_campus: Literal["omiya", "toyosu"]


class RenewArguments(LibraryOperationArguments):
    """Renewal uses the currently rendered loan and has no editable input."""


class PurchaseRequestArguments(LibraryOperationArguments):
    reason: str = Field(min_length=1, max_length=500)

    @field_validator("reason")
    @classmethod
    def reason_is_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Purchase request reason cannot be blank.")
        return value


class IllLoanArguments(LibraryOperationArguments):
    receiver: str = Field(min_length=1, max_length=200)
    payment: str = Field(min_length=1, max_length=100)
    fee: str | None = Field(default=None, max_length=100)

    @field_validator("receiver", "payment")
    @classmethod
    def required_text_is_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("ILL required text cannot be blank.")
        return value


class IllCopyArguments(LibraryOperationArguments):
    receiver: str = Field(min_length=1, max_length=200)
    payment: str = Field(min_length=1, max_length=100)
    fee: str | None = Field(default=None, max_length=100)
    page_range: str = Field(min_length=1, max_length=100)

    @field_validator("receiver", "payment", "page_range")
    @classmethod
    def required_text_is_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("ILL required text cannot be blank.")
        return value


class VisitShelfOperation(LibraryOperationArguments):
    action_type: Literal["visit_shelf"]
    resource_ref: OpaqueLibraryResourceRef
    arguments: VisitShelfArguments = Field(default_factory=VisitShelfArguments)


class OpenOnlineOperation(LibraryOperationArguments):
    action_type: Literal["open_online"]
    resource_ref: OpaqueLibraryResourceRef
    arguments: OpenOnlineArguments = Field(default_factory=OpenOnlineArguments)


class ReserveOperation(LibraryOperationArguments):
    action_type: Literal["reserve"]
    resource_ref: OpaqueLibraryResourceRef
    arguments: CampusPickupArguments


class IntercampusTransferOperation(LibraryOperationArguments):
    action_type: Literal["intercampus_transfer"]
    resource_ref: OpaqueLibraryResourceRef
    arguments: CampusPickupArguments


class RenewOperation(LibraryOperationArguments):
    action_type: Literal["renew"]
    resource_ref: OpaqueLibraryResourceRef
    arguments: RenewArguments = Field(default_factory=RenewArguments)


class PurchaseRequestOperation(LibraryOperationArguments):
    action_type: Literal["purchase_request"]
    resource_ref: OpaqueLibraryResourceRef
    arguments: PurchaseRequestArguments


class IllLoanOperation(LibraryOperationArguments):
    action_type: Literal["ill_loan"]
    resource_ref: OpaqueLibraryResourceRef
    arguments: IllLoanArguments


class IllCopyOperation(LibraryOperationArguments):
    action_type: Literal["ill_copy"]
    resource_ref: OpaqueLibraryResourceRef
    arguments: IllCopyArguments


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

    evidence_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
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
    operation: LibraryOperation | None = None

    @model_validator(mode="after")
    def external_actions_require_confirmation(self) -> "ActionProposal":
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
    event: OrbitEvent
    context: list[EvidenceLink] = Field(min_length=1)


class VerifyActionRequest(BaseModel):
    scenario_id: str = Field(min_length=1)
    campus: Campus
    approved: bool
    completed: bool
    notes: str = Field(default="", max_length=500)
