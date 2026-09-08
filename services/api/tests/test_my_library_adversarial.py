import copy
from typing import cast

import pytest
from fastapi.testclient import TestClient
from orbit_api.agent.pydantic_ai_backend import validate_my_library_result_page
from orbit_api.main import app
from orbit_api.models import MyLibraryItem, MyLibraryReadResult
from pydantic import TypeAdapter, ValidationError

MY_LIBRARY_RESULT_ADAPTER = TypeAdapter(MyLibraryReadResult)

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


def item_payload(
    scope: str = "purchase_requests",
    *,
    author: str | None = "公開著者",
) -> dict[str, object]:
    scope_values = {
        "current_loans": {
            "status": "貸出中",
            "due_date": "2026-08-24",
            "activity_date": None,
            "request_type": None,
        },
        "reservations": {
            "status": "取置中",
            "due_date": "2026-08-28",
            "activity_date": None,
            "request_type": "reservation",
        },
        "loan_history": {
            "status": "返却済み",
            "due_date": None,
            "activity_date": "2026-07-01",
            "request_type": None,
        },
        "purchase_requests": {
            "status": "受付済み",
            "due_date": None,
            "activity_date": "2026-08-01",
            "request_type": "図書購入",
        },
        "interlibrary_requests": {
            "status": "処理中",
            "due_date": None,
            "activity_date": "2026-08-05",
            "request_type": "文献複写",
        },
    }
    values = scope_values[scope]
    return {
        "resource_ref": OPAQUE_REF,
        "title": "端末内資料",
        "author": author,
        **values,
        "renewable": None,
    }


