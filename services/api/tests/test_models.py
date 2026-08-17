import pytest
from orbit_api.models import ActionProposal, CalendarAvailabilityResult, EvidenceLink
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
