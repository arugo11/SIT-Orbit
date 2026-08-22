import pytest
from orbit_api.agent.chat import ChatDraft, _canonical_response, _tool_evidence
from orbit_api.agent.pydantic_ai_backend import (
    ActionDraft,
    is_derived_library_action_evidence,
    validate_library_operation_evidence,
)
from orbit_api.models import (
    ActionProposal,
    ChatToolResultRequest,
    EvidenceLink,
    IllCopyOperation,
    IllLoanOperation,
    IntercampusTransferOperation,
    LibraryActionOptionsResult,
    LibraryOperation,
    OpenOnlineOperation,
    PurchaseRequestOperation,
    RenewOperation,
    ReserveOperation,
)
from pydantic import TypeAdapter, ValidationError

RESOURCE_REF = "orbit-library://record/ABCDEFGHIJKLMNOP"
OTHER_RESOURCE_REF = "orbit-library://record/QRSTUVWXYZabcdef"
ACTION_EVIDENCE_ID = "library-action-options-v1-ABCDEFGHIJKLMNOP"
LIBRARY_OPERATION_ADAPTER = TypeAdapter(LibraryOperation)


def action_evidence(
    resource_ref: str = RESOURCE_REF,
    *,
    data_classification: str = "public",
    evidence_id: str = ACTION_EVIDENCE_ID,
) -> EvidenceLink:
    return EvidenceLink(
        evidence_id=evidence_id,
        title="公式図書館の現在の操作可否",
        source_type="library",
        locator=resource_ref,
        data_classification=data_classification,  # type: ignore[arg-type]
    )


def options_result(
    resource_ref: str = RESOURCE_REF,
    *,
    available_action: str | None = None,
    data_classification: str = "public",
) -> LibraryActionOptionsResult:
    actions = (
        "visit_shelf",
        "open_online",
        "reserve",
        "intercampus_transfer",
        "renew",
        "purchase_request",
        "ill_loan",
        "ill_copy",
    )
    required_inputs = {
        "visit_shelf": [],
        "open_online": [],
        "reserve": ["pickup_campus"],
        "intercampus_transfer": ["pickup_campus"],
        "renew": [],
        "purchase_request": ["reason"],
        "ill_loan": ["receiver", "payment", "fee"],
        "ill_copy": ["receiver", "payment", "fee", "page_range"],
    }
    return LibraryActionOptionsResult.model_validate(
        {
            "status": "known",
            "resource_ref": resource_ref,
            "data_classification": data_classification,
            "options": [
                {
                    "action_type": action,
                    "available": action == available_action,
                    "reason_code": ("available" if action == available_action else "not_available"),
                    "required_inputs": required_inputs[action],
                }
                for action in actions
            ],
        }
    )


def write_operation(action_type: str):
    if action_type == "reserve":
        return ReserveOperation.model_validate(
            {
                "action_type": "reserve",
                "resource_ref": RESOURCE_REF,
            }
        )
    if action_type == "intercampus_transfer":
        return IntercampusTransferOperation.model_validate(
            {
                "action_type": "intercampus_transfer",
                "resource_ref": RESOURCE_REF,
            }
        )
    if action_type == "renew":
        return RenewOperation(action_type="renew", resource_ref=RESOURCE_REF)
    if action_type == "purchase_request":
        return PurchaseRequestOperation.model_validate(
            {
                "action_type": "purchase_request",
                "resource_ref": RESOURCE_REF,
            }
        )
    if action_type == "ill_loan":
        return IllLoanOperation.model_validate(
            {
                "action_type": "ill_loan",
                "resource_ref": RESOURCE_REF,
            }
        )
    return IllCopyOperation.model_validate(
        {
            "action_type": "ill_copy",
            "resource_ref": RESOURCE_REF,
        }
    )


def test_library_operation_evidence_requires_one_exact_opaque_reference() -> None:
    operation = RenewOperation(action_type="renew", resource_ref=RESOURCE_REF)
    matching = action_evidence()
    validate_library_operation_evidence(operation, [matching])

    with pytest.raises(ValueError, match="does not match"):
        validate_library_operation_evidence(operation, [action_evidence(OTHER_RESOURCE_REF)])
    with pytest.raises(ValueError, match="does not match"):
        validate_library_operation_evidence(operation, [matching, matching])
    with pytest.raises(ValueError, match="require evidence"):
        validate_library_operation_evidence(operation, [])


def test_action_options_evidence_keeps_public_and_personal_boundaries() -> None:
    assert is_derived_library_action_evidence(action_evidence("public-ref")) is False
    assert is_derived_library_action_evidence(action_evidence()) is True
    assert (
        is_derived_library_action_evidence(action_evidence(data_classification="personal")) is True
    )
    assert (
        is_derived_library_action_evidence(action_evidence(data_classification="restricted"))
        is False
    )
    assert (
        is_derived_library_action_evidence(
            action_evidence(evidence_id="library-item-read-v1-ABCDEFGHIJKLMNOP")
        )
        is False
    )


