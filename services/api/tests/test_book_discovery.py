from __future__ import annotations

from typing import Any

import pytest
from orbit_api.agent.azure_openai_backend import AzureOpenAIAgent
from orbit_api.agent.book_discovery import (
    AzureRelatedBookDiscoveryExecutor,
    DiscoveryPlan,
    DiscoveryQuery,
    ExtractedBookCandidate,
    ExtractedRelationAxis,
    GroundedSearchBatch,
    GroundedSearchSource,
    RelatedBookDiscoveryRequest,
    RelatedBookDiscoveryResult,
    SemanticCandidateUpdate,
    SemanticRanking,
)
from orbit_api.agent.pydantic_ai_backend import (
    LIBRARY_CATALOG_SEARCH_TOOL_NAME,
    ChatDraft,
    library_catalog_search,
)
from orbit_api.agent.web_search import WebSearchResponse, WebSearchSource
from orbit_api.models import (
    ChatContextManifest,
    EvidenceLink,
    LibraryBibliographicRecord,
    LibraryCatalogSearchResult,
    LibraryHoldingSummary,
    RelatedBookCandidate,
    RelatedBookRelationAxis,
)
from pydantic_ai import Agent, DeferredToolRequests
from pydantic_ai._tool_search import NativeToolSearchReturnPart
from pydantic_ai.messages import ModelResponse, ToolCallPart
from pydantic_ai.models.function import FunctionModel


class DeterministicDiscovery(AzureRelatedBookDiscoveryExecutor):
    def __init__(self, *, semantic: bool = True, unknown_semantic_ref: bool = False) -> None:
        self.feature_mode = "semantic" if semantic else "multi_query"
        self.unknown_semantic_ref = unknown_semantic_ref

    async def _plan(self, request, seeds):
        del request, seeds
        return DiscoveryPlan(
            queries=[
                DiscoveryQuery(
                    query_id="q1",
                    query="robot learning books reinforcement control",
                    purpose="強化学習による制御",
                ),
                DiscoveryQuery(
                    query_id="q2",
                    query="embodied intelligence robotics books perception action",
                    purpose="身体性と知覚行動ループ",
                ),
                DiscoveryQuery(
                    query_id="q3",
                    query="human robot interaction critical books",
                    purpose="人間との協働と批判的視点",
                ),
            ]
        )

    async def _extract(self, request, batches):
        del request
        extracted = [
            ExtractedBookCandidate(
                title="Robot Learning",
                authors=["Jane Doe"],
                isbn="9780000000001",
                publication_year=2024,
                relation_axes=[
                    ExtractedRelationAxis(label="強化学習", source="metadata")
                ],
                why_related="学習によるロボット制御を扱う。",
                source_refs=["q1-s1"],
                query_ids=["q1"],
            ),
            ExtractedBookCandidate(
                title="Embodied Intelligence",
                authors=["Alex Smith"],
                isbn="9780000000002",
                publication_year=2023,
                relation_axes=[
                    ExtractedRelationAxis(label="身体性", source="inferred")
                ],
                why_related="知覚と行動の循環を別の観点から扱う。",
                source_refs=["q2-s1"],
                query_ids=["q2"],
            ),
        ]
        if len(batches) == 3:
            extracted.append(
                ExtractedBookCandidate(
                    title="Human-Robot Interaction",
                    authors=["Pat Lee"],
                    isbn="9780000000003",
                    publication_year=2022,
                    relation_axes=[
                        ExtractedRelationAxis(label="協働", source="explicit")
                    ],
                    why_related="人間とロボットの協働を比較できる。",
                    source_refs=["q3-s1"],
                    query_ids=["q3"],
                )
            )
        return extracted

    async def _semantic_rank(self, request, candidates):
        del request
        if self.unknown_semantic_ref:
            return SemanticRanking(
                candidates=[
                    SemanticCandidateUpdate(
                        candidate_ref="orbit-book://candidate/unknownunknown0000",
                        relation_axes=[
                            ExtractedRelationAxis(label="未知", source="inferred")
                        ],
                        why_related="未知候補",
                    )
                ]
            )
        return SemanticRanking(
            candidates=[
                SemanticCandidateUpdate(
                    candidate_ref=item.candidate_ref,
                    relation_axes=[
                        ExtractedRelationAxis(
                            label=item.relation_axes[0].label,
                            source=item.relation_axes[0].source,
                        )
                    ],
                    why_related=item.why_related,
                )
                for item in reversed(candidates)
            ]
        )


def _batch(query: DiscoveryQuery) -> GroundedSearchBatch:
    books = {
        "q1": ("Robot Learning", "Jane Doe", "9780000000001", "books.example"),
        "q2": (
            "Embodied Intelligence",
            "Alex Smith",
            "9780000000002",
            "publisher.example",
        ),
        "q3": (
            "Human-Robot Interaction",
            "Pat Lee",
            "9780000000003",
            "reviews.example",
        ),
    }
    title, author, isbn, domain = books[query.query_id]
    return GroundedSearchBatch(
        query_id=query.query_id,
        query=query.query,
        purpose=query.purpose,
        summary=f"{title} by {author}, ISBN {isbn}",
        sources=(
            GroundedSearchSource(
                source_ref=f"{query.query_id}-s1",
                evidence_id=f"web-search-v1-{query.query_id}-source",
                title=f"{title} by {author} {isbn}",
                url=f"https://{domain}/{query.query_id}",
            ),
        ),
    )


