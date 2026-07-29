from evals.scorers import (
    evidence_is_attached,
    external_action_requires_confirmation,
    output_schema_valid,
)


def valid_output() -> dict:
    return {
        "action_id": "act-1",
        "title": "Review",
        "reason": "Synthetic evidence indicates a review is useful.",
        "duration_minutes": 10,
        "evidence": [
            {
                "evidence_id": "ev-1",
                "title": "Synthetic assignment",
                "source_type": "assignment",
                "locator": "demo://assignment/1",
                "data_classification": "synthetic",
            }
        ],
        "external_action": "checklist_update",
        "requires_confirmation": True,
        "prompt_version": "test-v1",
    }


def test_scorers_accept_valid_output() -> None:
    output = valid_output()
    assert output_schema_valid(output)["output_schema_valid"]
    assert evidence_is_attached(output)["evidence_is_attached"]
    assert external_action_requires_confirmation(output)["external_action_requires_confirmation"]


def test_external_action_without_confirmation_fails() -> None:
    output = valid_output()
    output["requires_confirmation"] = False
    assert not external_action_requires_confirmation(output)[
        "external_action_requires_confirmation"
    ]
