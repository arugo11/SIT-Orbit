"""Bounded, evidence-grounded related-book discovery for Azure Chat.

This module deliberately does not build a catalog vector index.  It expands a
public seed into several search intents, extracts a closed candidate set from
grounded web-search results, then optionally reranks only those candidate IDs.
SIT holdings remain the responsibility of the existing deferred OPAC tools.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal, Protocol
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIResponsesModel, OpenAIResponsesModelSettings

from orbit_api.models import (
    ChatLibraryContextRecord,
    RelatedBookCandidate,
    RelatedBookCatalogVerification,
    RelatedBookRelationAxis,
)

BookDiscoveryMode = Literal["close", "balanced", "exploratory"]
BookDiscoveryFeatureMode = Literal["off", "multi_query", "semantic"]
_PRIVATE_GOAL_PATTERN = re.compile(
    r"(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|"
    r"(?<![A-Z0-9])[A-Z]{2}\d{5}(?![A-Z0-9])|"
    r"(?:oauth|access[_ -]?token|refresh[_ -]?token|api[_ -]?key|bearer)\s*[:=]?\s*\S+|"
    r"orbit-[a-z0-9-]+://|"
    r"(?:scombz|sitrus|moodle)\.[a-z0-9.-]+)",
    re.IGNORECASE,
)


class RelatedBookDiscoveryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    seed_resource_refs: list[str] = Field(default_factory=list, max_length=3)
    goal: str = Field(min_length=1, max_length=500)
    mode: BookDiscoveryMode = "balanced"
    max_results: int = Field(default=5, ge=1, le=5)

    @model_validator(mode="after")
    def unique_seeds(self) -> RelatedBookDiscoveryRequest:
        if len(set(self.seed_resource_refs)) != len(self.seed_resource_refs):
            raise ValueError("Book discovery seed refs must be unique.")
        if _PRIVATE_GOAL_PATTERN.search(self.goal):
            raise ValueError("Book discovery goals cannot contain private identifiers.")
        return self


class DiscoveryQuery(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    query_id: str = Field(pattern=r"^q[1-3]$")
    query: str = Field(min_length=1, max_length=200)
    purpose: str = Field(min_length=1, max_length=160)


class DiscoveryPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    queries: list[DiscoveryQuery] = Field(min_length=2, max_length=3)

    @model_validator(mode="after")
    def diverse_queries(self) -> DiscoveryPlan:
        ids = [item.query_id for item in self.queries]
        queries = [_normalize_text(item.query) for item in self.queries]
        purposes = [_normalize_text(item.purpose) for item in self.queries]
        if len(set(ids)) != len(ids) or len(set(queries)) != len(queries):
            raise ValueError("Discovery queries must be unique.")
        if len(set(purposes)) < 2:
            raise ValueError("Discovery queries must represent at least two purposes.")
        return self


class ExtractedRelationAxis(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    label: str = Field(min_length=1, max_length=100)
    source: Literal["explicit", "metadata", "inferred"]


class ExtractedBookCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    title: str = Field(min_length=1, max_length=300)
    authors: list[str] = Field(default_factory=list, max_length=20)
    isbn: str | None = Field(default=None, max_length=32)
    publication_year: int | None = Field(default=None, ge=1000, le=2100)
    relation_axes: list[ExtractedRelationAxis] = Field(min_length=1, max_length=5)
    why_related: str = Field(min_length=1, max_length=500)
    source_refs: list[str] = Field(min_length=1, max_length=10)
    query_ids: list[str] = Field(min_length=1, max_length=3)


class ExtractedBookCandidates(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    candidates: list[ExtractedBookCandidate] = Field(default_factory=list, max_length=20)


class SemanticCandidateUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    candidate_ref: str
    relation_axes: list[ExtractedRelationAxis] = Field(min_length=1, max_length=5)
    why_related: str = Field(min_length=1, max_length=500)


class SemanticRanking(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    candidates: list[SemanticCandidateUpdate] = Field(min_length=1, max_length=20)


@dataclass(frozen=True)
class GroundedSearchSource:
    source_ref: str
    evidence_id: str
    title: str
    url: str


@dataclass(frozen=True)
class GroundedSearchBatch:
    query_id: str
    query: str
    purpose: str
    summary: str
    sources: tuple[GroundedSearchSource, ...]


@dataclass(frozen=True)
class RelatedBookDiscoveryResult:
    status: Literal["complete", "partial"]
    candidates: tuple[RelatedBookCandidate, ...]
    searched_queries: tuple[str, ...]
    reason_code: str | None = None


SearchCallback = Callable[[DiscoveryQuery], Awaitable[GroundedSearchBatch]]


class RelatedBookDiscoveryExecutor(Protocol):
    async def discover(
        self,
        request: RelatedBookDiscoveryRequest,
        *,
        seeds: Sequence[ChatLibraryContextRecord],
        search: SearchCallback,
    ) -> RelatedBookDiscoveryResult: ...


def _normalize_text(value: str) -> str:
    return " ".join(value.casefold().split())


def _normalize_isbn(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = re.sub(r"[^0-9Xx]", "", value).upper()
    return normalized if len(normalized) in {10, 13} else None


def _candidate_identity(candidate: ExtractedBookCandidate) -> str:
    isbn = _normalize_isbn(candidate.isbn)
    if isbn:
        return f"isbn:{isbn}"
    if candidate.authors:
        return (
            f"title-author:{_normalize_text(candidate.title)}|"
            f"{_normalize_text(candidate.authors[0])}"
        )
    return (
        f"title-source:{_normalize_text(candidate.title)}|"
        f"{_normalize_text(candidate.source_refs[0])}"
    )


def _candidate_ref(identity: str) -> str:
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:32]
    return f"orbit-book://candidate/{digest}"


def _rrf(rankings: Sequence[Sequence[str]], *, k: int = 60) -> dict[str, float]:
    scores: dict[str, float] = defaultdict(float)
    for ranking in rankings:
        for rank, candidate_ref in enumerate(ranking, start=1):
            scores[candidate_ref] += 1.0 / (k + rank)
    return dict(scores)


def _source_domain_count(batches: Sequence[GroundedSearchBatch]) -> int:
    return len(
        {
            urlsplit(source.url).hostname
            for batch in batches
            for source in batch.sources
            if urlsplit(source.url).hostname
        }
    )


class AzureRelatedBookDiscoveryExecutor:
    """Azure planner/extractor/reranker with deterministic closed-world ranking."""

    def __init__(
        self,
        model: OpenAIResponsesModel,
        *,
        feature_mode: Literal["multi_query", "semantic"],
    ) -> None:
        self.model = model
        self.feature_mode = feature_mode
        self.model_settings: OpenAIResponsesModelSettings = {"openai_store": False}

    async def _plan(
        self,
        request: RelatedBookDiscoveryRequest,
        seeds: Sequence[ChatLibraryContextRecord],
    ) -> DiscoveryPlan:
        public_seeds = [
            {
                "title": seed.record.title,
                "authors": seed.record.authors,
                "isbn": seed.record.isbn,
                "subjects": seed.record.subjects,
            }
            for seed in seeds
        ]
        agent: Agent[None, DiscoveryPlan] = Agent(
            self.model,
            output_type=DiscoveryPlan,
            instructions=(
                "Create two or three materially different public-web book search queries. "
                "Use only the supplied public seed metadata and explicit goal. Each query "
                "must pursue a different relation axis, not merely paraphrase keywords. "
                "Never include opaque refs, private campus data, or invented book titles."
            ),
            model_settings=self.model_settings,
        )
        result = await agent.run(
            json.dumps(
                {
                    "goal": request.goal,
                    "mode": request.mode,
                    "public_seeds": public_seeds,
                },
                ensure_ascii=False,
            )
        )
        return result.output

    async def _extract(
        self,
        request: RelatedBookDiscoveryRequest,
        batches: Sequence[GroundedSearchBatch],
    ) -> list[ExtractedBookCandidate]:
        payload = [
            {
                "query_id": batch.query_id,
                "purpose": batch.purpose,
                "summary": batch.summary,
                "sources": [
                    {
                        "source_ref": source.source_ref,
                        "title": source.title,
                        "url": source.url,
                    }
                    for source in batch.sources
                ],
            }
            for batch in batches
        ]
        agent: Agent[None, ExtractedBookCandidates] = Agent(
            self.model,
            output_type=ExtractedBookCandidates,
            instructions=(
                "Extract at most 20 real books explicitly present in the supplied grounded "
                "search summaries or source titles. Never invent or complete a title, author, "
                "ISBN, or year. source_refs and query_ids must be copied exactly. Explain the "
                "relationship to the explicit goal using bounded axes."
            ),
            model_settings=self.model_settings,
        )
        result = await agent.run(
            json.dumps({"goal": request.goal, "searches": payload}, ensure_ascii=False)
        )
        return result.output.candidates

    @staticmethod
    def _closed_world_candidates(
        extracted: Sequence[ExtractedBookCandidate],
        batches: Sequence[GroundedSearchBatch],
    ) -> tuple[list[ExtractedBookCandidate], dict[str, GroundedSearchSource]]:
        sources = {source.source_ref: source for batch in batches for source in batch.sources}
        query_ids = {batch.query_id for batch in batches}
        corpus = _normalize_text(
            "\n".join(
                [batch.summary for batch in batches] + [source.title for source in sources.values()]
            )
        )
        accepted: list[ExtractedBookCandidate] = []
        for candidate in extracted:
            if _normalize_text(candidate.title) not in corpus:
                continue
            if any(ref not in sources for ref in candidate.source_refs):
                continue
            if any(query_id not in query_ids for query_id in candidate.query_ids):
                continue
            if candidate.isbn and _normalize_text(candidate.isbn) not in corpus:
                compact_isbn = _normalize_isbn(candidate.isbn)
                compact_corpus = re.sub(r"[^0-9Xx]", "", corpus).upper()
                if not compact_isbn or compact_isbn not in compact_corpus:
                    continue
            if any(_normalize_text(author) not in corpus for author in candidate.authors):
                continue
            accepted.append(candidate)
        return accepted, sources

    @staticmethod
    def _dedupe(extracted: Sequence[ExtractedBookCandidate]) -> list[ExtractedBookCandidate]:
        deduped: dict[str, ExtractedBookCandidate] = {}
        for candidate in extracted:
            identity = _candidate_identity(candidate)
            existing = deduped.get(identity)
            if existing is None or len(candidate.source_refs) > len(existing.source_refs):
                deduped[identity] = candidate
        return list(deduped.values())[:20]

    async def _semantic_rank(
        self,
        request: RelatedBookDiscoveryRequest,
        candidates: Sequence[RelatedBookCandidate],
    ) -> SemanticRanking:
        agent: Agent[None, SemanticRanking] = Agent(
            self.model,
            output_type=SemanticRanking,
            instructions=(
                "Rerank only the supplied candidate_ref values for the user's goal. "
                "Do not add candidates or bibliographic facts. Return each candidate at "
                "most once with concise relation axes and why_related text."
            ),
            model_settings=self.model_settings,
        )
        result = await agent.run(
            json.dumps(
                {
                    "goal": request.goal,
                    "mode": request.mode,
                    "candidates": [
                        {
                            "candidate_ref": item.candidate_ref,
                            "title": item.title,
                            "authors": item.authors,
                            "axes": [axis.model_dump() for axis in item.relation_axes],
                            "why_related": item.why_related,
                        }
                        for item in candidates
                    ],
                },
                ensure_ascii=False,
            )
        )
        allowed = {item.candidate_ref for item in candidates}
        returned = [item.candidate_ref for item in result.output.candidates]
        if len(returned) != len(set(returned)) or any(ref not in allowed for ref in returned):
            raise ValueError("Semantic reranker returned an unknown candidate.")
        return result.output

    @staticmethod
    def _diverse_top(
        ordered: Sequence[RelatedBookCandidate], max_results: int
    ) -> tuple[RelatedBookCandidate, ...]:
        selected: list[RelatedBookCandidate] = []
        author_counts: dict[str, int] = defaultdict(int)
        selected_axes: set[str] = set()

        def add(candidate: RelatedBookCandidate) -> bool:
            author_key = _normalize_text(candidate.authors[0]) if candidate.authors else ""
            if author_key and author_counts[author_key] >= 2 and len(ordered) > max_results:
                return False
            selected.append(candidate)
            if author_key:
                author_counts[author_key] += 1
            selected_axes.update(_normalize_text(axis.label) for axis in candidate.relation_axes)
            return True

        if max_results >= 2:
            for candidate in ordered:
                candidate_axes = {
                    _normalize_text(axis.label) for axis in candidate.relation_axes
                }
                if candidate_axes - selected_axes:
                    add(candidate)
                if len(selected_axes) >= 2 or len(selected) == max_results:
                    break
        selected_refs = {item.candidate_ref for item in selected}
        for candidate in ordered:
            if candidate.candidate_ref in selected_refs:
                continue
            if add(candidate):
                selected_refs.add(candidate.candidate_ref)
            if len(selected) == max_results:
                break
        return tuple(selected)

    async def discover(
        self,
        request: RelatedBookDiscoveryRequest,
        *,
        seeds: Sequence[ChatLibraryContextRecord],
        search: SearchCallback,
    ) -> RelatedBookDiscoveryResult:
        seed_refs = {seed.resource_ref for seed in seeds}
        if any(ref not in seed_refs for ref in request.seed_resource_refs):
            raise ValueError("Book discovery seed refs must exist in the Context Manifest.")
        selected_seeds = [seed for seed in seeds if seed.resource_ref in request.seed_resource_refs]
        plan = await self._plan(request, selected_seeds)
        batches = [await search(query) for query in plan.queries[:2]]
        extracted = await self._extract(request, batches)
        accepted, sources = self._closed_world_candidates(extracted, batches)
        accepted_axes = {
            _normalize_text(axis.label)
            for candidate in accepted
            for axis in candidate.relation_axes
        }
        if len(plan.queries) == 3 and (
            len(accepted) < 12
            or len(accepted_axes) < 2
            or _source_domain_count(batches) < 2
        ):
            batches.append(await search(plan.queries[2]))
            extracted = await self._extract(request, batches)
            accepted, sources = self._closed_world_candidates(extracted, batches)
        deduped = self._dedupe(accepted)
        observed_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        candidates: list[RelatedBookCandidate] = []
        query_rankings: dict[str, list[str]] = defaultdict(list)
        for item in deduped:
            identity = _candidate_identity(item)
            candidate_ref = _candidate_ref(identity)
            for query_id in item.query_ids:
                query_rankings[query_id].append(candidate_ref)
            candidates.append(
                RelatedBookCandidate(
                    candidate_ref=candidate_ref,
                    title=item.title,
                    authors=item.authors,
                    isbn=_normalize_isbn(item.isbn),
                    publication_year=item.publication_year,
                    relation_axes=[
                        RelatedBookRelationAxis(label=axis.label, source=axis.source)
                        for axis in item.relation_axes
                    ],
                    why_related=item.why_related,
                    evidence_ids=list(
                        dict.fromkeys(sources[ref].evidence_id for ref in item.source_refs)
                    ),
                    catalog_verification=RelatedBookCatalogVerification(),
                    observed_at=observed_at,
                )
            )
        keyword_scores = _rrf(list(query_rankings.values()))
        candidates.sort(key=lambda item: keyword_scores.get(item.candidate_ref, 0), reverse=True)
        status: Literal["complete", "partial"] = "complete"
        reason_code: str | None = None
        if self.feature_mode == "semantic" and candidates:
            try:
                semantic = await self._semantic_rank(request, candidates)
                allowed_refs = {item.candidate_ref for item in candidates}
                semantic_refs = [item.candidate_ref for item in semantic.candidates]
                if len(semantic_refs) != len(set(semantic_refs)) or any(
                    candidate_ref not in allowed_refs
                    for candidate_ref in semantic_refs
                ):
                    raise ValueError("Semantic reranker returned an unknown candidate.")
                update_by_ref = {item.candidate_ref: item for item in semantic.candidates}
                semantic_order = [item.candidate_ref for item in semantic.candidates]
                combined = _rrf([[item.candidate_ref for item in candidates], semantic_order])
                candidates = [
                    item.model_copy(
                        update={
                            "relation_axes": [
                                RelatedBookRelationAxis(
                                    label=axis.label,
                                    source=axis.source,
                                )
                                for axis in update_by_ref[item.candidate_ref].relation_axes
                            ],
                            "why_related": update_by_ref[item.candidate_ref].why_related,
                        }
                    )
                    if item.candidate_ref in update_by_ref
                    else item
                    for item in candidates
                ]
                candidates.sort(key=lambda item: combined.get(item.candidate_ref, 0), reverse=True)
            except Exception:
                status = "partial"
                reason_code = "semantic_comparison_failed"
        return RelatedBookDiscoveryResult(
            status=status,
            candidates=self._diverse_top(candidates, request.max_results),
            searched_queries=tuple(batch.query for batch in batches),
            reason_code=reason_code,
        )


__all__ = [
    "AzureRelatedBookDiscoveryExecutor",
    "BookDiscoveryFeatureMode",
    "DiscoveryQuery",
    "GroundedSearchBatch",
    "GroundedSearchSource",
    "RelatedBookDiscoveryExecutor",
    "RelatedBookDiscoveryRequest",
    "RelatedBookDiscoveryResult",
]
