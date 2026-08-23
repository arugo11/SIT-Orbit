import pytest
from orbit_api.agent.chat import ChatRunService, FixtureChatBackend
from orbit_api.models import (
    ChatClientTool,
    ChatContextManifest,
    ChatLibraryContextRecord,
    ChatRunRequest,
    ChatToolResultRequest,
    EvidenceLink,
    LibraryBibliographicRecord,
    LibraryHoldingSummary,
    LibraryItemReadResult,
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


@pytest.mark.asyncio
async def test_fixture_uses_manifest_ref_for_elliptical_follow_up(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_AGENT_BACKEND", "fixture")
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    service = ChatRunService(backend_factory=FixtureChatBackend)
    first = await service.start(
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
    assert first.status == "tool_required"
    assert first.calls[0].name == "library_item_read"
    assert first.calls[0].arguments["resource_ref"] == public_record().resource_ref

    completed = await service.submit_tool_result(
        first.run_id,
        ChatToolResultRequest(
            tool_call_id=first.calls[0].tool_call_id,
            name="library_item_read",
            version=1,
            result=LibraryItemReadResult(
                status="known",
                resource_ref=public_record().resource_ref,
                item=public_record(),
                reason_code=None,
            ),
        ),
    )
    assert completed.status == "completed"
    assert "ロボット工学" in completed.message.content_markdown


def test_manifest_round_trip_request_accepts_old_client_shape() -> None:
    request = ChatRunRequest(
        conversation_id="old-client",
        message="質問",
        history=[],
        client_tools=[],
    )
    assert request.context_manifest is None
