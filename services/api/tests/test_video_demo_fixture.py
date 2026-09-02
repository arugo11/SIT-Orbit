from __future__ import annotations

import pytest
from orbit_api.agent.chat import FixtureChatBackend
from orbit_api.models import (
    CastSearchAppliedFilters,
    CastSearchCoverage,
    CastSearchResult,
    ChatHistoryMessage,
    EvidenceLink,
    LibraryBibliographicRecord,
    LibraryCatalogSearchResult,
    LibraryHoldingSummary,
    ScombzCourseListResult,
    ScombzCourseReadItem,
    ScombzCourseReadResult,
    ScombzCourseSummary,
    ScombzCoverage,
    SyllabusReadResult,
    SyllabusResult,
    SyllabusSearchResult,
)


def _evidence(source_type: str, evidence_id: str) -> EvidenceLink:
    locator_prefix = {
        "scombz": "orbit-scombz://read/",
        "syllabus": "orbit-syllabus://search/",
        "career": "orbit-cast://search/",
        "library": "orbit-library://public/",
    }[source_type]
    classification = "public" if source_type in {"syllabus", "library"} else "personal"
    return EvidenceLink(
        evidence_id=evidence_id,
        title="fixtureのtyped result",
        source_type=source_type,  # type: ignore[arg-type]
        locator=f"{locator_prefix}fixtureopaque0001",
        data_classification=classification,  # type: ignore[arg-type]
    )


def _coverage(scope: str) -> ScombzCoverage:
    return ScombzCoverage(
        scope=scope,
        requested=1,
        attempted=1,
        succeeded=1,
        failed=0,
    )


def _library_result(title: str, status: str, resource_suffix: str) -> LibraryCatalogSearchResult:
    if status == "unavailable":
        return LibraryCatalogSearchResult(
            status="unavailable",
            query=title,
            items=[],
            reason_code="fixture_unavailable",
        )
    if status == "normal_zero":
        return LibraryCatalogSearchResult(status="known", query=title, items=[])
    record = LibraryBibliographicRecord(
        resource_ref=f"orbit-library://record/{resource_suffix}",
        title=title,
        authors=["fixture author"],
        url="https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/fixture",
        holdings=[LibraryHoldingSummary(campus="omiya", status="available")],
    )
    return LibraryCatalogSearchResult(status="known", query=title, items=[record])


