import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from orbit_api.models import (
    ActionProposal,
    AgentToolResultRequest,
    CalendarAvailabilityResult,
    ChatToolResultRequest,
    EvidenceLink,
    LibraryActionOptionsResult,
    RenewOperation,
    ScombzPageSummaryResult,
)
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[3]


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
    result = LibraryActionOptionsResult.model_validate(
        {
            "status": "known",
            "resource_ref": "orbit-library://record/ABCDEFGHIJKLMNOP",
            "data_classification": "personal",
            "options": [
                {
                    "action_type": action,
                    "available": action == "open_online",
                    "reason_code": (
                        "available" if action == "open_online" else "not_available"
                    ),
                    "verification_level": (
                        "entry_visible" if action == "open_online" else "none"
                    ),
                    "required_inputs": {
                        "reserve": ["pickup_campus"],
                        "intercampus_transfer": ["pickup_campus"],
                        "purchase_request": ["reason"],
                        "ill_loan": ["receiver", "payment", "fee"],
                        "ill_copy": ["receiver", "payment", "fee", "page_range"],
                    }.get(action, []),
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
        }
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


def test_calendar_availability_rejects_event_details_and_tokens() -> None:
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
        "oauth_token": "must-not-cross-boundary",
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


def test_scombz_page_summary_rejects_raw_page_fields() -> None:
    payload = {
        "route": "tasks",
        "task_count": 2,
        "announcement_count": 1,
        "related_link_count": 3,
        "has_current_course": True,
        "html": "must-not-cross-boundary",
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


def test_sitrus_tool_result_accepts_the_shared_strict_contract() -> None:
    payload = json.loads(
        (ROOT / "fixtures" / "contracts" / "sitrus_tool_result_v1.json").read_text(
            encoding="utf-8"
        )
    )

    request = ChatToolResultRequest.model_validate(payload)

    assert request.name == "sitrus_read"
    assert request.result.model_dump() == payload["result"]


def test_sitrus_tool_result_reports_only_the_selected_contract_error() -> None:
    payload = json.loads(
        (ROOT / "fixtures" / "contracts" / "sitrus_tool_result_v1.json").read_text(
            encoding="utf-8"
        )
    )
    payload["result"]["grades"][0]["credits"] = "2"

    with pytest.raises(ValidationError) as captured:
        ChatToolResultRequest.model_validate(payload)

    errors = captured.value.errors()
    assert [(item["loc"], item["type"]) for item in errors] == [
        (("result", "grades", 0, "credits"), "int_type")
    ]


@pytest.mark.parametrize(
    ("field", "value", "nested"),
    [
        ("cumulative_gpa", 3.1, False),
        ("course_code", "L0410100", True),
        ("term_slot", 1, True),
        ("repeated", False, True),
        ("student_number", "AL00000", False),
        ("token", "secret", False),
    ],
)
def test_sitrus_tool_result_rejects_prohibited_fields(
    field: str, value: object, nested: bool
) -> None:
    payload = json.loads(
        (ROOT / "fixtures" / "contracts" / "sitrus_tool_result_v1.json").read_text(
            encoding="utf-8"
        )
    )
    target = payload["result"]["grades"][0] if nested else payload["result"]
    target[field] = value

    with pytest.raises(ValidationError) as captured:
        ChatToolResultRequest.model_validate(payload)

    assert "extra_forbidden" in {item["type"] for item in captured.value.errors()}


@pytest.mark.parametrize(
    ("mutate", "expected_type"),
    [
        (
            lambda result: result.update(observed_at="not-a-timestamp"),
            "sitrus_observed_at_invalid",
        ),
        (
            lambda result: result.update(observed_at="2026-09-02T00:00:00"),
            "sitrus_observed_at_timezone_missing",
        ),
        (
            lambda result: result.update(status="unavailable"),
            "sitrus_non_known_contains_data",
        ),
        (
            lambda result: result.update(
                report_label=None,
                grades=[],
                credit_summaries=[],
            ),
            "sitrus_known_empty",
        ),
    ],
)
def test_sitrus_result_consistency_errors_have_value_free_types(
    mutate: Callable[[dict[str, Any]], None],
    expected_type: str,
) -> None:
    payload = json.loads(
        (ROOT / "fixtures" / "contracts" / "sitrus_tool_result_v1.json").read_text(
            encoding="utf-8"
        )
    )
    mutate(payload["result"])

    with pytest.raises(ValidationError) as captured:
        ChatToolResultRequest.model_validate(payload)

    assert [item["type"] for item in captured.value.errors()] == [expected_type]
