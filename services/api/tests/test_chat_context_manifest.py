import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from orbit_api.agent.chat import ChatRunService, FixtureChatBackend
from orbit_api.main import app
from orbit_api.models import (
    ChatAssistantMessage,
    ChatClientTool,
    ChatContextManifest,
    ChatLibraryContextRecord,
    ChatRunCompleted,
    ChatRunRequest,
    EvidenceLink,
    LibraryBibliographicRecord,
    LibraryHoldingSummary,
)
from pydantic import ValidationError


def public_record() -> LibraryBibliographicRecord:
    return LibraryBibliographicRecord(
        resource_ref="orbit-library://record/1234567890abcdef",
        title="ロボット工学",
        authors=["著者"],
        subjects=["ロボット"],
        isbn=None,
        publisher=None,
        publication_year=2020,
        format="book",
        campus="omiya",
        url="https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/ABC",
        holdings=[
            LibraryHoldingSummary(
                campus="omiya",
                location="大宮図書館 3階",
                call_number="548.3/R1",
                status="available",
                due_date=None,
                reservation_count=0,
            )
        ],
        related_records=[],
    )


def public_manifest() -> ChatContextManifest:
    evidence = EvidenceLink(
        evidence_id="library-catalog-search-v1-1234567890abcdef",
        title="公式OPAC",
        source_type="library",
        locator="orbit-library://public/catalog",
        data_classification="public",
    )
    return ChatContextManifest(
        evidence=[evidence],
        library_records=[
            ChatLibraryContextRecord(
                resource_ref=public_record().resource_ref,
                record=public_record(),
                evidence_ids=[evidence.evidence_id],
                observed_at="2026-08-23T00:00:00Z",
            )
        ],
    )


def test_manifest_rejects_unknown_evidence_and_query_url() -> None:
    with pytest.raises(ValidationError):
        ChatContextManifest(
            evidence=[],
            library_records=[
                ChatLibraryContextRecord(
                    resource_ref=public_record().resource_ref,
                    record=public_record(),
                    evidence_ids=["missing"],
                    observed_at="2026-08-23T00:00:00Z",
                )
            ],
        )
    with pytest.raises(ValidationError):
        ChatLibraryContextRecord(
            resource_ref="orbit-library://record/abcdef1234567890",
            record=public_record(),
            evidence_ids=[],
            observed_at="2026-08-23T00:00:00Z",
        )
    with pytest.raises(ValidationError):
        LibraryBibliographicRecord(
            **public_record().model_dump(
                mode="python",
                exclude={"url"},
            ),
            url="https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/ABC?x=1",
        )


def test_completed_response_allows_identical_mirrored_evidence() -> None:
    evidence = EvidenceLink(
        evidence_id="web-evidence-1",
        title="公開書誌",
        source_type="web",
        locator="https://example.com/book",
        data_classification="public",
    )
    completed = ChatRunCompleted(
        status="completed",
        message=ChatAssistantMessage(
            message_id="message-1",
            content_markdown="確認しました。",
            evidence=[evidence],
        ),
        context_manifest=ChatContextManifest(evidence=[evidence]),
    )
    assert completed.context_manifest is not None
    assert completed.message.evidence == completed.context_manifest.evidence


def test_completed_response_rejects_conflicting_mirrored_evidence() -> None:
    message_evidence = EvidenceLink(
        evidence_id="web-evidence-conflict",
        title="公開書誌",
        source_type="web",
        locator="https://example.com/book",
        data_classification="public",
    )
    manifest_evidence = EvidenceLink(
        evidence_id=message_evidence.evidence_id,
        title="別の書誌",
        source_type="web",
        locator=message_evidence.locator,
        data_classification="public",
    )
    with pytest.raises(ValidationError, match="conflicting evidence"):
        ChatRunCompleted(
            status="completed",
            message=ChatAssistantMessage(
                message_id="message-conflict",
                content_markdown="確認しました。",
                evidence=[message_evidence],
            ),
            context_manifest=ChatContextManifest(evidence=[manifest_evidence]),
        )


def test_manifest_repairs_identical_duplicate_evidence() -> None:
    evidence = EvidenceLink(
        evidence_id="context-duplicate",
        title="公開書誌",
        source_type="web",
        locator="https://example.com/book",
        data_classification="public",
    )
    manifest = ChatContextManifest(evidence=[evidence, evidence.model_copy()])
    assert manifest.evidence == [evidence]


