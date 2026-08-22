import pytest
from orbit_api.models import (
    ActionProposal,
    AgentToolResultRequest,
    CalendarAvailabilityResult,
    EvidenceLink,
    LibraryActionOptionsResult,
    RenewOperation,
    ScombzPageSummaryResult,
)
from pydantic import ValidationError


def test_external_action_requires_confirmation() -> None:
    evidence = EvidenceLink(
        evidence_id="ev-1",
        title="Synthetic evidence",
        source_type="assignment",
        locator="demo://evidence/1",
    )

    with pytest.raises(ValidationError):
        ActionProposal(
            action_id="act-1",
            title="Create an event",
            reason="The synthetic fixture requests it.",
            duration_minutes=10,
            evidence=[evidence],
            external_action="calendar_draft",
            requires_confirmation=False,
            prompt_version="test-v1",
        )


def test_library_action_options_are_typed_and_personal_classified() -> None:
    result = LibraryActionOptionsResult(
        status="known",
        resource_ref="orbit-library://record/ABCDEFGHIJKLMNOP",
        data_classification="personal",
        options=[
            {
                "action_type": action,
                "available": action == "renew",
                "reason_code": "available" if action == "renew" else "not_available",
                "required_inputs": [],
            }
            for action in (
                "visit_shelf",
                "open_online",
                "reserve",
                "intercampus_transfer",
                "renew",
                "purchase_request",
                "ill_loan",
                "ill_copy",
            )
        ],
    )
    assert result.data_classification == "personal"
    assert len(result.options) == 8


def test_library_write_operation_requires_library_write_and_confirmation() -> None:
    evidence = EvidenceLink(
        evidence_id="library-action-options-v1-ABCDEFGHIJKLMNOP",
        title="Official library action options",
        source_type="library",
        locator="orbit-library://record/ABCDEFGHIJKLMNOP",
        data_classification="public",
    )
    operation = RenewOperation(
        action_type="renew",
        resource_ref="orbit-library://record/ABCDEFGHIJKLMNOP",
    )
    with pytest.raises(ValidationError):
        ActionProposal(
            action_id="act-library-1",
            title="Renew",
            reason="The current official loan page allows renewal.",
            duration_minutes=2,
            evidence=[evidence],
            external_action="none",
            requires_confirmation=True,
            prompt_version="test-v1",
            operation=operation,
        )
    proposal = ActionProposal(
        action_id="act-library-2",
        title="Renew",
        reason="The current official loan page allows renewal.",
        duration_minutes=2,
        evidence=[evidence],
        external_action="library_write",
        requires_confirmation=True,
        prompt_version="test-v1",
        operation=operation,
    )
    assert proposal.operation == operation


@pytest.mark.parametrize("extra_field", ["title", "event_id", "oauth_token"])
def test_calendar_availability_rejects_event_details_and_tokens(extra_field: str) -> None:
    payload = {
        "schema_version": "v1",
        "status": "known",
        "time_zone": "Asia/Tokyo",
        "window_start": "2026-08-17T00:00:00+09:00",
        "window_end": "2026-08-24T00:00:00+09:00",
        "available_minutes": 10080,
        "busy_minutes": 0,
        "free_intervals": [],
        "reason_code": None,
        extra_field: "must-not-cross-boundary",
    }

    with pytest.raises(ValidationError, match="extra_forbidden"):
        CalendarAvailabilityResult.model_validate(payload)


def test_scombz_page_summary_is_exactly_the_minimized_v1_shape() -> None:
    result = ScombzPageSummaryResult(
        route="tasks",
        task_count=2,
        announcement_count=1,
        related_link_count=3,
        has_current_course=True,
    )

    assert set(result.model_dump()) == {
        "route",
        "task_count",
        "announcement_count",
        "related_link_count",
        "has_current_course",
    }


@pytest.mark.parametrize(
    "extra_field",
    ["title", "url", "course", "items", "html", "oauth_token"],
)
def test_scombz_page_summary_rejects_raw_page_fields(extra_field: str) -> None:
    payload = {
        "route": "tasks",
        "task_count": 2,
        "announcement_count": 1,
        "related_link_count": 3,
        "has_current_course": True,
        extra_field: "must-not-cross-boundary",
    }

    with pytest.raises(ValidationError, match="extra_forbidden"):
        ScombzPageSummaryResult.model_validate(payload)


def test_tool_result_envelope_rejects_mismatched_name_and_result_schema() -> None:
    summary = ScombzPageSummaryResult(
        route="home",
        task_count=0,
        announcement_count=1,
        related_link_count=2,
        has_current_course=False,
    )
    calendar = CalendarAvailabilityResult(
        status="known",
        time_zone="Asia/Tokyo",
        window_start="2026-08-17T00:00:00+09:00",
        window_end="2026-08-17T01:00:00+09:00",
        available_minutes=60,
        busy_minutes=0,
        free_intervals=[],
        reason_code=None,
    )

    with pytest.raises(ValidationError, match="Calendar tool results"):
        AgentToolResultRequest(
            tool_call_id="call-1",
            name="google_calendar_availability",
            result=summary,
        )
    with pytest.raises(ValidationError, match="ScombZ tool results"):
        AgentToolResultRequest(
            tool_call_id="call-2",
            name="scombz_page_summary",
            result=calendar,
        )
    with pytest.raises(ValidationError):
        AgentToolResultRequest.model_validate(
            {
                "tool_call_id": "call-3",
                "name": "scombz_page_summary",
                "version": 2,
                "result": summary.model_dump(),
            }
        )
