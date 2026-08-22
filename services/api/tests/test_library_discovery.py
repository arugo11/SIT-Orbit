import pytest
from fastapi.testclient import TestClient
from orbit_api.agent.pydantic_ai_backend import is_derived_library_evidence
from orbit_api.main import app
from orbit_api.models import (
    ChatToolResultRequest,
    EvidenceLink,
    LibraryBibliographicRecord,
    LibraryCatalogSearchResult,
    LibraryDiscoveryItem,
    LibraryHoldingSummary,
    LibraryItemReadResult,
)


def _item() -> LibraryBibliographicRecord:
    return LibraryBibliographicRecord(
        resource_ref="orbit-library://record/0123456789abcdef",
        title="公開ロボット工学",
        authors=["芝浦太郎"],
        subjects=["ロボット"],
        isbn="978-4-0000-0000-0",
        publisher="公開出版社",
        publication_year=2026,
        format="book",
        campus="omiya",
        url="https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/ABC123",
        holdings=[
            LibraryHoldingSummary(
                campus="omiya",
                location="大宮図書館",
                call_number="548.3",
                status="available",
                due_date=None,
                reservation_count=0,
            )
        ],
        related_records=[],
    )


def test_public_library_result_is_strict_and_has_no_internal_ids() -> None:
    item = _item()
    result = LibraryCatalogSearchResult(status="known", query="ロボット", items=[item])
    assert result.items[0].holdings[0].call_number == "548.3"
    with pytest.raises(ValueError):
        LibraryCatalogSearchResult.model_validate(
            {
                **result.model_dump(mode="json"),
                "material_id": "must-not-cross-boundary",
            }
        )
    with pytest.raises(ValueError):
        LibraryHoldingSummary(
            campus="unknown",
            location=None,
            call_number=None,
            status="unknown",
            due_date="2026-09-01",
            reservation_count=None,
        )
    with pytest.raises(ValueError):
        LibraryDiscoveryItem(
            title="公開論文",
            authors=[],
            source_label="SIT Search",
            url="https://slib.shibaura-it.ac.jp/sublib/?session=secret",
            snippet=None,
            resource_ref=None,
        )
    with pytest.raises(ValueError):
        LibraryDiscoveryItem(
            title="公開論文",
            authors=[],
            source_label="SIT Search",
            url="https://slib.shibaura-it.ac.jp/sublib/#result",
            snippet=None,
            resource_ref=None,
        )


def test_library_tool_result_matching_and_public_evidence_allowlist() -> None:
    item = _item()
    result = LibraryItemReadResult(status="known", resource_ref=item.resource_ref, item=item)
    request = ChatToolResultRequest(
        tool_call_id="library-item-call",
        name="library_item_read",
        version=1,
        result=result,
    )
    assert request.name == "library_item_read"
    with pytest.raises(ValueError):
        ChatToolResultRequest(
            tool_call_id="library-item-call",
            name="library_item_read",
            version=1,
            result=LibraryCatalogSearchResult(status="known", query="x", items=[]),
        )
    assert is_derived_library_evidence(
        EvidenceLink(
            evidence_id="library-item-read-v1-0123456789abcdef",
            title="OPAC",
            source_type="library",
            locator="orbit-library://public/chat-run-1234567890",
            data_classification="public",
        )
    )


def test_fixture_library_catalog_tool_loop(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "fixture")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    with TestClient(app) as client:
        first = client.post(
            "/v1/chat/runs",
            json={
                "conversation_id": "library-fixture",
                "message": "図書館の蔵書を検索して",
                "client_tools": [{"name": "library_catalog_search", "version": 1}],
            },
        )
        assert first.status_code == 200
        pending = first.json()
        call = pending["calls"][0]
        second = client.post(
            f"/v1/chat/runs/{pending['run_id']}/tool-results",
            json={
                "tool_call_id": call["tool_call_id"],
                "name": call["name"],
                "version": 1,
                "result": {
                    "schema_version": "v1",
                    "status": "known",
                    "query": "図書館の蔵書を検索して",
                    "items": [_item().model_dump(mode="json")],
                    "reason_code": None,
                },
            },
        )
    assert second.status_code == 200
    payload = second.json()
    assert payload["status"] == "completed"
    assert "公開ロボット工学" in payload["message"]["content_markdown"]
    assert payload["message"]["evidence"][0]["data_classification"] == "public"
    assert "material" not in second.text.lower()


def test_fixture_does_not_repeat_library_search_from_history(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "fixture")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    with TestClient(app) as client:
        response = client.post(
            "/v1/chat/runs",
            json={
                "conversation_id": "library-history-gate",
                "message": "ありがとう。今日はここまでで大丈夫です。",
                "history": [
                    {"role": "user", "content": "図書館の蔵書を検索して"},
                    {"role": "assistant", "content": "検索します。"},
                ],
                "client_tools": [{"name": "library_catalog_search", "version": 1}],
            },
        )
    assert response.status_code == 200
    assert response.json()["status"] == "completed"
