import copy

import orbit_api.main as orbit_main
import pytest
from fastapi.testclient import TestClient
from orbit_api.main import app
from orbit_api.models import MyLibraryItem, MyLibraryReadResult
from pydantic import ValidationError

OPAQUE_REF = "orbit-library://record/0123456789abcdef"
FORBIDDEN_VALUES = (
    "student-name-secret",
    "student-number-secret",
    "student@example.invalid",
    "sso-token-secret",
    "query-secret",
    "fragment-secret",
    "secret-call-number",
    "material-secret-1",
    "request-secret-1",
    "tracking-secret-id",
    "form-value-secret",
    "purchase-reason-secret",
    "contact-note-secret",
)


def item_payload() -> dict[str, object]:
    return {
        "resource_ref": OPAQUE_REF,
        "title": "端末内資料",
        "author": "公開著者",
        "status": "受付済み",
        "due_date": None,
        "renewable": None,
        "activity_date": "2026-08-01",
        "request_type": "図書購入",
    }


def result_payload(
    scope: str = "purchase_requests",
    *,
    items: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    rows = items if items is not None else [item_payload()]
    return {
        "schema_version": "v1",
        "status": "known",
        "scope": scope,
        "items": rows,
        "total_count": len(rows),
        "next_offset": None,
        "loan_count": 0,
        "reservation_count": 0,
        "overdue_count": 0,
        "renewable_count": 0,
        "earliest_due_date": None,
        "reason_code": None,
    }


@pytest.mark.parametrize(
    "extra_field",
    [
        "name",
        "student_id",
        "email",
        "sso_token",
        "query",
        "fragment",
        "call_number",
        "material_id",
        "request_id",
        "tracking_id",
        "form_value",
        "purchase_reason",
        "contact_note",
    ],
)
def test_my_library_item_rejects_identity_and_provider_fields(
    extra_field: str,
) -> None:
    payload = item_payload()
    payload[extra_field] = FORBIDDEN_VALUES[0]
    with pytest.raises(ValidationError, match="extra_forbidden"):
        MyLibraryItem.model_validate(payload)


def test_my_library_result_is_bounded_to_twenty_rows_and_five_scopes() -> None:
    rows = [
        {
            **item_payload(),
            "resource_ref": f"orbit-library://record/{index:016x}",
        }
        for index in range(20)
    ]
    for scope in (
        "current_loans",
        "reservations",
        "loan_history",
        "purchase_requests",
        "interlibrary_requests",
    ):
        result = MyLibraryReadResult.model_validate(
            result_payload(scope, items=rows),
        )
        assert result.scope == scope
        assert len(result.items) == 20

    too_many = result_payload(
        "loan_history",
        items=[
            {
                **item_payload(),
                "resource_ref": f"orbit-library://record/{index:016x}",
            }
            for index in range(21)
        ],
    )
    with pytest.raises(ValidationError):
        MyLibraryReadResult.model_validate(too_many)


def test_fixture_chat_response_contains_only_allowed_book_fields(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "fixture")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    with TestClient(app) as client:
        first = client.post(
            "/v1/chat/runs",
            json={
                "conversation_id": "my-library-adversarial-runtime",
                "message": "購入依頼の状況を確認して",
                "history": [],
                "client_tools": [{"name": "my_library_read", "version": 1}],
            },
        )
        assert first.status_code == 200
        pending = first.json()
        assert pending["status"] == "tool_required"
        call = pending["calls"][0]

        # The in-process pending state is the only server-side storage for a
        # client-tool run. It may contain tool arguments, but no page values.
        stored = orbit_main.chat_run_service.store.peek(pending["run_id"])
        assert set(stored.deferred.arguments) == {
            "scope",
            "query",
            "offset",
            "limit",
        }
        assert all(
            marker not in repr(stored)
            for marker in FORBIDDEN_VALUES
        )

        second = client.post(
            f"/v1/chat/runs/{pending['run_id']}/tool-results",
            json={
                "tool_call_id": call["tool_call_id"],
                "name": call["name"],
                "version": call["version"],
                "result": result_payload(),
            },
        )
    assert second.status_code == 200
    completed = second.json()
    assert completed["status"] == "completed"
    assert "端末内資料" in completed["message"]["content_markdown"]
    assert "公開著者" in completed["message"]["content_markdown"]
    serialized = second.text
    for marker in FORBIDDEN_VALUES:
        assert marker not in serialized


@pytest.mark.parametrize(
    "extra_field",
    [
        "query",
        "fragment",
        "call_number",
        "material_id",
        "request_id",
        "tracking_id",
        "form_value",
        "purchase_reason",
        "contact_note",
        "student_id",
        "email",
        "sso_token",
    ],
)
def test_raw_personal_fields_are_rejected_before_chat_resume(
    monkeypatch,
    extra_field: str,
) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "fixture")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    with TestClient(app) as client:
        first = client.post(
            "/v1/chat/runs",
            json={
                "conversation_id": f"my-library-reject-{extra_field}",
                "message": "相互貸借の依頼を確認して",
                "history": [],
                "client_tools": [{"name": "my_library_read", "version": 1}],
            },
        )
        assert first.status_code == 200
        pending = first.json()
        call = pending["calls"][0]
        poisoned = copy.deepcopy(result_payload("interlibrary_requests"))
        poisoned[extra_field] = FORBIDDEN_VALUES[0]
        response = client.post(
            f"/v1/chat/runs/{pending['run_id']}/tool-results",
            json={
                "tool_call_id": call["tool_call_id"],
                "name": call["name"],
                "version": call["version"],
                "result": poisoned,
            },
        )

    assert response.status_code == 422
    assert FORBIDDEN_VALUES[0] not in response.text