@pytest.mark.asyncio
async def test_video_demo_fixture_flow_is_linear_and_typed() -> None:
    backend = FixtureChatBackend()
    advertised = {
        "scombz_course_list",
        "scombz_course_read",
        "syllabus_search",
        "syllabus_read",
        "cast_search",
        "library_catalog_search",
    }
    history: list[ChatHistoryMessage] = []

    first_message = "何ができるの？"
    first = await backend.start_chat(
        conversation_id="video-demo-fixture",
        message=first_message,
        history=history,
        advertised_tools=advertised,
    )
    assert first.draft is not None
    assert first.deferred is None
    history.extend(
        [
            ChatHistoryMessage(role="user", content=first_message),
            ChatHistoryMessage(role="assistant", content=first.draft.content_markdown),
        ]
    )

    second_message = "人工知能の授業では、どんなことを学ぶの？"
    second = await backend.start_chat(
        conversation_id="video-demo-fixture",
        message=second_message,
        history=history,
        advertised_tools=advertised,
    )
    assert second.deferred is not None
    assert second.deferred.tool_name == "scombz_course_list"
    course_list_evidence = _evidence("scombz", "scombz-course-list-v1-fixture")
    course_list = ScombzCourseListResult(
        status="known",
        courses=[
            ScombzCourseSummary(
                course_ref="orbit-scombz://course/fixture-ai-course-0001",
                display_name="人工知能",
                academic_year=2026,
                term="前期",
            )
        ],
        coverage=_coverage("courses"),
        observed_at="2026-08-31T00:00:00Z",
    )
    second_read = await backend.resume_chat(
        deferred=second.deferred,
        tool_result=course_list,
        context=[course_list_evidence],
        tool_evidence=course_list_evidence,
        advertised_tools=advertised,
    )
    assert second_read.deferred is not None
    assert second_read.deferred.tool_name == "scombz_course_read"
    assert second_read.deferred.arguments["course_refs"] == [
        course_list.courses[0].course_ref
    ]
    course_read = ScombzCourseReadResult(
        status="known",
        items=[
            ScombzCourseReadItem(
                ref="orbit-scombz://item/fixture-ai-item-0001",
                course_ref=course_list.courses[0].course_ref,
                section="授業内容",
                title="人工知能の基礎と応用",
                body="機械学習と強化学習を扱います。",
                observed_at="2026-08-31T00:00:00Z",
            )
        ],
        section_states={"授業内容": "complete"},
        coverage=_coverage("course"),
        observed_at="2026-08-31T00:00:00Z",
    )
    second_done = await backend.resume_chat(
        deferred=second_read.deferred,
        tool_result=course_read,
        context=[course_list_evidence],
        tool_evidence=course_list_evidence,
        advertised_tools=advertised,
    )
    assert second_done.draft is not None
    history.extend(
        [
            ChatHistoryMessage(role="user", content=second_message),
            ChatHistoryMessage(role="assistant", content=second_done.draft.content_markdown),
        ]
    )

    third_message = "強化学習はどのあたり？ 授業全体での位置づけも知りたい。"
    third = await backend.start_chat(
        conversation_id="video-demo-fixture",
        message=third_message,
        history=history,
        advertised_tools=advertised,
    )
    assert third.deferred is not None
    assert third.deferred.tool_name == "syllabus_search"
    syllabus_evidence = _evidence("syllabus", "syllabus-search-v1-fixture")
    syllabus_search = SyllabusSearchResult(
        status="known",
        query=third_message,
        results=[
            SyllabusResult(
                syllabus_ref="orbit-syllabus://result/fixture-ai-result-0001",
                title="人工知能",
                url="https://syllabus.sic.shibaura-it.ac.jp/fixture/ai",
            )
        ],
        observed_at="2026-08-31T00:00:00Z",
    )
    third_read = await backend.resume_chat(
        deferred=third.deferred,
        tool_result=syllabus_search,
        context=[syllabus_evidence],
        tool_evidence=syllabus_evidence,
        advertised_tools=advertised,
    )
    assert third_read.deferred is not None
    assert third_read.deferred.tool_name == "syllabus_read"
    assert third_read.deferred.arguments["syllabus_ref"] == syllabus_search.results[0].syllabus_ref
    syllabus_read = SyllabusReadResult(
        status="known",
        syllabus_ref=syllabus_search.results[0].syllabus_ref,
        url=syllabus_search.results[0].url,
        title="人工知能",
        objectives="機械学習と強化学習の位置づけを理解する。",
        weekly_plan=["機械学習", "強化学習"],
        observed_at="2026-08-31T00:00:00Z",
    )
    third_done = await backend.resume_chat(
        deferred=third_read.deferred,
        tool_result=syllabus_read,
        context=[syllabus_evidence],
        tool_evidence=syllabus_evidence,
        advertised_tools=advertised,
    )
    assert third_done.draft is not None
    history.extend(
        [
            ChatHistoryMessage(role="user", content=third_message),
            ChatHistoryMessage(role="assistant", content=third_done.draft.content_markdown),
        ]
    )

    fourth_message = "それを仕事として体験するなら、今参加できるものはある？"
    fourth = await backend.start_chat(
        conversation_id="video-demo-fixture",
        message=fourth_message,
        history=history,
        advertised_tools=advertised,
    )
    assert fourth.deferred is not None
    assert fourth.deferred.tool_name == "cast_search"
    assert fourth.deferred.arguments["kind"] == "internship"
    assert fourth.deferred.arguments["filters"]["include_closed"] is False
    cast_evidence = _evidence("career", "cast-search-v1-fixture")
    cast_result = CastSearchResult(
        status="known",
        applied_filters=CastSearchAppliedFilters(
            kind="internship", filters={"include_closed": False}
        ),
        total_count=1,
        returned_count=1,
        coverage=CastSearchCoverage(mode="complete", page_size=20, fetched_pages=1),
    )
    fourth_done = await backend.resume_chat(
        deferred=fourth.deferred,
        tool_result=cast_result,
        context=[cast_evidence],
        tool_evidence=cast_evidence,
        advertised_tools=advertised,
    )
    assert fourth_done.draft is not None
    history.extend(
        [
            ChatHistoryMessage(role="user", content=fourth_message),
            ChatHistoryMessage(role="assistant", content=fourth_done.draft.content_markdown),
        ]
    )

    fifth_message = "理解の助けになる入門書を、3冊候補にして。"
    fifth = await backend.start_chat(
        conversation_id="video-demo-fixture",
        message=fifth_message,
        history=history,
        advertised_tools=advertised,
    )
    assert fifth.deferred is None
    assert fifth.draft is not None
    assert len(fifth.generated_related_books) == 3
    assert all(item.model_validate(item.model_dump()) for item in fifth.generated_related_books)
    history.extend(
        [
            ChatHistoryMessage(role="user", content=fifth_message),
            ChatHistoryMessage(role="assistant", content=fifth.draft.content_markdown),
        ]
    )

    sixth = await backend.start_chat(
        conversation_id="video-demo-fixture",
        message="その3冊、芝浦で今借りられる？",
        history=history,
        context=fifth.generated_evidence,
        related_book_context=fifth.generated_related_books,
        advertised_tools=advertised,
    )
    assert sixth.deferred is not None
    queries: list[str] = []
    library_evidence: list[EvidenceLink] = []
    current = sixth
    statuses = ["available", "available", "normal_zero"]
    for expected_status in statuses:
        assert current.deferred is not None
        query = current.deferred.arguments["query"]
        queries.append(query)
        evidence = _evidence(
            "library", f"library-catalog-search-v1-fixtureopaque{len(queries):04d}"
        )
        library_evidence.append(evidence)
        current = await backend.resume_chat(
            deferred=current.deferred,
            tool_result=_library_result(query, expected_status, f"fixture-{len(queries):016d}"),
            context=fifth.generated_evidence + library_evidence,
            tool_evidence=evidence,
            advertised_tools=advertised,
        )
    assert queries == [item.title for item in fifth.generated_related_books]
    assert current.draft is not None
    assert current.draft.content_markdown.count("貸出可") == 2
    assert "検索結果0件" in current.draft.content_markdown
    assert "現在確認できません" not in current.draft.content_markdown
    assert current.draft.evidence_ids == [item.evidence_id for item in library_evidence]
