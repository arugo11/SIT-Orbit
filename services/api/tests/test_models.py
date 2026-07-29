import pytest
from orbit_api.models import ActionProposal, EvidenceLink
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
