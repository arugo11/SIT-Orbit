"""Canonical metadata for read-only Chat client tools.

The public wire contract remains ``ChatToolName`` in the Pydantic models.  This
module attaches runtime policy and evidence metadata to those names so the API,
model backend, and evidence ledger do not maintain independent tool lists.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal, get_args

from pydantic import BaseModel

from orbit_api.models import (
    BrowserReadResult,
    CalendarAvailabilityResult,
    CastAlumniReadResult,
    CastCareerSearchResult,
    CastReadResult,
    CastSearchResult,
    LegacyMyLibraryReadResult,
    LibraryActionOptionsResult,
    LibraryCatalogBrowseResult,
    LibraryCatalogSearchResult,
    LibraryDiscoverySearchResult,
    LibraryItemReadResult,
    MoodleReadResult,
    ScombzCourseListResult,
    ScombzCourseReadResult,
    ScombzMaterialSearchResult,
    ScombzPageSummaryResult,
    ScombzPortalReadResult,
    ScombzReadResult,
    ScopedMyLibraryReadResult,
    SitrusGradeResult,
    SyllabusReadResult,
    SyllabusSearchResult,
)
from orbit_api.models.agent import ChatToolName

ToolAvailability = Literal["default", "live_scombz", "live_sitrus"]
EvidenceClassification = Literal["public", "personal", "from_result"]
EvidenceLocatorMode = Literal["uuid", "run", "resource_ref"]


class ToolFamily(StrEnum):
    SCOMBZ = "scombz"
    CALENDAR = "calendar"
    SYLLABUS = "syllabus"
    BROWSER = "browser"
    SITRUS = "sitrus"
    MOODLE = "moodle"
    MY_LIBRARY = "my_library"
    CAST = "cast"
    LIBRARY = "library"


@dataclass(frozen=True, slots=True)
class ToolSpec:
    name: ChatToolName
    family: ToolFamily
    description: str
    result_types: tuple[type[BaseModel], ...]
    handler_name: str
    evidence_title: str
    evidence_source_type: str
    evidence_id_prefix: str
    evidence_locator_prefix: str
    evidence_classification: EvidenceClassification
    evidence_locator_mode: EvidenceLocatorMode = "uuid"
    availability: ToolAvailability = "default"
    version: Literal[1] = 1
    read_only: Literal[True] = True
    external_model_allowed: bool = True


def _spec(
    name: ChatToolName,
    family: ToolFamily,
    description: str,
    result_types: tuple[type[BaseModel], ...],
    *,
    title: str,
    source_type: str,
    evidence_prefix: str,
    locator_prefix: str,
    classification: EvidenceClassification = "personal",
    locator_mode: EvidenceLocatorMode = "uuid",
    availability: ToolAvailability = "default",
    external_model_allowed: bool = True,
) -> ToolSpec:
    return ToolSpec(
        name=name,
        family=family,
        description=description,
        result_types=result_types,
        handler_name=name,
        evidence_title=title,
        evidence_source_type=source_type,
        evidence_id_prefix=evidence_prefix,
        evidence_locator_prefix=locator_prefix,
        evidence_classification=classification,
        evidence_locator_mode=locator_mode,
        availability=availability,
        external_model_allowed=external_model_allowed,
    )


TOOL_SPECS: tuple[ToolSpec, ...] = (
    _spec(
        "scombz_page_summary",
        ToolFamily.SCOMBZ,
        "Read a minimized summary of the currently visible SCombZ page.",
        (ScombzPageSummaryResult,),
        title="SCombZページから導出したページ概要",
        source_type="scombz",
        evidence_prefix="scombz-page-summary-v1",
        locator_prefix="orbit-scombz://page-summary/",
    ),
    _spec(
        "scombz_read",
        ToolFamily.SCOMBZ,
        "Read structured sections from the currently visible SCombZ page.",
        (ScombzReadResult,),
        title="SCombZから取得した表示情報",
        source_type="scombz",
        evidence_prefix="scombz-read-v1",
        locator_prefix="orbit-scombz://read/",
    ),
    _spec(
        "scombz_course_list",
        ToolFamily.SCOMBZ,
        "List authenticated courses and timetable entries without opening exams.",
        (ScombzCourseListResult,),
        title="SCombZから取得した学生向け情報",
        source_type="scombz",
        evidence_prefix="scombz-course-list-v1",
        locator_prefix="orbit-scombz://read/",
        availability="live_scombz",
    ),
    _spec(
        "scombz_portal_read",
        ToolFamily.SCOMBZ,
        "Read authenticated portal notices and published student information.",
        (ScombzPortalReadResult,),
        title="SCombZから取得した学生向け情報",
        source_type="scombz",
        evidence_prefix="scombz-portal-read-v1",
        locator_prefix="orbit-scombz://read/",
        availability="live_scombz",
    ),
    _spec(
        "scombz_course_read",
        ToolFamily.SCOMBZ,
        "Read published course tasks, announcements, and selected course sections.",
        (ScombzCourseReadResult,),
        title="SCombZから取得した学生向け情報",
        source_type="scombz",
        evidence_prefix="scombz-course-read-v1",
        locator_prefix="orbit-scombz://read/",
        availability="live_scombz",
    ),
    _spec(
        "scombz_material_search",
        ToolFamily.SCOMBZ,
        "Search question-relevant text extracted locally from selected course material.",
        (ScombzMaterialSearchResult,),
        title="SCombZから取得した学生向け情報",
        source_type="scombz",
        evidence_prefix="scombz-material-search-v1",
        locator_prefix="orbit-scombz://read/",
        availability="live_scombz",
    ),
    _spec(
        "google_calendar_availability",
        ToolFamily.CALENDAR,
        "Read derived free-time intervals without event titles or participants.",
        (CalendarAvailabilityResult,),
        title="Google Calendarから導出した空き時間",
        source_type="calendar",
        evidence_prefix="calendar-availability-v1",
        locator_prefix="orbit-calendar://availability/",
    ),
    _spec(
        "syllabus_search",
        ToolFamily.SYLLABUS,
        "Search the public official SIT syllabus.",
        (SyllabusSearchResult,),
        title="芝浦工業大学公式シラバス検索",
        source_type="syllabus",
        evidence_prefix="syllabus-search-v1",
        locator_prefix="orbit-syllabus://search/",
        classification="public",
    ),
    _spec(
        "syllabus_read",
        ToolFamily.SYLLABUS,
        "Read one public official syllabus result by opaque reference.",
        (SyllabusReadResult,),
        title="芝浦工業大学公式シラバス詳細",
        source_type="syllabus",
        evidence_prefix="syllabus-read-v1",
        locator_prefix="orbit-syllabus://search/",
        classification="public",
    ),
    _spec(
        "browser_read_url",
        ToolFamily.BROWSER,
        "Read minimized visible content from one validated user-authorized URL.",
        (BrowserReadResult,),
        title="許可されたWebページの表示情報",
        source_type="web",
        evidence_prefix="browser-read-v1",
        locator_prefix="orbit-browser://read/",
        classification="from_result",
    ),
    _spec(
        "sitrus_read",
        ToolFamily.SITRUS,
        "Read authenticated SITRUS grades and acquired-credit totals for the current user.",
        (SitrusGradeResult,),
        title="SITRUSから取得した成績の最小化表示",
        source_type="learning_history",
        evidence_prefix="sitrus-grades-v1",
        locator_prefix="orbit-sitrus://grades/",
        availability="live_sitrus",
    ),
    _spec(
        "moodle_read",
        ToolFamily.MOODLE,
        "Read minimized aggregates from the explicitly opened Moodle dashboard.",
        (MoodleReadResult,),
        title="Moodleから導出した学習状況の概要",
        source_type="assignment",
        evidence_prefix="moodle-summary-v1",
        locator_prefix="orbit-moodle://summary/",
    ),
    _spec(
        "my_library_read",
        ToolFamily.MY_LIBRARY,
        "Read one explicitly requested My Library scope with bounded paging.",
        (LegacyMyLibraryReadResult, ScopedMyLibraryReadResult),
        title="My Libraryから導出した利用状況の概要",
        source_type="library",
        evidence_prefix="my-library-summary-v1",
        locator_prefix="orbit-library://summary/",
    ),
    _spec(
        "cast_read",
        ToolFamily.CAST,
        "Read minimized aggregates from the explicitly opened CAST dashboard.",
        (CastReadResult,),
        title="CASTから導出したキャリア情報の概要",
        source_type="career",
        evidence_prefix="cast-summary-v1",
        locator_prefix="orbit-cast://summary/",
    ),
    _spec(
        "cast_alumni_read",
        ToolFamily.CAST,
        "Read a pseudonymized typed CAST alumni-support projection.",
        (CastAlumniReadResult,),
        title="CASTから取得した就活サポーター情報（一般化）",
        source_type="career",
        evidence_prefix="cast-alumni-v1",
        locator_prefix="orbit-cast://alumni/",
        classification="from_result",
    ),
    _spec(
        "cast_search",
        ToolFamily.CAST,
        "Search authenticated CAST surfaces using semantic filters and return aggregates.",
        (CastSearchResult,),
        title="CAST検索から導出した匿名集計",
        source_type="career",
        evidence_prefix="cast-search-v1",
        locator_prefix="orbit-cast://search/",
    ),
    _spec(
        "cast_career_search",
        ToolFamily.CAST,
        "Search selected authenticated CAST surfaces and return anonymous aggregates.",
        (CastCareerSearchResult,),
        title="CAST横断検索から導出した匿名集計",
        source_type="career",
        evidence_prefix="cast-career-search-v1",
        locator_prefix="orbit-cast://career-search/",
    ),
    _spec(
        "library_catalog_search",
        ToolFamily.LIBRARY,
        "Search the public official SIT OPAC catalog.",
        (LibraryCatalogSearchResult,),
        title="芝浦工業大学公式OPACの公開カタログ検索",
        source_type="library",
        evidence_prefix="library-catalog-search-v1",
        locator_prefix="orbit-library://public/",
        classification="public",
        locator_mode="run",
    ),
    _spec(
        "library_item_read",
        ToolFamily.LIBRARY,
        "Read one authoritative public OPAC bibliographic record.",
        (LibraryItemReadResult,),
        title="芝浦工業大学公式OPACの公開書誌レコード",
        source_type="library",
        evidence_prefix="library-item-read-v1",
        locator_prefix="orbit-library://public/",
        classification="public",
        locator_mode="run",
    ),
    _spec(
        "library_catalog_browse",
        ToolFamily.LIBRARY,
        "Browse public OPAC new-book or loan-ranking lists.",
        (LibraryCatalogBrowseResult,),
        title="芝浦工業大学公式OPACの新着・貸出ランキング",
        source_type="library",
        evidence_prefix="library-catalog-browse-v1",
        locator_prefix="orbit-library://public/",
        classification="public",
        locator_mode="run",
    ),
    _spec(
        "library_discovery_search",
        ToolFamily.LIBRARY,
        "Search public SIT Search metadata for discovery.",
        (LibraryDiscoverySearchResult,),
        title="芝浦工業大学公式SIT Searchの公開メタデータ",
        source_type="library",
        evidence_prefix="library-discovery-search-v1",
        locator_prefix="orbit-library://public/",
        classification="public",
        locator_mode="run",
    ),
    _spec(
        "library_action_options",
        ToolFamily.LIBRARY,
        "Read current official library action availability without submitting a write.",
        (LibraryActionOptionsResult,),
        title="芝浦工業大学公式図書館の現在の操作可否",
        source_type="library",
        evidence_prefix="library-action-options-v1",
        locator_prefix="orbit-library://record/",
        classification="from_result",
        locator_mode="resource_ref",
    ),
)

TOOL_SPEC_BY_NAME = {spec.name: spec for spec in TOOL_SPECS}
CHAT_TOOL_NAMES: tuple[ChatToolName, ...] = tuple(spec.name for spec in TOOL_SPECS)
LIVE_SCOMBZ_TOOL_NAMES = frozenset(
    spec.name for spec in TOOL_SPECS if spec.availability == "live_scombz"
)
LIVE_SITRUS_TOOL_NAMES = frozenset(
    spec.name for spec in TOOL_SPECS if spec.availability == "live_sitrus"
)


def validate_catalog_contract() -> None:
    """Fail fast if metadata drifts from the public Pydantic Literal."""

    public_names = tuple(get_args(ChatToolName))
    if CHAT_TOOL_NAMES != public_names:
        raise RuntimeError("Tool Catalog order does not match the ChatToolName contract.")
    if len(TOOL_SPEC_BY_NAME) != len(TOOL_SPECS):
        raise RuntimeError("Tool Catalog contains duplicate names.")
    if not all(spec.read_only and spec.version == 1 for spec in TOOL_SPECS):
        raise RuntimeError("Chat Tool Catalog may contain only read-only v1 tools.")


def capability_tool_names(
    *,
    backend: str,
    observability: str,
    scombz_student_read_mode: str,
    sitrus_personal_context_mode: str = "off",
) -> tuple[ChatToolName, ...]:
    live_scombz = (
        backend == "azure_openai" and observability == "off" and scombz_student_read_mode == "live"
    )
    fixture_scombz = (
        backend == "fixture" and observability == "off" and scombz_student_read_mode == "fixture"
    )
    live_sitrus = (
        backend == "azure_openai"
        and observability == "off"
        and sitrus_personal_context_mode == "live"
    )
    fixture_sitrus = (
        backend == "fixture"
        and observability == "off"
        and sitrus_personal_context_mode == "fixture"
    )
    return tuple(
        spec.name
        for spec in TOOL_SPECS
        if spec.availability == "default"
        or (spec.availability == "live_scombz" and (live_scombz or fixture_scombz))
        or (spec.availability == "live_sitrus" and (live_sitrus or fixture_sitrus))
    )


validate_catalog_contract()


__all__ = [
    "CHAT_TOOL_NAMES",
    "LIVE_SCOMBZ_TOOL_NAMES",
    "LIVE_SITRUS_TOOL_NAMES",
    "TOOL_SPECS",
    "TOOL_SPEC_BY_NAME",
    "ToolFamily",
    "ToolSpec",
    "capability_tool_names",
    "validate_catalog_contract",
]
