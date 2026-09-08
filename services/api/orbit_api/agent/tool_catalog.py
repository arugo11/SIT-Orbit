"""Canonical, model-facing metadata for Chat tools.

The catalog is the only source of selection information. It deliberately
contains semantic Japanese descriptions and availability policy, but no
local wording rules or examples that could become a classifier. Provider-side
Tool Search receives ``model_description`` while
the API and extension use the same entries to build their eligible snapshot.
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
ExecutorKind = Literal["client", "server", "internal", "client_or_server"]
ProviderName = Literal["fixture", "azure_openai"]


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
    WEB = "web"
    INTERNAL = "internal"


@dataclass(frozen=True, slots=True)
class ToolSpec:
    """Typed model-facing policy and evidence metadata for one logical tool."""

    name: str
    family: ToolFamily
    # ``description`` is retained as the short API-facing alias. The five
    # Japanese fields are explicit so the selection contract is auditable.
    description: str
    purpose_ja: str
    use_when_ja: str
    returns_ja: str
    avoid_when_ja: str
    dependencies_ja: str
    result_types: tuple[type[BaseModel], ...]
    handler_name: str
    executor: ExecutorKind
    # Opaque references are named here so dependency checks do not rely on
    # parsing the Japanese description.  Producers are reference kinds emitted
    # by this Tool; consumers name the catalog Tools that may supply them.
    produces_opaque_refs: tuple[str, ...] = ()
    consumes_opaque_refs_from: tuple[str, ...] = ()
    availability: ToolAvailability = "default"
    provider_allowlist: frozenset[ProviderName] = frozenset({"fixture", "azure_openai"})
    requires_authentication: bool = False
    requires_consent: bool = False
    evidence_title: str = ""
    evidence_source_type: str = ""
    evidence_id_prefix: str = ""
    evidence_locator_prefix: str = ""
    evidence_classification: EvidenceClassification = "personal"
    evidence_locator_mode: EvidenceLocatorMode = "uuid"
    version: Literal[1] = 1
    read_only: Literal[True] = True
    external_model_allowed: bool = True

    @property
    def model_description(self) -> str:
        """Description sent to native Tool Search for a deferred definition."""

        return "。".join(
            (
                self.purpose_ja,
                f"利用条件: {self.use_when_ja}",
                f"取得内容: {self.returns_ja}",
                f"使わない場面: {self.avoid_when_ja}",
                f"前段Tool・opaque ref依存: {self.dependencies_ja}",
            )
        )


def _spec(
    name: str,
    family: ToolFamily,
    purpose: str,
    result_types: tuple[type[BaseModel], ...],
    *,
    use_when: str,
    returns: str,
    avoid: str,
    dependencies: str = "なし",
    produces_opaque_refs: tuple[str, ...] = (),
    consumes_opaque_refs_from: tuple[str, ...] = (),
    title: str = "",
    source_type: str = "",
    evidence_prefix: str = "",
    locator_prefix: str = "",
    classification: EvidenceClassification = "personal",
    locator_mode: EvidenceLocatorMode = "uuid",
    availability: ToolAvailability = "default",
    executor: ExecutorKind = "client",
    provider_allowlist: frozenset[ProviderName] = frozenset({"fixture", "azure_openai"}),
    requires_authentication: bool = False,
    requires_consent: bool = False,
    external_model_allowed: bool = True,
) -> ToolSpec:
    return ToolSpec(
        name=name,
        family=family,
        description=purpose,
        purpose_ja=purpose,
        use_when_ja=use_when,
        returns_ja=returns,
        avoid_when_ja=avoid,
        dependencies_ja=dependencies,
        produces_opaque_refs=produces_opaque_refs,
        consumes_opaque_refs_from=consumes_opaque_refs_from,
        result_types=result_types,
        handler_name=name,
        executor=executor,
        availability=availability,
        provider_allowlist=provider_allowlist,
        requires_authentication=requires_authentication,
        requires_consent=requires_consent,
        evidence_title=title,
        evidence_source_type=source_type,
        evidence_id_prefix=evidence_prefix,
        evidence_locator_prefix=locator_prefix,
        evidence_classification=classification,
        evidence_locator_mode=locator_mode,
        external_model_allowed=external_model_allowed,
    )


# The public Chat contract remains exactly the 22 read-only client names.
CLIENT_TOOL_SPECS: tuple[ToolSpec, ...] = (
    _spec(
        "scombz_page_summary",
        ToolFamily.SCOMBZ,
        "現在表示中のSCombZページを最小化して要約する",
        (ScombzPageSummaryResult,),
        use_when="表示中ページの概要確認が必要なとき",
        returns="ページ種別と構造化された概要だけ",
        avoid="課題本文・試験問題・成績や出席を読むとき",
        title="SCombZページから導出したページ概要",
        source_type="scombz",
        evidence_prefix="scombz-page-summary-v1",
        locator_prefix="orbit-scombz://page-summary/",
    ),
    _spec(
        "scombz_read",
        ToolFamily.SCOMBZ,
        "現在表示中のSCombZページから許可された構造化セクションを読む",
        (ScombzReadResult,),
        use_when="表示中ページの課題・お知らせ・時間割を確認するとき",
        returns="構造化された公開相当セクション",
        avoid="機能説明だけの質問、試験問題、個人評価や提出本文",
        dependencies="現在表示中のページ。opaque refは生成しない",
        title="SCombZから取得した表示情報",
        source_type="scombz",
        evidence_prefix="scombz-read-v1",
        locator_prefix="orbit-scombz://read/",
    ),
    _spec(
        "scombz_course_list",
        ToolFamily.SCOMBZ,
        "認証済みSCombZの履修科目と時間割を一覧する",
        (ScombzCourseListResult,),
        use_when="科目やコースを特定する前段が必要なとき",
        returns="科目名・学期・opaque course_ref",
        avoid="機能説明、試験問題、認証前または共有同意なし",
        dependencies="後続のscombz_course_readはここで返ったcourse_refだけを使う",
        produces_opaque_refs=("course_ref",),
        title="SCombZから取得した学生向け情報",
        source_type="scombz",
        evidence_prefix="scombz-course-list-v1",
        locator_prefix="orbit-scombz://read/",
        availability="live_scombz",
        requires_authentication=True,
        requires_consent=True,
    ),
    _spec(
        "scombz_portal_read",
        ToolFamily.SCOMBZ,
        "認証済みSCombZポータルのお知らせと公開学生情報を読む",
        (ScombzPortalReadResult,),
        use_when="ポータルのお知らせ確認が必要なとき",
        returns="許可されたお知らせの構造化要約",
        avoid="機能説明、認証前、個人評価や試験問題",
        dependencies="認証済みSCombZポータルroute",
        title="SCombZから取得した学生向け情報",
        source_type="scombz",
        evidence_prefix="scombz-portal-read-v1",
        locator_prefix="orbit-scombz://read/",
        availability="live_scombz",
        requires_authentication=True,
        requires_consent=True,
    ),
    _spec(
        "scombz_course_read",
        ToolFamily.SCOMBZ,
        "指定されたSCombZ科目の公開課題・告知・セクションを読む",
        (ScombzCourseReadResult,),
        use_when="course_ref取得後に科目内容を確認するとき",
        returns="指定科目の許可された構造化情報",
        avoid="機能説明、course_ref未取得、試験問題や不要な提出本文",
        dependencies="scombz_course_listで返ったopaque course_refが必須",
        produces_opaque_refs=("course_ref",),
        consumes_opaque_refs_from=("scombz_course_list",),
        title="SCombZから取得した学生向け情報",
        source_type="scombz",
        evidence_prefix="scombz-course-read-v1",
        locator_prefix="orbit-scombz://read/",
        availability="live_scombz",
        requires_authentication=True,
        requires_consent=True,
    ),
    _spec(
        "scombz_material_search",
        ToolFamily.SCOMBZ,
        "選択済み科目教材から質問に関係する語句をローカル検索する",
        (ScombzMaterialSearchResult,),
        use_when="取得済みcourse_refの教材内検索が必要なとき",
        returns="教材から抽出した最小限の該当箇所",
        avoid="機能説明、course_ref未取得、試験問題や提出本文",
        dependencies="scombz_course_listまたはscombz_course_read由来のcourse_ref",
        consumes_opaque_refs_from=("scombz_course_list", "scombz_course_read"),
        title="SCombZから取得した学生向け情報",
        source_type="scombz",
        evidence_prefix="scombz-material-search-v1",
        locator_prefix="orbit-scombz://read/",
        availability="live_scombz",
        requires_authentication=True,
        requires_consent=True,
    ),
    _spec(
        "google_calendar_availability",
        ToolFamily.CALENDAR,
        "Google Calendarから予定の題名を除いた空き時間を導出する",
        (CalendarAvailabilityResult,),
        use_when="空き時間だけが必要なとき",
        returns="時間帯の集合のみ",
        avoid="機能説明、予定名・参加者・本文を読むとき",
        title="Google Calendarから導出した空き時間",
        source_type="calendar",
        evidence_prefix="calendar-availability-v1",
        locator_prefix="orbit-calendar://availability/",
    ),
    _spec(
        "syllabus_search",
        ToolFamily.SYLLABUS,
        "芝浦工業大学公式公開シラバスを検索する",
        (SyllabusSearchResult,),
        use_when="公開科目の候補を探すとき",
        returns="公開シラバス候補とopaque syllabus_ref",
        avoid="機能説明や学内認証データを読むとき",
        dependencies="後続のsyllabus_readは検索結果のsyllabus_refだけを使う",
        produces_opaque_refs=("syllabus_ref",),
        title="芝浦工業大学公式シラバス検索",
        source_type="syllabus",
        evidence_prefix="syllabus-search-v1",
        locator_prefix="orbit-syllabus://search/",
        classification="public",
    ),
    _spec(
        "syllabus_read",
        ToolFamily.SYLLABUS,
        "公開シラバス検索結果をopaque refで詳細確認する",
        (SyllabusReadResult,),
        use_when="検索で得た特定科目の公開詳細が必要なとき",
        returns="公式公開シラバスの詳細",
        avoid="syllabus_ref未取得、機能説明、個人の履修情報",
        dependencies="syllabus_searchで返ったopaque syllabus_refが必須",
        consumes_opaque_refs_from=("syllabus_search",),
        title="芝浦工業大学公式シラバス詳細",
        source_type="syllabus",
        evidence_prefix="syllabus-read-v1",
        locator_prefix="orbit-syllabus://search/",
        classification="public",
    ),
    _spec(
        "browser_read_url",
        ToolFamily.BROWSER,
        "利用者が明示的に許可したURLの表示内容を最小化して読む",
        (BrowserReadResult,),
        use_when="認証不要の公開URLまたは明示許可URLを確認するとき",
        returns="表示内容の最小化要約",
        avoid="許可されていないURL、資格情報、機能説明",
        title="許可されたWebページの表示情報",
        source_type="web",
        evidence_prefix="browser-read-v1",
        locator_prefix="orbit-browser://read/",
        classification="from_result",
    ),
    _spec(
        "sitrus_read",
        ToolFamily.SITRUS,
        "認証済みSITRUSから現在利用者の成績と取得単位の最小projectionを読む",
        (SitrusGradeResult,),
        use_when="Azure live・observability off・認証済みの個人質問だけ",
        returns="氏名・学籍番号・生レスポンスを除いた最小projection",
        avoid="機能説明、fixture以外の非Azure、認証や同意未確認",
        title="SITRUSから取得した成績の最小化表示",
        source_type="learning_history",
        evidence_prefix="sitrus-grades-v1",
        locator_prefix="orbit-sitrus://grades/",
        availability="live_sitrus",
        requires_authentication=True,
        requires_consent=True,
        provider_allowlist=frozenset({"azure_openai"}),
    ),
    _spec(
        "moodle_read",
        ToolFamily.MOODLE,
        "明示的に開いたMoodleダッシュボードの学習状況を最小集計で読む",
        (MoodleReadResult,),
        use_when="認証済みダッシュボードの課題状況が必要なとき",
        returns="課題・コースの最小集計",
        avoid="機能説明、認証前、課題本文や個人情報の不要な取得",
        title="Moodleから導出した学習状況の概要",
        source_type="assignment",
        evidence_prefix="moodle-summary-v1",
        locator_prefix="orbit-moodle://summary/",
        requires_authentication=True,
    ),
    _spec(
        "my_library_read",
        ToolFamily.MY_LIBRARY,
        "明示的に接続・同意されたMy Libraryの指定scopeを限定ページで読む",
        (LegacyMyLibraryReadResult, ScopedMyLibraryReadResult),
        use_when="既存接続済みsessionと利用者の明示同意があるとき",
        returns="指定scopeの最小化貸出・予約等",
        avoid="機能説明、接続前、不要な履歴や生HTML",
        title="My Libraryから導出した利用状況の概要",
        source_type="library",
        evidence_prefix="my-library-summary-v1",
        locator_prefix="orbit-library://summary/",
        requires_authentication=True,
        requires_consent=True,
    ),
    _spec(
        "cast_read",
        ToolFamily.CAST,
        "明示的に開いたCASTダッシュボードのキャリア集計を読む",
        (CastReadResult,),
        use_when="CASTの概要が必要で認証済みrouteが確認できるとき",
        returns="最小化されたキャリア集計",
        avoid="機能説明、認証前、個人カード詳細の取得",
        title="CASTから導出したキャリア情報の概要",
        source_type="career",
        evidence_prefix="cast-summary-v1",
        locator_prefix="orbit-cast://summary/",
        requires_authentication=True,
    ),
    _spec(
        "cast_alumni_read",
        ToolFamily.CAST,
        "CASTの就活サポーター情報を匿名化された型付きprojectionで読む",
        (CastAlumniReadResult,),
        use_when="明示的な支援者情報の質問で認証済みCASTがあるとき",
        returns="個人を特定しない集計とcontact_present等",
        avoid="機能説明、氏名・連絡先・生カード",
        title="CASTから取得した就活サポーター情報（一般化）",
        source_type="career",
        evidence_prefix="cast-alumni-v1",
        locator_prefix="orbit-cast://alumni/",
        classification="from_result",
        requires_authentication=True,
    ),
    _spec(
        "cast_search",
        ToolFamily.CAST,
        "認証済みCASTを意味的な型付きfilterで単一surface検索する",
        (CastSearchResult,),
        use_when="求人・インターン・採用実績などの集計が必要なとき",
        returns="匿名集計、適用filter、opaque検索情報",
        avoid="機能説明、認証前、個人名やURLの取得",
        title="CAST検索から導出した匿名集計",
        source_type="career",
        evidence_prefix="cast-search-v1",
        locator_prefix="orbit-cast://search/",
        requires_authentication=True,
    ),
    _spec(
        "cast_career_search",
        ToolFamily.CAST,
        "認証済みCASTの複数career surfaceを一回の意味的検索で横断する",
        (CastCareerSearchResult,),
        use_when="複数surfaceを比較する必要があるとき",
        returns="surface coverageと匿名集計のみ",
        avoid="機能説明、認証前、個人カード詳細や連絡先",
        title="CAST横断検索から導出した匿名集計",
        source_type="career",
        evidence_prefix="cast-career-search-v1",
        locator_prefix="orbit-cast://career-search/",
        requires_authentication=True,
    ),
    _spec(
        "library_catalog_search",
        ToolFamily.LIBRARY,
        "芝浦工業大学公式OPACの公開カタログを検索する",
        (LibraryCatalogSearchResult,),
        use_when="公開書誌候補を探すとき",
        returns="書誌候補と浅い所蔵情報",
        avoid="機能説明、公開以外の個人情報、詳細な所在断定",
        dependencies="特定レコードの断定にはlibrary_item_readが必要",
        produces_opaque_refs=("resource_ref",),
        title="芝浦工業大学公式OPACの公開カタログ検索",
        source_type="library",
        evidence_prefix="library-catalog-search-v1",
        locator_prefix="orbit-library://public/",
        classification="public",
        locator_mode="run",
        executor="client_or_server",
    ),
    _spec(
        "library_item_read",
        ToolFamily.LIBRARY,
        "OPACの公開検索結果からopaque resource_refの書誌・所蔵詳細を読む",
        (LibraryItemReadResult,),
        use_when="特定書籍の所在・請求記号・貸出可否を確認するとき",
        returns="公式詳細画面の書誌・所蔵情報",
        avoid="resource_ref未取得、機能説明、検索結果だけでの所在断定",
        dependencies="library_catalog_searchで返ったopaque resource_refが必須",
        produces_opaque_refs=("resource_ref",),
        consumes_opaque_refs_from=("library_catalog_search",),
        title="芝浦工業大学公式OPACの公開書誌レコード",
        source_type="library",
        evidence_prefix="library-item-read-v1",
        locator_prefix="orbit-library://public/",
        classification="public",
        locator_mode="run",
        executor="client_or_server",
    ),
    _spec(
        "library_catalog_browse",
        ToolFamily.LIBRARY,
        "公式OPACの新着図書または貸出ランキングを閲覧する",
        (LibraryCatalogBrowseResult,),
        use_when="一覧型の公開図書情報が必要なとき",
        returns="公開一覧の書誌候補",
        avoid="機能説明、個人の貸出履歴や予約状況",
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
        "公式SIT Searchの公開メタデータから関連資料を探す",
        (LibraryDiscoverySearchResult,),
        use_when="論文・電子資料などの公開発見検索が必要なとき",
        returns="公開メタデータの候補",
        avoid="機能説明、個人の利用状況、OPAC所在の断定",
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
        "公開OPACのopaque resource_refについて現在の操作可否を読む",
        (LibraryActionOptionsResult,),
        use_when="予約等の提案前に公式の可否を確認するとき",
        returns="操作可否と検証レベルのみ",
        avoid="最初の自然文で書き込みを行う、機能説明、resource_ref未取得",
        dependencies="library_item_read由来のopaque resource_ref。書き込みは未実装",
        consumes_opaque_refs_from=("library_item_read",),
        title="芝浦工業大学公式図書館の現在の操作可否",
        source_type="library",
        evidence_prefix="library-action-options-v1",
        locator_prefix="orbit-library://record/",
        classification="from_result",
        locator_mode="resource_ref",
    ),
)


# Server and internal entries share the same logical catalog. There is no
# duplicate OPAC entry: the resolver chooses the configured gateway for the
# two ``client_or_server`` specs.
SERVER_TOOL_SPECS: tuple[ToolSpec, ...] = (
    _spec(
        "general_web_search",
        ToolFamily.WEB,
        "公開情報だけを検索し、個人情報を含まない根拠を得る",
        (),
        use_when="会話と公開根拠だけでは不足し、公開Webで補えるとき",
        returns="公開検索結果とサーバー発行Evidence",
        avoid="学内個人情報・認証情報・機能説明だけの質問",
        title="公開Web検索",
        source_type="web",
        evidence_prefix="web-search-v1",
        locator_prefix="orbit-web://search/",
        classification="public",
        executor="server",
        provider_allowlist=frozenset({"azure_openai"}),
    ),
    _spec(
        "related_book_discovery",
        ToolFamily.LIBRARY,
        "公開Webの根拠から関連書籍候補を探索する",
        (),
        use_when="読書候補の根拠が不足し公開情報で補えるとき",
        returns="Evidenceに紐づくcandidate_refだけ",
        avoid="機能説明、貸出情報や個人の読書履歴を検索すること",
        dependencies="公開題材だけ。My Libraryの個人項目は送信しない",
        produces_opaque_refs=("candidate_ref",),
        title="公開関連書籍探索",
        source_type="library",
        evidence_prefix="related-books-v1",
        locator_prefix="orbit-books://discovery/",
        classification="public",
        executor="server",
        provider_allowlist=frozenset({"azure_openai"}),
    ),
    _spec(
        "describe_available_capabilities",
        ToolFamily.INTERNAL,
        "このターンに検索可能なToolの概要を返す",
        (),
        use_when="利用可能な機能の説明を求められたとき",
        returns="eligible catalogの名前・日本語概要だけ",
        avoid="学内データ・Evidence・外部アクセスの取得",
        dependencies="そのターンのeligible snapshotのみ",
        executor="internal",
        external_model_allowed=False,
    ),
)

TOOL_SPECS: tuple[ToolSpec, ...] = CLIENT_TOOL_SPECS + SERVER_TOOL_SPECS
TOOL_SPEC_BY_NAME: dict[str, ToolSpec] = {spec.name: spec for spec in TOOL_SPECS}
CHAT_TOOL_NAMES: tuple[ChatToolName, ...] = tuple(spec.name for spec in CLIENT_TOOL_SPECS)  # type: ignore[assignment]
LIVE_SCOMBZ_TOOL_NAMES = frozenset(
    spec.name for spec in CLIENT_TOOL_SPECS if spec.availability == "live_scombz"
)
LIVE_SITRUS_TOOL_NAMES = frozenset(
    spec.name for spec in CLIENT_TOOL_SPECS if spec.availability == "live_sitrus"
)


def validate_catalog_contract() -> None:
    """Fail fast when catalog metadata drifts from the public API contract."""

    public_names = tuple(get_args(ChatToolName))
    if CHAT_TOOL_NAMES != public_names:
        raise RuntimeError("Tool Catalog order does not match the ChatToolName contract.")
    if len(TOOL_SPEC_BY_NAME) != len(TOOL_SPECS):
        raise RuntimeError("Tool Catalog contains duplicate logical names.")
    if len(CHAT_TOOL_NAMES) != len(set(CHAT_TOOL_NAMES)):
        raise RuntimeError("Chat Tool Catalog contains duplicate client names.")
    names = set(TOOL_SPEC_BY_NAME)
    for spec in TOOL_SPECS:
        if any(not isinstance(ref, str) or not ref.strip() for ref in spec.produces_opaque_refs):
            raise RuntimeError(f"Opaque ref producer metadata is invalid for {spec.name}.")
        for producer in spec.consumes_opaque_refs_from:
            if producer not in names:
                raise RuntimeError(
                    f"Opaque ref consumer {spec.name} names an unknown producer {producer}."
                )
            if not TOOL_SPEC_BY_NAME[producer].produces_opaque_refs:
                raise RuntimeError(
                    f"Opaque ref consumer {spec.name} names a non-producer {producer}."
                )
    for spec in TOOL_SPECS:
        required = (
            spec.purpose_ja,
            spec.use_when_ja,
            spec.returns_ja,
            spec.avoid_when_ja,
            spec.dependencies_ja,
        )
        if not all(isinstance(item, str) and item.strip() for item in required):
            raise RuntimeError(f"Tool Catalog metadata is incomplete for {spec.name}.")
        if not spec.read_only or spec.version != 1:
            raise RuntimeError("Chat Tool Catalog may contain only read-only v1 tools.")
        if spec.name in public_names and spec.executor == "internal":
            raise RuntimeError("Public Chat tools cannot be internal catalog entries.")


def capability_tool_names(
    *,
    backend: str,
    observability: str,
    scombz_student_read_mode: str,
    sitrus_personal_context_mode: str = "off",
) -> tuple[ChatToolName, ...]:
    """Return configured client tools without consulting user wording.

    Authentication and extension consent are intersected by the caller. This
    function only evaluates server configuration policy.
    """

    live_scombz = (
        backend == "azure_openai" and observability == "off" and scombz_student_read_mode == "live"
    )
    live_sitrus = (
        backend == "azure_openai"
        and observability == "off"
        and sitrus_personal_context_mode == "live"
    )
    result: list[ChatToolName] = []
    for spec in CLIENT_TOOL_SPECS:
        if backend not in spec.provider_allowlist:
            continue
        if spec.availability == "default":
            result.append(spec.name)  # type: ignore[arg-type]
        elif spec.availability == "live_scombz" and live_scombz:
            result.append(spec.name)  # type: ignore[arg-type]
        elif spec.availability == "live_sitrus" and live_sitrus:
            result.append(spec.name)  # type: ignore[arg-type]
    return tuple(result)


def eligible_catalog_specs(
    *,
    backend: str,
    observability: str,
    scombz_student_read_mode: str,
    sitrus_personal_context_mode: str = "off",
    advertised_client_tools: set[str] | frozenset[str] = frozenset(),
    authenticated_tools: set[str] | frozenset[str] | None = None,
    consented_tools: set[str] | frozenset[str] | None = None,
    server_tools: set[str] | frozenset[str] = frozenset(),
) -> tuple[ToolSpec, ...]:
    """Build one eligible catalog snapshot for a model turn.

    An omitted auth or consent snapshot excludes tools that require it
    (fail-closed). ``advertised_client_tools`` is the API-approved set.
    """

    configured = set(
        capability_tool_names(
            backend=backend,
            observability=observability,
            scombz_student_read_mode=scombz_student_read_mode,
            sitrus_personal_context_mode=sitrus_personal_context_mode,
        )
    )
    advertised = set(advertised_client_tools)
    auth = set(authenticated_tools or ())
    consent = set(consented_tools or ())
    result: list[ToolSpec] = []
    for spec in TOOL_SPECS:
        if spec.executor == "internal":
            continue
        if backend not in spec.provider_allowlist:
            continue
        if spec.executor in {"client", "client_or_server"}:
            # A client_or_server entry may be supplied by an already-configured
            # server gateway even when the extension did not advertise a
            # client connector.  This keeps one logical OPAC name in the
            # catalog while still allowing the server transport to discover it.
            server_ready = spec.executor == "client_or_server" and spec.name in server_tools
            # An empty advertisement is an explicit "no client tools" value,
            # not a request to expose the whole configured catalog.  The
            # extension sends the auth/consent intersection on every turn.
            if not server_ready and (spec.name not in configured or spec.name not in advertised):
                continue
            if not server_ready and spec.requires_authentication and spec.name not in auth:
                continue
            if not server_ready and spec.requires_consent and spec.name not in consent:
                continue
        elif spec.executor == "server" and spec.name not in server_tools:
            continue
        result.append(spec)
    internal = TOOL_SPEC_BY_NAME["describe_available_capabilities"]
    if backend in internal.provider_allowlist:
        result.append(internal)
    return tuple(result)


validate_catalog_contract()

__all__ = [
    "CHAT_TOOL_NAMES",
    "CLIENT_TOOL_SPECS",
    "LIVE_SCOMBZ_TOOL_NAMES",
    "LIVE_SITRUS_TOOL_NAMES",
    "SERVER_TOOL_SPECS",
    "TOOL_SPECS",
    "TOOL_SPEC_BY_NAME",
    "ToolAvailability",
    "ToolFamily",
    "ToolSpec",
    "capability_tool_names",
    "eligible_catalog_specs",
    "validate_catalog_contract",
]