def test_manifest_allows_only_opaque_scombz_personal_evidence() -> None:
    evidence = EvidenceLink(
        evidence_id="scombz-course-read-v1-1234567890abcdef",
        title="SCombZ授業情報（確認時点）",
        source_type="scombz",
        locator="orbit-scombz://citation/1234567890abcdef",
        data_classification="personal",
    )
    manifest = ChatContextManifest(evidence=[evidence])
    assert manifest.evidence == [evidence]

    with pytest.raises(ValidationError):
        ChatContextManifest(
            evidence=[
                evidence.model_copy(
                    update={"locator": "https://scombz.shibaura-it.ac.jp/lms/course"}
                )
            ]
        )


def test_chat_request_repairs_identical_duplicate_manifest_evidence() -> None:
    evidence = {
        "evidence_id": "context-request-duplicate",
        "title": "公開書誌",
        "source_type": "web",
        "locator": "https://example.com/book",
        "data_classification": "public",
    }
    with TestClient(app) as client:
        response = client.post(
            "/v1/chat/runs",
            json={
                "conversation_id": "context-request-duplicate",
                "message": "質問",
                "context_manifest": {
                    "schema_version": "v1",
                    "evidence": [evidence, {**evidence}],
                    "library_records": [],
                    "related_books": [],
                },
            },
        )
    assert response.status_code == 200


def test_manifest_conflict_is_classified_without_reflecting_values() -> None:
    evidence = {
        "evidence_id": "context-secret-id",
        "title": "公開書誌",
        "source_type": "web",
        "locator": "https://example.com/book",
        "data_classification": "public",
    }
    with TestClient(app) as client:
        response = client.post(
            "/v1/chat/runs",
            json={
                "conversation_id": "context-validation",
                "message": "質問",
                "context_manifest": {
                    "schema_version": "v1",
                    "evidence": [evidence, {**evidence, "title": "別の書誌"}],
                    "library_records": [],
                    "related_books": [],
                },
            },
        )
    assert response.status_code == 422
    payload = response.json()
    assert payload["detail"]["field"] == "context_manifest"
    assert payload["detail"]["error_type"] == "value_error"
    assert "context-secret-id" not in response.text
    assert "公開書誌" not in response.text


def test_shared_completed_response_fixture_is_accepted_by_python_request_model() -> None:
    fixture_path = (
        Path(__file__).resolve().parents[3]
        / "packages"
        / "api-client"
        / "fixtures"
        / "chat_context_roundtrip.json"
    )
    payload = json.loads(fixture_path.read_text(encoding="utf-8"))
    completed = ChatRunCompleted.model_validate(payload["completed_response"])
    request = ChatRunRequest.model_validate(payload["next_request"])
    assert completed.context_manifest is not None
    assert request.context_manifest is not None
    assert len(request.context_manifest.evidence) == 1


@pytest.mark.asyncio
async def test_fixture_does_not_select_a_tool_from_an_elliptical_follow_up() -> None:
    service = ChatRunService(backend_factory=FixtureChatBackend)
    response = await service.start(
        ChatRunRequest(
            conversation_id="manifest-follow-up",
            message="その本はどこに配架されてる？",
            history=[],
            client_tools=[
                ChatClientTool(name="library_catalog_search", version=1),
                ChatClientTool(name="library_item_read", version=1),
            ],
            context_manifest=public_manifest(),
        )
    )
    assert isinstance(response, ChatRunCompleted)
    assert response.message.content_markdown == FixtureChatBackend._MESSAGE
    assert response.message.evidence == []


def test_manifest_round_trip_request_accepts_old_client_shape() -> None:
    request = ChatRunRequest(
        conversation_id="old-client",
        message="質問",
        history=[],
        client_tools=[],
    )
    assert request.context_manifest is None


@pytest.mark.asyncio
async def test_fixture_does_not_recognize_natural_book_discovery_request() -> None:
    service = ChatRunService(backend_factory=FixtureChatBackend)
    response = await service.start(
        ChatRunRequest(
            conversation_id="natural-book-search",
            message="ロボットに関する本を探して",
            history=[],
            client_tools=[ChatClientTool(name="library_catalog_search", version=1)],
        )
    )

    assert isinstance(response, ChatRunCompleted)
    assert response.message.content_markdown == FixtureChatBackend._MESSAGE


@pytest.mark.asyncio
async def test_fixture_does_not_select_my_library_from_a_loan_question() -> None:
    service = ChatRunService(backend_factory=FixtureChatBackend)
    response = await service.start(
        ChatRunRequest(
            conversation_id="loan-question-priority",
            message="図書館で借りている本は？",
            history=[],
            client_tools=[
                ChatClientTool(name="library_catalog_search", version=1),
                ChatClientTool(name="my_library_read", version=1),
            ],
        )
    )

    assert isinstance(response, ChatRunCompleted)
    assert response.message.content_markdown == FixtureChatBackend._MESSAGE
