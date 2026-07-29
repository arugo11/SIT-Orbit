from orbit_api.models import EvidenceLink
from orbit_api.observability.weave import _safe_value


def test_personal_evidence_is_redacted_before_tracing() -> None:
    evidence = EvidenceLink(
        evidence_id="personal-1",
        title="実在学生の非公開ノート",
        source_type="learning_history",
        locator="private://student-note",
        data_classification="personal",
    )

    assert _safe_value(evidence) == {
        "data_classification": "personal",
        "redacted": True,
    }