@pytest.mark.asyncio
async def test_multi_query_discovers_candidates_outside_first_keyword_axis() -> None:
    calls: list[str] = []

    async def search(query: DiscoveryQuery) -> GroundedSearchBatch:
        calls.append(query.query_id)
        return _batch(query)

    result = await DeterministicDiscovery().discover(
        RelatedBookDiscoveryRequest(goal="機械学習とロボットの関連書籍", max_results=5),
        seeds=[],
        search=search,
    )

    assert calls == ["q1", "q2", "q3"]
    assert result.status == "complete"
    assert {item.title for item in result.candidates} == {
        "Robot Learning",
        "Embodied Intelligence",
        "Human-Robot Interaction",
    }
    assert len({axis.label for item in result.candidates for axis in item.relation_axes}) >= 2


@pytest.mark.asyncio
async def test_unknown_semantic_candidate_is_explicit_partial() -> None:
    async def search(query: DiscoveryQuery) -> GroundedSearchBatch:
        return _batch(query)

    result = await DeterministicDiscovery(unknown_semantic_ref=True).discover(
        RelatedBookDiscoveryRequest(goal="関連書籍", max_results=2),
        seeds=[],
        search=search,
    )

    assert result.status == "partial"
    assert result.reason_code == "semantic_comparison_failed"
    assert result.candidates


def test_context_manifest_rejects_unknown_related_book_evidence() -> None:
    candidate = RelatedBookCandidate(
        candidate_ref="orbit-book://candidate/1234567890abcdef",
        title="Robot Learning",
        authors=["Jane Doe"],
        relation_axes=[RelatedBookRelationAxis(label="強化学習", source="metadata")],
        why_related="関連する。",
        evidence_ids=["web-search-v1-missing"],
        observed_at="2026-08-24T00:00:00Z",
    )

    with pytest.raises(ValueError, match="unknown evidence"):
        ChatContextManifest(related_books=[candidate])


def test_context_manifest_accepts_grounded_unverified_candidate() -> None:
    evidence = EvidenceLink(
        evidence_id="web-search-v1-source-1",
        title="公開書誌",
        source_type="web",
        locator="https://books.example/item",
        data_classification="public",
    )
    candidate_data: dict[str, Any] = {
        "candidate_ref": "orbit-book://candidate/1234567890abcdef",
        "title": "Robot Learning",
        "authors": ["Jane Doe"],
        "relation_axes": [{"label": "強化学習", "source": "metadata"}],
        "why_related": "関連する。",
        "evidence_ids": [evidence.evidence_id],
        "observed_at": "2026-08-24T00:00:00Z",
    }

    manifest = ChatContextManifest(
        evidence=[evidence],
        related_books=[RelatedBookCandidate.model_validate(candidate_data)],
    )

    assert manifest.related_books[0].catalog_verification.status == "unverified"