def result_payload(
    scope: str = "purchase_requests",
    *,
    items: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    rows = items if items is not None else [item_payload(scope)]
    aggregates: dict[str, object] = {
        "loan_count": None,
        "reservation_count": None,
        "overdue_count": None,
        "renewable_count": None,
        "earliest_due_date": None,
    }
    if scope == "current_loans":
        aggregates.update(loan_count=len(rows), overdue_count=0, renewable_count=0)
    elif scope == "reservations":
        aggregates["reservation_count"] = len(rows)
    return {
        "schema_version": "v1",
        "status": "known",
        "scope": scope,
        "items": rows,
        "total_count": len(rows),
        "next_offset": None,
        **aggregates,
        "reason_code": None,
    }


@pytest.mark.parametrize(
    "extra_field",
    ["student_id", "sso_token"],
)
def test_my_library_item_rejects_identity_and_provider_fields(
    extra_field: str,
) -> None:
    payload = item_payload()
    payload[extra_field] = FORBIDDEN_VALUES[0]
    with pytest.raises(ValidationError, match="extra_forbidden"):
        MyLibraryItem.model_validate(payload)


def test_my_library_item_rejects_whitespace_only_titles() -> None:
    payload = item_payload()
    payload["title"] = "  "
    with pytest.raises(ValidationError, match="must not be blank"):
        MyLibraryItem.model_validate(payload)


@pytest.mark.parametrize("field", ["due_date", "activity_date"])
def test_my_library_item_requires_exact_iso_dates(field: str) -> None:
    payload = item_payload("purchase_requests")
    payload[field] = "2026-8-1"
    with pytest.raises(ValidationError, match="YYYY-MM-DD"):
        MyLibraryItem.model_validate(payload)

    payload[field] = "2026-08-01"
    parsed = MyLibraryItem.model_validate(payload)
    assert getattr(parsed, field) == "2026-08-01"


def test_my_library_result_requires_exact_aggregate_dates() -> None:
    for payload in (
        {
            "schema_version": "v1",
            "status": "known",
            "loan_count": 1,
            "reservation_count": 0,
            "overdue_count": 0,
            "renewable_count": 0,
            "earliest_due_date": "2026-8-1",
            "reason_code": None,
        },
        {
            **result_payload("current_loans"),
            "earliest_due_date": "2026-8-1",
        },
    ):
        with pytest.raises(ValidationError, match="YYYY-MM-DD"):
            MY_LIBRARY_RESULT_ADAPTER.validate_python(payload)

    for payload in (
        {
            "schema_version": "v1",
            "status": "known",
            "loan_count": 1,
            "reservation_count": 0,
            "overdue_count": 0,
            "renewable_count": 0,
            "earliest_due_date": "2026-08-01",
            "reason_code": None,
        },
        {
            **result_payload("current_loans"),
            "earliest_due_date": "2026-08-01",
        },
    ):
        assert MY_LIBRARY_RESULT_ADAPTER.validate_python(payload).status == "known"


def test_my_library_result_is_bounded_to_twenty_rows_and_five_scopes() -> None:
    for scope in (
        "current_loans",
        "reservations",
        "loan_history",
        "purchase_requests",
        "interlibrary_requests",
    ):
        rows = [
            {
                **item_payload(scope),
                "resource_ref": f"orbit-library://record/{index:016x}",
            }
            for index in range(20)
        ]
        result = MY_LIBRARY_RESULT_ADAPTER.validate_python(
            result_payload(scope, items=rows),
        )
        assert result.scope == scope
        assert result.items is not None
        assert len(result.items) == 20

    too_many = result_payload(
        "loan_history",
        items=[
            {
                **item_payload("loan_history"),
                "resource_ref": f"orbit-library://record/{index:016x}",
            }
            for index in range(21)
        ],
    )
    with pytest.raises(ValidationError):
        MY_LIBRARY_RESULT_ADAPTER.validate_python(too_many)


def test_fixture_chat_does_not_select_my_library_from_natural_language(monkeypatch) -> None:
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
        payload = first.json()
    assert payload["status"] == "completed"
    assert "calls" not in payload
    assert "fixtureでは一般的なTool選択を再現しません" in payload["message"]["content_markdown"]


def test_unavailable_scoped_result_rejects_even_zero_aggregate_values() -> None:
    payload = result_payload(items=[])
    payload.update(status="unavailable", loan_count=0, reason_code="unavailable")
    with pytest.raises(ValidationError):
        MY_LIBRARY_RESULT_ADAPTER.validate_python(payload)


def test_known_result_requires_a_complete_legacy_or_scoped_shape() -> None:
    with pytest.raises(ValidationError):
        MY_LIBRARY_RESULT_ADAPTER.validate_python({"status": "known"})

    inconsistent = result_payload("purchase_requests")
    inconsistent["loan_count"] = 0
    with pytest.raises(ValidationError, match="outside the requested scope"):
        MY_LIBRARY_RESULT_ADAPTER.validate_python(inconsistent)


@pytest.mark.parametrize(
    ("scope", "required_fields"),
    [
        ("current_loans", ("due_date",)),
        ("reservations", ("due_date", "status")),
        ("loan_history", ("activity_date", "status")),
        ("purchase_requests", ("activity_date", "status", "request_type")),
        (
            "interlibrary_requests",
            ("activity_date", "status", "request_type"),
        ),
    ],
)
def test_scoped_known_results_require_scope_semantic_fields_and_allow_authorless_items(
    scope: str,
    required_fields: tuple[str, ...],
) -> None:
    complete = result_payload(
        scope,
        items=[item_payload(scope, author=None)],
    )
    parsed = MY_LIBRARY_RESULT_ADAPTER.validate_python(complete)
    assert parsed.items is not None
    assert parsed.items[0].author is None

    for field in required_fields:
        incomplete = copy.deepcopy(complete)
        incomplete_items = cast(list[dict[str, object]], incomplete["items"])
        incomplete_items[0][field] = None
        with pytest.raises(ValidationError, match="incomplete fields"):
            MY_LIBRARY_RESULT_ADAPTER.validate_python(incomplete)


def test_legacy_aggregate_shape_remains_compatible() -> None:
    legacy = {
        "schema_version": "v1",
        "status": "known",
        "loan_count": 2,
        "reservation_count": 1,
        "overdue_count": 1,
        "renewable_count": 1,
        "earliest_due_date": "2026-08-24",
        "reason_code": None,
    }
    parsed = MY_LIBRARY_RESULT_ADAPTER.validate_python(legacy)
    assert parsed.loan_count == 2
    assert parsed.reservation_count == 1


@pytest.mark.parametrize(
    ("scope", "field"),
    [
        ("reservations", "status"),
        ("loan_history", "status"),
        ("purchase_requests", "status"),
        ("purchase_requests", "request_type"),
        ("interlibrary_requests", "status"),
        ("interlibrary_requests", "request_type"),
    ],
)
def test_scoped_known_results_reject_empty_required_strings(
    scope: str,
    field: str,
) -> None:
    complete = result_payload(scope)
    assert MY_LIBRARY_RESULT_ADAPTER.validate_python(complete).status == "known"

    for blank in ("", "   "):
        incomplete = copy.deepcopy(complete)
        incomplete_items = cast(list[dict[str, object]], incomplete["items"])
        incomplete_items[0][field] = blank
        with pytest.raises(ValidationError, match="incomplete fields"):
            MY_LIBRARY_RESULT_ADAPTER.validate_python(incomplete)


@pytest.mark.parametrize(
    ("scope", "allowed_fields"),
    [
        ("current_loans", {"loan_count", "overdue_count", "renewable_count"}),
        ("reservations", {"reservation_count"}),
        ("loan_history", set()),
        ("purchase_requests", set()),
        ("interlibrary_requests", set()),
    ],
)
def test_scoped_contract_nulls_aggregates_outside_each_requested_scope(
    scope: str,
    allowed_fields: set[str],
) -> None:
    parsed = MY_LIBRARY_RESULT_ADAPTER.validate_python(result_payload(scope))
    for field in (
        "loan_count",
        "reservation_count",
        "overdue_count",
        "renewable_count",
        "earliest_due_date",
    ):
        value = getattr(parsed, field)
        if field in allowed_fields:
            assert value is not None
            continue
        assert value is None

        poisoned = copy.deepcopy(result_payload(scope))
        poisoned[field] = 0
        with pytest.raises(ValidationError):
            MY_LIBRARY_RESULT_ADAPTER.validate_python(poisoned)


def _scoped_page_for_resume(
    *, item_count: int, total_count: int, next_offset: int | None
):
    rows = [
        {
            **item_payload(),
            "resource_ref": f"orbit-library://record/{index:016x}",
        }
        for index in range(item_count)
    ]
    payload = result_payload("purchase_requests", items=rows)
    payload["total_count"] = total_count
    payload["next_offset"] = next_offset
    return MY_LIBRARY_RESULT_ADAPTER.validate_python(payload)


@pytest.mark.parametrize(
    ("item_count", "total_count", "next_offset", "arguments", "message"),
    [
        (
            1,
            21,
            1,
            {"scope": "purchase_requests", "offset": 0, "limit": 20},
            "item count",
        ),
        (
            20,
            21,
            None,
            {"scope": "purchase_requests", "offset": 0, "limit": 20},
            "next_offset",
        ),
        (
            0,
            1,
            None,
            {"scope": "purchase_requests", "offset": 0, "limit": 20},
            "item count",
        ),
        (
            0,
            21,
            None,
            {"scope": "purchase_requests", "offset": 20, "limit": 20},
            "item count",
        ),
    ],
)
def test_resume_rejects_total_offset_limit_cursor_inconsistency(
    item_count: int,
    total_count: int,
    next_offset: int | None,
    arguments: dict[str, object],
    message: str,
) -> None:
    result = _scoped_page_for_resume(
        item_count=item_count,
        total_count=total_count,
        next_offset=next_offset,
    )
    with pytest.raises(ValueError, match=message):
        validate_my_library_result_page(result, arguments)


def test_resume_accepts_only_the_page_defined_by_offset_and_limit() -> None:
    first_page = _scoped_page_for_resume(
        item_count=20,
        total_count=21,
        next_offset=20,
    )
    validate_my_library_result_page(
        first_page,
        {"scope": "purchase_requests", "offset": 0, "limit": 20},
    )

    final_page = _scoped_page_for_resume(
        item_count=1,
        total_count=21,
        next_offset=None,
    )
    validate_my_library_result_page(
        final_page,
        {"scope": "purchase_requests", "offset": 20, "limit": 20},
    )

    with pytest.raises(ValueError, match="offset"):
        validate_my_library_result_page(
            final_page,
            {"scope": "purchase_requests", "offset": -1, "limit": 20},
        )
    with pytest.raises(ValueError, match="limit"):
        validate_my_library_result_page(
            final_page,
            {"scope": "purchase_requests", "offset": 20, "limit": 21},
        )


def test_scoped_result_is_checked_without_fixture_chat_selection() -> None:
    short_page = result_payload(items=[])
    short_page["total_count"] = 1
    parsed = MY_LIBRARY_RESULT_ADAPTER.validate_python(short_page)
    with pytest.raises(ValueError, match="item count"):
        validate_my_library_result_page(
            parsed,
            {"scope": "purchase_requests", "offset": 0, "limit": 20},
        )


def test_legacy_result_cannot_satisfy_a_scoped_request() -> None:
    legacy = {
        "schema_version": "v1",
        "status": "known",
        "loan_count": 0,
        "reservation_count": 0,
        "overdue_count": 0,
        "renewable_count": 0,
        "earliest_due_date": None,
        "reason_code": None,
    }
    parsed = MY_LIBRARY_RESULT_ADAPTER.validate_python(legacy)
    with pytest.raises(ValueError, match="Legacy My Library"):
        validate_my_library_result_page(parsed, {"scope": "current_loans"})


@pytest.mark.parametrize(
    "extra_field",
    ["student_id", "sso_token"],
)
def test_raw_personal_fields_are_rejected_before_chat_resume(
    extra_field: str,
) -> None:
    poisoned = copy.deepcopy(result_payload("interlibrary_requests"))
    poisoned[extra_field] = FORBIDDEN_VALUES[0]
    with pytest.raises(ValidationError, match="extra_forbidden"):
        MY_LIBRARY_RESULT_ADAPTER.validate_python(poisoned)