@pytest.mark.parametrize(
    "action_type",
    [
        "reserve",
        "intercampus_transfer",
        "renew",
        "purchase_request",
        "ill_loan",
        "ill_copy",
    ],
)
def test_every_library_write_proposal_requires_confirmation_and_library_write(
    action_type: str,
) -> None:
    operation = write_operation(action_type)
    evidence = action_evidence()
    common = {
        "action_id": f"action-{action_type}",
        "title": action_type,
        "reason": "公式ページの現在状態に基づく提案",
        "duration_minutes": 2,
        "evidence": [evidence],
        "prompt_version": "test-v1",
        "operation": operation,
    }
    with pytest.raises(ValidationError):
        ActionProposal(**common, external_action="none")
    with pytest.raises(ValidationError):
        ActionProposal(
            **common,
            external_action="library_write",
            requires_confirmation=False,
        )
    proposal = ActionProposal(
        **common,
        external_action="library_write",
        requires_confirmation=True,
    )
    assert proposal.operation == operation


def test_chat_rejects_an_operation_missing_or_not_available_in_current_options() -> None:
    evidence = action_evidence()
    draft = ChatDraft(
        content_markdown="現在の図書館操作を確認しました。",
        evidence_ids=[evidence.evidence_id],
        action=ActionDraft(
            title="電子版を開く",
            reason="公式閲覧ページが現在利用可能です。",
            duration_minutes=2,
            external_action="none",
            evidence_ids=[evidence.evidence_id],
            operation=OpenOnlineOperation(
                action_type="open_online", resource_ref=RESOURCE_REF
            ),
        ),
    )
    with pytest.raises(ValueError, match="current known action options"):
        _canonical_response(draft, [evidence], action_id_prefix="test")
    with pytest.raises(ValueError, match="not currently available"):
        _canonical_response(
            draft,
            [evidence],
            action_id_prefix="test",
            library_action_options={RESOURCE_REF: options_result()},
        )

    completed = _canonical_response(
        draft,
        [evidence],
        action_id_prefix="test",
        library_action_options={RESOURCE_REF: options_result(available_action="open_online")},
    )
    assert completed.proposal is not None
    assert completed.proposal.operation is not None
    assert completed.proposal.operation.resource_ref == RESOURCE_REF


@pytest.mark.parametrize(
    "action_type",
    [
        "reserve",
        "intercampus_transfer",
        "renew",
        "purchase_request",
        "ill_loan",
        "ill_copy",
    ],
)
def test_write_capability_cannot_be_advertised_until_live_readback_is_verified(
    action_type: str,
) -> None:
    with pytest.raises(ValidationError, match="remain unavailable"):
        options_result(available_action=action_type)


@pytest.mark.parametrize(
    "form_field",
    ["reason", "pickup_campus", "payment", "fee", "page_range", "arguments"],
)
def test_library_operation_api_rejects_all_confirmation_form_values(
    form_field: str,
) -> None:
    form_values = {
        "reason": "local reason",
        "pickup_campus": "omiya",
        "payment": "private",
        "fee": "100",
        "page_range": "12-18",
        "arguments": {"page_range": "12-18"},
    }
    for action_type in (
        "visit_shelf",
        "open_online",
        "reserve",
        "intercampus_transfer",
        "renew",
        "purchase_request",
        "ill_loan",
        "ill_copy",
    ):
        with pytest.raises(ValidationError):
            LIBRARY_OPERATION_ADAPTER.validate_python(
                {
                    "action_type": action_type,
                    "resource_ref": RESOURCE_REF,
                    form_field: form_values[form_field],
                }
            )


def test_library_action_boundary_rejects_provider_state_and_keeps_tool_evidence_minimal() -> None:
    result = options_result(data_classification="personal")
    payload = result.model_dump(mode="json")
    payload["options"][0]["csrf_token"] = "csrf-secret"
    payload["options"][0]["raw_html"] = "<form>secret</form>"
    with pytest.raises(ValidationError):
        LibraryActionOptionsResult.model_validate(payload)

    request = ChatToolResultRequest(
        tool_call_id="library-options-call",
        name="library_action_options",
        version=1,
        result=result,
    )
    evidence = _tool_evidence(request, "run-secret")
    assert evidence.locator == RESOURCE_REF
    assert evidence.data_classification == "personal"
    assert "csrf-secret" not in evidence.model_dump_json()
    assert "raw_html" not in evidence.model_dump_json()
    assert "material-id-secret" not in evidence.model_dump_json()