def test_book_discovery_requires_azure_web_search(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_BOOK_DISCOVERY", "semantic")
    monkeypatch.setenv("ORBIT_WEB_SEARCH", "off")

    with pytest.raises(RuntimeError, match="ORBIT_WEB_SEARCH=azure"):
        AzureOpenAIAgent(
            api_key="synthetic-key",
            model="gpt-5-6-terra",
            endpoint="https://example.openai.azure.com",
            base_model="gpt-5.6-terra",
        )


def test_book_discovery_requires_native_azure_profile(monkeypatch) -> None:
    monkeypatch.setenv("ORBIT_BOOK_DISCOVERY", "multi_query")
    with pytest.raises(ValueError, match="AZURE_OPENAI_BASE_MODEL|canonical"):
        AzureOpenAIAgent(
            api_key="synthetic-key",
            model="gpt-5-6-terra",
            endpoint="https://example.openai.azure.com",
            base_model="gpt-5.6-sol",
        )


class FakeWebSearchExecutor:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def search(self, query: str) -> WebSearchResponse:
        self.calls.append(query)
        return WebSearchResponse(
            query=query,
            summary="Robot Learning by Jane Doe ISBN 9780000000001",
            sources=(
                WebSearchSource(
                    title="Robot Learning by Jane Doe 9780000000001",
                    url=f"https://books.example/{len(self.calls)}",
                ),
            ),
        )


class FakeRelatedBookExecutor:
    async def discover(self, request, *, seeds, search):
        del request, seeds
        first = await search(
            DiscoveryQuery(
                query_id="q1",
                query="robot learning control books",
                purpose="制御学習",
            )
        )
        await search(
            DiscoveryQuery(
                query_id="q2",
                query="embodied robotics learning books",
                purpose="身体性",
            )
        )
        return RelatedBookDiscoveryResult(
            status="complete",
            candidates=(
                RelatedBookCandidate(
                    candidate_ref="orbit-book://candidate/1234567890abcdef",
                    title="Robot Learning",
                    authors=["Jane Doe"],
                    isbn="9780000000001",
                    publication_year=2024,
                    relation_axes=[
                        RelatedBookRelationAxis(label="制御学習", source="metadata")
                    ],
                    why_related="学習による制御を扱う。",
                    evidence_ids=[first.sources[0].evidence_id],
                    observed_at="2026-08-24T00:00:00Z",
                ),
            ),
            searched_queries=("robot learning control books", "embodied robotics learning books"),
        )


@pytest.mark.asyncio
async def test_function_model_discovery_then_opac_verification_shares_budget(
    monkeypatch,
) -> None:
    monkeypatch.setenv("ORBIT_OBSERVABILITY", "off")
    web = FakeWebSearchExecutor()
    calls = 0

    def model_function(messages, _info):
        nonlocal calls
        calls += 1
        if calls == 1:
            return ModelResponse(
                parts=[
                    NativeToolSearchReturnPart(
                        content={
                            "discovered_tools": [
                                {"name": "related_book_discovery"},
                                {"name": LIBRARY_CATALOG_SEARCH_TOOL_NAME},
                            ]
                        }
                    ),
                    ToolCallPart(
                        "related_book_discovery",
                        {
                            "seed_resource_refs": [],
                            "goal": "ロボット学習の関連書籍",
                            "mode": "balanced",
                            "max_results": 3,
                        },
                        tool_call_id="discovery-1",
                    )
                ]
            )
        if calls == 2:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        LIBRARY_CATALOG_SEARCH_TOOL_NAME,
                        {"query": "9780000000001", "limit": 10},
                        tool_call_id="catalog-1",
                    )
                ]
            )
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "final_result",
                    {
                        "content_markdown": "関連書籍とSIT所蔵を確認しました。",
                        "evidence_ids": ["library-catalog-search-v1-testresult00000001"],
                        "related_book_candidate_refs": [
                            "orbit-book://candidate/1234567890abcdef"
                        ],
                    },
                    tool_call_id="final-1",
                )
            ]
        )

    backend = AzureOpenAIAgent(
        api_key="synthetic-key",
        model="gpt-5-6-terra",
        endpoint="https://example.openai.azure.com",
        base_model="gpt-5.6-terra",
    )
    backend.web_search_executor = web  # type: ignore[assignment]
    backend.book_discovery_executor = FakeRelatedBookExecutor()  # type: ignore[assignment]

    def make_agent(
        *,
        advertised_tools,
        web_search_state=None,
        book_discovery_state=None,
    ):
        del advertised_tools, web_search_state
        tools = [library_catalog_search]
        if book_discovery_state is not None:
            tools.append(book_discovery_state.related_book_discovery)
        return Agent(
            FunctionModel(model_function, model_name="book-discovery-test"),
            output_type=[ChatDraft, DeferredToolRequests],
            instructions="test",
            tools=tools,
        )

    backend._chat_agent = make_agent  # type: ignore[method-assign]
    first = await backend.start_chat(
        conversation_id="book-discovery-flow",
        message="ロボット学習に関連する本を探して",
        history=[],
        advertised_tools={LIBRARY_CATALOG_SEARCH_TOOL_NAME},
    )

    assert first.deferred is not None
    # The related-book server tool performs two bounded public searches; both
    # contribute to the shared external-tool budget before the deferred OPAC call.
    assert first.deferred.tool_call_count == 3
    assert len(first.generated_evidence) == 2
    assert len(first.generated_related_books) == 1

    evidence = EvidenceLink(
        evidence_id="library-catalog-search-v1-testresult00000001",
        title="芝浦工業大学公式OPAC",
        source_type="library",
        locator="orbit-library://public/testresult00000001",
        data_classification="public",
    )
    record = LibraryBibliographicRecord(
        resource_ref="orbit-library://record/abcdef1234567890",
        title="Robot Learning",
        authors=["Jane Doe"],
        isbn="9780000000001",
        publication_year=2024,
        format="book",
        campus="toyosu",
        url=(
            "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/BB12345678"
        ),
        holdings=[
            LibraryHoldingSummary(
                campus="toyosu",
                location="豊洲（拡張）図書",
                call_number="548.3/D01",
                status="available",
                reservation_count=0,
            )
        ],
    )
    resumed = await backend.resume_chat(
        deferred=first.deferred,
        tool_result=LibraryCatalogSearchResult(
            status="known",
            query="9780000000001",
            items=[record],
        ),
        context=[*first.generated_evidence, evidence],
        advertised_tools={LIBRARY_CATALOG_SEARCH_TOOL_NAME},
    )

    assert resumed.draft is not None
    assert resumed.generated_related_books[0].catalog_verification.status == "verified"
    assert (
        resumed.generated_related_books[0].catalog_verification.resource_ref
        == record.resource_ref
    )
    assert web.calls == [
        "robot learning control books",
        "embodied robotics learning books",
    ]
