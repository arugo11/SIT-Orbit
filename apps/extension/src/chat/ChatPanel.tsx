import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
  type ActionProposal,
  type AgentApiClient,
  type ChatCapabilities,
  type ChatRunResponse,
  type ChatToolResultRequest,
  classifyAgentApiError,
  isBrowserReadResult,
  isCastAlumniReadResult,
  isCastCareerSearchResult,
  isCastReadResult,
  isCastSearchResult,
  isLibraryActionOptionsResult,
  isLibraryCatalogBrowseResult,
  isLibraryCatalogSearchResult,
  isLibraryDiscoverySearchResult,
  isLibraryItemReadResult,
  isMoodleReadResult,
  isMyLibraryReadResult,
  isScombzCourseListResult,
  isScombzCourseReadResult,
  isScombzMaterialSearchResult,
  isScombzPortalReadResult,
  isSitrusGradeResult,
  isSyllabusReadResult,
  isSyllabusSearchResult,
  type LibraryCatalogSearchResult,
  type SyllabusReadResult,
  type SyllabusSearchResult,
} from "../api/client";
import {
  type CalendarConnector,
  type CalendarConnectorResult,
  projectCalendarAvailability,
} from "../connectors/google-calendar";
import type { LibraryActionEditableInputs } from "../connectors/library-actions";
import {
  type LibraryFloorMap,
  uniqueLibraryFloorMaps,
} from "../connectors/library-floor-maps";
import { parseSyllabusDetailHtml } from "../connectors/syllabus-search";
import type { CastAlumniLocalSnapshot } from "../content/cast-alumni-reader";
import {
  type CastCareerAgentProjection,
  type CastCareerFilters,
  type CastCareerLocalResult,
  type CastCareerSurface,
  isCastCareerSearchRequest,
} from "../content/cast-career-source-runtime";
import {
  type CastCareerRankedItem,
  type CastCareerResultGroup,
  groupCastCareerItems,
  rankCastCareerItems,
} from "../content/cast-cross-search";
import { CAST_ENTRY_URL, type CastLocalSnapshot } from "../content/cast-reader";
import {
  type CastSearchLocalKnownResult,
  isCastSearchRequest,
} from "../content/cast-search-api";
import {
  MOODLE_DASHBOARD_URL,
  type MoodleLocalSnapshot,
} from "../content/moodle-reader";
import {
  MY_LIBRARY_ENTRY_URL,
  type MyLibraryLocalSnapshot,
} from "../content/my-library-reader";
import {
  isSitrusGradeUrl,
  type PageContext,
  projectScombzPageSummary,
  projectScombzRead,
} from "../content/page-context";
import { hasScombzStudentSessionConsent } from "../content/scombz-consent";
import { ConversationPseudonymizationGateway } from "../privacy/conversation-pseudonymization";
import type {
  BrowserReadResponse,
  CastAlumniReadResponse,
  CastCareerSearchResponse,
  CastReadResponse,
  CastSearchResponse,
  LibraryActionOptionsResponse,
  LibraryActionPreviewResponse,
  LibraryActionSubmitResponse,
  LibraryCatalogBrowseResponse,
  LibraryCatalogSearchResponse,
  LibraryDiscoverySearchResponse,
  LibraryItemReadResponse,
  MoodleReadResponse,
  MyLibraryReadResponse,
  ScombzPinResponse,
  ScombzStudentReadResponse,
  SitrusReadResponse,
} from "../shared/messages";
import { MESSAGE_TYPES } from "../shared/messages";
import { hostAccessRequest } from "./access-policy";
import {
  type ChatConversation,
  type ChatTimelineMessage,
  ContextEvidenceConflictError,
  deleteAllConversations,
  deleteConversation,
  listConversations,
  loadConversation,
  mergeCompletedChatContext,
  mergeLibraryContext,
  newConversation,
  saveConversation,
  toChatContextManifest,
  toChatHistory,
} from "./chat-history";
import { ChatRunner } from "./chat-runner";
import {
  advertiseReadOnlyTools,
  isRegisteredReadOnlyTool,
  toolDisplayLabel,
  validateChatToolArguments,
} from "./tool-registry";

const CHAT_FAILURE_MESSAGE =
  "今は応答できませんでした。もう一度お試しください。";

interface LocalCastCareerDetail {
  result: CastCareerLocalResult;
  ranked_items: CastCareerRankedItem[];
  groups: CastCareerResultGroup[];
  filters: CastCareerFilters;
  /** Optional local-only synthesis returned by the CAST runtime. */
  reasoning_projection?: LocalCastReasoningProjection | null;
}

interface LocalCastReasoningRecord {
  result_ref: string | null;
  surface: string | null;
  title: string | null;
  company_name: string | null;
  person_alias: string | null;
  graduation_year_range: string | null;
  academic_program: string | null;
  technical_domains: string[];
  occupations: string[];
  locations: string[];
  relation_flags: string[];
  deadline: string | null;
}

interface LocalCastReasoningProjection {
  records: LocalCastReasoningRecord[];
  destination: "local";
  redacted_fields: string[];
  replaced_person_count: number;
  status: string | null;
  reason_code: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactLocalText(value: unknown, limit = 240): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, limit) : null;
}

function compactLocalList(value: unknown, limit = 8): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => compactLocalText(item, 120))
        .filter((item): item is string => item !== null),
    ),
  ).slice(0, limit);
}

function compactLocalValue(value: unknown, limit = 160): string | null {
  const scalar = compactLocalText(value, limit);
  if (scalar) return scalar;
  const list = compactLocalList(value, 8);
  return list.length > 0 ? list.join("、").slice(0, limit) : null;
}

/**
 * Read the optional local reasoning projection without trusting arbitrary
 * CAST fields.  This deliberately ignores free text, URLs, IDs and names;
 * the local card can only show the allowlisted, already-masked fields.
 */
function parseLocalCastReasoningProjection(
  value: unknown,
): LocalCastReasoningProjection | null {
  if (!isRecord(value)) return null;
  const rawRecords = Array.isArray(value.records)
    ? value.records
    : Array.isArray(value.items)
      ? value.items
      : [];
  const records = rawRecords
    .filter(isRecord)
    .slice(0, 20)
    .map(
      (item): LocalCastReasoningRecord => ({
        result_ref: compactLocalText(item.result_ref, 120),
        surface: compactLocalText(item.surface, 60),
        title: compactLocalText(item.title, 240),
        company_name: compactLocalText(item.company_name, 240),
        person_alias: compactLocalText(
          item.person_alias ?? item.person_alias_label,
          120,
        ),
        graduation_year_range: compactLocalValue(
          item.graduation_year_range ?? item.graduation_year_buckets,
          80,
        ),
        academic_program: compactLocalValue(
          item.academic_program ??
            item.academic_programs ??
            item.technical_domains,
          160,
        ),
        technical_domains: compactLocalList(item.technical_domains),
        occupations: compactLocalList(item.occupations),
        locations: compactLocalList(item.locations),
        relation_flags: compactLocalList(item.relation_flags),
        deadline: compactLocalText(item.deadline, 32),
      }),
    )
    .filter(
      (item) =>
        item.title !== null ||
        item.company_name !== null ||
        item.person_alias !== null,
    );
  const destination = value.destination === "local" ? "local" : null;
  if (!destination) return null;
  const replaced =
    typeof value.replaced_person_count === "number" &&
    Number.isInteger(value.replaced_person_count) &&
    value.replaced_person_count >= 0
      ? Math.min(value.replaced_person_count, 1000)
      : 0;
  return {
    records,
    destination,
    redacted_fields: [
      ...new Set([
        ...compactLocalList(value.redacted_fields, 20),
        ...compactLocalList(value.removed_fields, 20),
        ...compactLocalList(value.generalized_fields, 20),
      ]),
    ].slice(0, 20),
    replaced_person_count: replaced,
    status: compactLocalText(value.status, 80),
    reason_code: compactLocalText(value.reason_code, 100),
  };
}

function castReasoningFromResponse(
  value: unknown,
): LocalCastReasoningProjection | null {
  if (!isRecord(value)) return null;
  const candidates: unknown[] = [
    value.reasoning_projection,
    value.local_reasoning,
    value.reasoning,
    isRecord(value.projection) ? value.projection.reasoning_projection : null,
    isRecord(value.projection) ? value.projection.local_reasoning : null,
  ];
  for (const candidate of candidates) {
    if (isRecord(candidate) && isRecord(candidate.payload)) {
      const parsed = parseLocalCastReasoningProjection({
        ...candidate.payload,
        ...(isRecord(candidate.manifest) ? candidate.manifest : {}),
      });
      if (parsed) return parsed;
    }
    const parsed = parseLocalCastReasoningProjection(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function sourceLabel(name: string | undefined): string {
  switch (name) {
    case "cast_career_search":
    case "cast_search":
    case "cast_read":
    case "cast_alumni_read":
      return "CAST";
    case "browser_read_url":
      return "一般Web";
    case "library_catalog_search":
    case "library_item_read":
    case "library_catalog_browse":
    case "library_discovery_search":
    case "library_action_options":
      return "図書館";
    case "syllabus_search":
      return "シラバス";
    case "scombz_page_summary":
    case "scombz_read":
      return "SCombZ";
    case "sitrus_read":
      return "SITRUS";
    case "moodle_read":
      return "Moodle";
    case "my_library_read":
      return "My Library";
    case "google_calendar_availability":
      return "Google Calendar";
    default:
      return "情報源";
  }
}

function statusLabel(status: string | null | undefined): string {
  switch (status) {
    case "known":
      return "確認済み";
    case "partial":
      return "一部確認";
    case "reauth_required":
      return "再認証が必要";
    case "form_changed":
      return "画面構造が変更";
    case "rate_limited":
      return "一時的な制限";
    case "server_error":
      return "サービス側エラー";
    case "unavailable":
      return "利用不可";
    case "local_model_unavailable":
      return "端末内モデル未準備";
    case "pseudonymization_failed":
      return "仮名化に失敗";
    case "vault_locked":
      return "Career Vaultがロック中";
    default:
      return status ?? "状態不明";
  }
}

function failureCodeFromError(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  if (/再認証|ログイン/u.test(text)) return "reauth_required";
  if (/フォーム|構造/u.test(text)) return "form_changed";
  if (/制限|rate/u.test(text)) return "rate_limited";
  if (/サーバー|HTTP 5/u.test(text)) return "server_error";
  if (/仮名化/u.test(text)) return "pseudonymization_failed";
  if (/Vault|ロック/u.test(text)) return "vault_locked";
  return "unavailable";
}

function formatCastCareerFilters(filters: CastCareerFilters): string {
  const labels: Record<string, string> = {
    company_name: "企業",
    locations: "勤務地",
    industries: "業種",
    technical_domains: "技術領域",
    occupations: "職種",
    academic_programs: "学部・学科",
    target_grades: "対象学年",
    graduation_years: "採用実績年度",
    deadline_before: "締切",
    obog_required: "OB・OG",
    career_supporter_required: "就活サポーター",
    recording_required: "録画",
  };
  return Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([key, value]) => {
      const rendered = Array.isArray(value) ? value.join("、") : String(value);
      return `${labels[key] ?? key}: ${rendered}`;
    })
    .join(" / ");
}
export interface ChatPanelProps {
  apiClient: AgentApiClient;
  pageContext: PageContext | null;
  calendarState: CalendarConnectorResult;
  calendarConnector?: CalendarConnector;
  calendarRequest: (command: "refresh") => Promise<CalendarConnectorResult>;
  mode?: "sidepanel" | "workspace";
  settingsOpen?: boolean;
  settingsButtonRef?: RefObject<HTMLButtonElement | null>;
  onOpenSettings?: () => void;
  onOpenWorkspace?: () => void;
  workspaceDisabled?: boolean;
  disabled?: boolean;
}

// Progress copy is derived from an observed client boundary or tool contract.
// It must never imply hidden model reasoning; an optional title summarizer can
// be added later only as presentation, with this deterministic text as the
// fail-closed fallback.
function toolLabel(name: string): string {
  return toolDisplayLabel(name);
}

const PERSONAL_SCOMBZ_TOOL_NAMES = new Set([
  "scombz_page_summary",
  "scombz_read",
  "scombz_course_list",
  "scombz_portal_read",
  "scombz_course_read",
  "scombz_material_search",
]);

function mergeProcessingScope(
  conversation: ChatConversation,
  toolName: string,
  dataClassification?: "personal" | "restricted",
): ChatConversation {
  const nextScope = PERSONAL_SCOMBZ_TOOL_NAMES.has(toolName)
    ? "personal/scombz_student"
    : toolName === "syllabus_search" || toolName === "syllabus_read"
      ? "public/syllabus"
      : (toolName === "cast_alumni_read" &&
            dataClassification === "restricted") ||
          toolName === "cast_career_search"
        ? "restricted/cast_career"
        : null;
  if (!nextScope || conversation.processing_scope === nextScope) {
    return conversation;
  }
  const processing_scope =
    conversation.processing_scope !== "none" &&
    conversation.processing_scope !== nextScope
      ? "mixed"
      : nextScope;
  return { ...conversation, processing_scope };
}

function explicitBookCount(messages: ChatTimelineMessage[]): number | null {
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user")?.content;
  if (!latestUserMessage) return null;
  const match = latestUserMessage.match(
    /([1-8１２３４５６７８一二三四五六七八])冊/u,
  );
  if (!match?.[1]) return null;
  const countByText: Record<string, number> = {
    "1": 1,
    "2": 2,
    "3": 3,
    "4": 4,
    "5": 5,
    "6": 6,
    "7": 7,
    "8": 8,
    "１": 1,
    "２": 2,
    "３": 3,
    "４": 4,
    "５": 5,
    "６": 6,
    "７": 7,
    "８": 8,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
  };
  return countByText[match[1]] ?? null;
}

function libraryFailureDetail(reasonCode: string): string {
  switch (reasonCode) {
    case "search_navigation_timeout":
      return "OPAC検索ページの読み込みが完了しませんでした。所蔵なしとは判定していません。";
    case "search_navigation_mismatch":
    case "record_navigation_mismatch":
      return "公式OPACの対象ページへ遷移できませんでした。所蔵なしとは判定していません。";
    case "availability_loading_timeout":
      return "OPACの所蔵状況の反映を待ちましたが完了しませんでした。";
    case "record_navigation_timeout":
      return "書誌詳細ページの読み込みが完了しませんでした。";
    case "record_structure_not_found":
    case "result_structure_not_found":
      return "OPACの表示形式を確認できませんでした。";
    default:
      return "今回のOPAC再確認を完了できませんでした。所蔵なしとは判定していません。";
  }
}

function libraryActionFailureDetail(reasonCode: string): string {
  switch (reasonCode) {
    case "write_form_not_verified":
    case "reservation_entry_not_visible":
    case "reservation_form_not_verified":
      return "公式ページで予約フォームを確認できないため、送信を止めました。";
    case "reservation_login_required":
    case "reservation_readback_login_required":
    case "login_required":
      return "図書館のログインが必要です。公式ページでログインしてから、もう一度お試しください。";
    case "csrf_missing":
    case "reservation_form_csrf_missing":
      return "公式フォームの安全確認情報を取得できないため、送信を止めました。";
    case "official_state_changed":
    case "reservation_form_changed":
      return "公式ページの内容が変わったため、予約内容を作り直してください。";
    case "reservation_preview_expired":
    case "preview_expired":
      return "予約内容の確認期限が切れました。もう一度公式ページで確認してください。";
    case "reservation_in_progress":
      return "予約処理を確認中です。二重送信は行っていません。";
    case "reservation_confirmation_unverified":
    case "reservation_readback_failed":
    case "reservation_submit_failed":
      return "予約後の公式画面で完了を確認できなかったため、成功扱いにしていません。";
    case "official_tab_create_failed":
    case "record_tab_create_failed":
      return "公式図書館ページを開けませんでした。";
    case "invalid_inputs":
    case "pickup_campus_required":
      return "受取キャンパスを選択してから、公式プレビューを確認してください。";
    default:
      return "公式ページの予約状態を確認できないため、送信を止めました。";
  }
}

function userFacingChatFailure(error: unknown): string {
  if (error instanceof ContextEvidenceConflictError) {
    return "会話の文脈に矛盾する参照情報があるため、今回の送信を止めました。もう一度お試しください。";
  }
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : null;
  if (status === 401 || status === 403) {
    return "Agentの認証が切れています。設定から再接続して、もう一度お試しください。";
  }
  if (status === 409) {
    return "会話の更新が競合したため、外部操作は実行していません。もう一度お試しください。";
  }
  if (status === 422) {
    switch (classifyAgentApiError(error)) {
      case "context_invalid":
        return "会話の文脈に矛盾があるため、今回の送信を止めました。もう一度お試しください。";
      case "history_invalid":
        return "会話履歴を安全に送信できないため、今回の送信を止めました。新しいChatでお試しください。";
      case "tools_invalid":
        return "利用できる参照先を確認できないため、外部操作は実行していません。もう一度お試しください。";
      case "tool_result_invalid":
        return "参照結果を検証できないため、外部操作は実行していません。もう一度お試しください。";
      case "agent_output_invalid":
        return "Agentの回答形式を確認できないため、外部操作は実行していません。もう一度お試しください。";
      case "run_invalid":
        return "会話の実行状態を確認できないため、外部操作は実行していません。もう一度お試しください。";
      default:
        break;
    }
    return "Agentとの接続仕様を確認できなかったため、外部操作は実行していません。拡張機能を再読み込みして、もう一度お試しください。";
  }
  if (status !== null && status >= 500) {
    return "Agentの応答を取得できませんでした。外部操作は実行していません。しばらくしてからもう一度お試しください。";
  }
  if (
    error instanceof Error &&
    /予約|フォーム|確認|認証|ログイン/u.test(error.message)
  ) {
    return error.message.slice(0, 240);
  }
  return CHAT_FAILURE_MESSAGE;
}

function libraryCampusLabel(campus: string): string {
  if (campus === "toyosu") return "豊洲図書館";
  if (campus === "omiya") return "大宮図書館";
  return "所蔵館不明";
}

function LibraryFloorMapPreview({ map }: { map: LibraryFloorMap }) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <div className="library-floor-map">
      {map.image_url && !imageFailed ? (
        <a
          href={map.image_url}
          target="_blank"
          rel="noreferrer"
          aria-label={`${map.label}の画像を原寸で開く`}
        >
          <img
            src={map.image_url}
            alt={map.label}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
          />
        </a>
      ) : null}
      <a
        href={map.page_url}
        target="_blank"
        rel="noreferrer"
        aria-label={`${map.label}を公式サイトで開く`}
      >
        {imageFailed ? "公式フロアマップを開く" : `${map.label}を開く`}
      </a>
    </div>
  );
}

function ResearchTrace({ messages }: { messages: ChatTimelineMessage[] }) {
  const activities = messages.filter(
    (message) => message.role === "tool" && message.toolName,
  );
  if (activities.length === 0) return null;
  return (
    <details className="chat-research-trace">
      <summary>調査トレース（{activities.length}件）</summary>
      <ol>
        {activities.map((activity, index) => (
          <li
            key={activity.id}
            data-tool-state={activity.toolState}
            data-source={sourceLabel(activity.toolName)}
          >
            <span className="chat-trace-index">{index + 1}</span>
            <span className="chat-trace-source">
              {sourceLabel(activity.toolName)}
            </span>
            <span className="chat-trace-label">{activity.content}</span>
            <span className="chat-trace-status">
              {activity.toolState === "running"
                ? "確認中"
                : activity.toolState === "failed"
                  ? "失敗"
                  : "完了"}
            </span>
          </li>
        ))}
      </ol>
      <p>
        調査の順序と成否だけを表示しています。モデルの逐語的な思考は保存・表示しません。
      </p>
    </details>
  );
}

interface ContextManifestSummary {
  evidenceCount: number;
  publicCount: number;
  personalCount: number;
  localOnlyCount: number;
  replacedPersonCount: number;
  generalizedFields: string[];
  destinations: string[];
}

function contextManifestSummary(
  value: ChatConversation["contextManifest"],
  localReasoning: LocalCastReasoningProjection[] = [],
): ContextManifestSummary {
  const manifest = value as unknown as Record<string, unknown>;
  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  const sourceEntries = Array.isArray(manifest.sources)
    ? manifest.sources
    : Array.isArray(manifest.items)
      ? manifest.items
      : [];
  const readCount = (keys: string[]): number => {
    for (const key of keys) {
      const candidate = manifest[key];
      if (typeof candidate === "number" && Number.isInteger(candidate)) {
        return Math.max(0, Math.min(candidate, 1000));
      }
    }
    return 0;
  };
  const stringsFrom = (keys: string[]): string[] => {
    for (const key of keys) {
      const candidate = manifest[key];
      if (Array.isArray(candidate)) {
        return compactLocalList(candidate, 20);
      }
    }
    return [];
  };
  const destinations = [
    ...sourceEntries
      .filter(isRecord)
      .map((entry) => compactLocalText(entry.destination, 60))
      .filter((item): item is string => item !== null),
    ...stringsFrom(["destinations", "processing_targets"]),
    ...(localReasoning.length > 0 ? ["端末内"] : []),
  ];
  const uniqueDestinations = [...new Set(destinations)].slice(0, 8);
  const localReasoningRecordCount = localReasoning.reduce(
    (total, item) => total + item.records.length,
    0,
  );
  const localReasoningPeople = localReasoning.reduce(
    (total, item) => total + item.replaced_person_count,
    0,
  );
  const localReasoningFields = localReasoning.flatMap(
    (item) => item.redacted_fields,
  );
  return {
    evidenceCount: evidence.length,
    publicCount: evidence.filter(
      (item) => item.data_classification === "public",
    ).length,
    personalCount: evidence.filter(
      (item) => item.data_classification === "personal",
    ).length,
    localOnlyCount: Math.max(
      readCount(["local_only_count", "local_count"]),
      localReasoningRecordCount,
    ),
    replacedPersonCount: Math.max(
      readCount(["replaced_person_count", "pseudonymized_person_count"]),
      localReasoningPeople,
    ),
    generalizedFields: [
      ...new Set([
        ...stringsFrom(["generalized_fields", "redacted_fields"]),
        ...localReasoningFields,
      ]),
    ].slice(0, 20),
    destinations: uniqueDestinations,
  };
}

function ContextManifestCard({
  manifest,
  localReasoning = [],
}: {
  manifest: ChatConversation["contextManifest"];
  localReasoning?: LocalCastReasoningProjection[];
}) {
  const summary = contextManifestSummary(manifest, localReasoning);
  const hasContent =
    summary.evidenceCount > 0 ||
    summary.localOnlyCount > 0 ||
    summary.replacedPersonCount > 0 ||
    summary.generalizedFields.length > 0 ||
    summary.destinations.length > 0;
  if (!hasContent) return null;
  return (
    <details className="chat-context-manifest">
      <summary>Context Manifest</summary>
      <dl>
        <div>
          <dt>参照</dt>
          <dd>
            {summary.evidenceCount}件（公開 {summary.publicCount}件 / 個人由来{" "}
            {summary.personalCount}件）
          </dd>
        </div>
        {summary.localOnlyCount > 0 ? (
          <div>
            <dt>端末内のみ</dt>
            <dd>{summary.localOnlyCount}件</dd>
          </div>
        ) : null}
        {summary.replacedPersonCount > 0 ? (
          <div>
            <dt>仮名化</dt>
            <dd>{summary.replacedPersonCount}人分</dd>
          </div>
        ) : null}
        {summary.destinations.length > 0 ? (
          <div>
            <dt>処理先</dt>
            <dd>{summary.destinations.join("、")}</dd>
          </div>
        ) : null}
      </dl>
      {summary.generalizedFields.length > 0 ? (
        <p>一般化・除外: {summary.generalizedFields.join("、")}</p>
      ) : null}
    </details>
  );
}

function evidenceText(proposal: ActionProposal | null | undefined): string[] {
  return proposal?.evidence.map((item) => item.title) ?? [];
}

function editableInputValue(
  inputs: LibraryActionEditableInputs | undefined,
  key: string,
): string {
  if (!inputs) return "";
  const values = inputs.values as unknown as Record<string, unknown>;
  const value = values[key];
  return typeof value === "string" ? value : "";
}

function reserveCampusChoices(
  conversation: ChatConversation,
  resourceRef: string,
): Array<{ value: "omiya" | "toyosu"; label: string }> {
  const record = conversation.contextManifest.library_records.find(
    (item) => item.resource_ref === resourceRef,
  );
  const campuses = new Set<"omiya" | "toyosu">(
    (record?.record.holdings ?? [])
      .map((holding) => holding.campus)
      .filter(
        (campus): campus is "omiya" | "toyosu" =>
          campus === "omiya" || campus === "toyosu",
      ),
  );
  const values: Array<"omiya" | "toyosu"> =
    campuses.size > 0 ? [...campuses] : ["omiya", "toyosu"];
  return values.map((value) => ({
    value,
    label: value === "omiya" ? "大宮図書館" : "豊洲図書館",
  }));
}

function messageFromResponse(response: ChatRunResponse): ChatTimelineMessage {
  if (response.status !== "completed") {
    throw new Error("Chat response is not complete.");
  }
  return {
    id: response.message.message_id,
    role: "assistant",
    content: response.message.content_markdown,
    evidence: response.message.evidence,
    proposal: response.proposal,
    // A reservation request has already passed the read-only action-options
    // check. It still requires campus selection and a final confirmation, but
    // an extra generic "approve proposal" click would add no safety.
    proposalState:
      response.proposal?.operation?.action_type === "reserve"
        ? "approved"
        : response.proposal
          ? "pending"
          : undefined,
    relatedBooks: response.message.related_books ?? [],
  };
}

function toolResultRequest(
  toolCallId: string,
  name:
    | "scombz_page_summary"
    | "scombz_read"
    | "scombz_course_list"
    | "scombz_portal_read"
    | "scombz_course_read"
    | "scombz_material_search"
    | "syllabus_read"
    | "google_calendar_availability"
    | "syllabus_search"
    | "browser_read_url"
    | "sitrus_read"
    | "moodle_read"
    | "my_library_read"
    | "cast_read"
    | "cast_alumni_read"
    | "cast_search"
    | "cast_career_search"
    | "library_catalog_search"
    | "library_item_read"
    | "library_catalog_browse"
    | "library_discovery_search"
    | "library_action_options",
  result: ChatToolResultRequest["result"],
): ChatToolResultRequest {
  return {
    tool_call_id: toolCallId,
    name,
    version: 1,
    result,
  };
}

function castCareerFailureProjection(
  argumentsObject: Record<string, unknown>,
  error: unknown,
): CastCareerAgentProjection {
  const surfaces = Array.isArray(argumentsObject.surfaces)
    ? argumentsObject.surfaces.filter(
        (surface): surface is CastCareerSurface =>
          typeof surface === "string" &&
          [
            "job",
            "internship",
            "company_session",
            "company",
            "hiring_record",
            "selection_report",
            "recording",
            "career_event",
            "counseling",
          ].includes(surface),
      )
    : [];
  const safeSurfaces =
    surfaces.length > 0 ? [...new Set(surfaces)] : (["company"] as const);
  const reasonCode = failureCodeFromError(error);
  return {
    schema_version: "v1",
    status:
      reasonCode === "reauth_required" ||
      reasonCode === "form_changed" ||
      reasonCode === "rate_limited"
        ? reasonCode
        : "unavailable",
    searched_surfaces: [...safeSurfaces],
    surface_coverage: safeSurfaces.map((surface) => ({
      surface,
      status:
        reasonCode === "reauth_required" ||
        reasonCode === "form_changed" ||
        reasonCode === "rate_limited"
          ? reasonCode
          : "unavailable",
      total_count: null,
      returned_count: 0,
      fetched_pages: 0,
      page_size: 0,
      reason_code: reasonCode,
    })),
    total_count: 0,
    returned_count: 0,
    anonymous_aggregates: [],
    evidence_ids: [],
    reason_codes: [reasonCode],
  };
}

function sendExtensionMessage<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T | undefined) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError || response === undefined) {
        const detail = runtimeError?.message?.trim();
        reject(
          new Error(
            detail
              ? `拡張機能のToolを利用できません: ${detail}`
              : "拡張機能のToolを利用できません。",
          ),
        );
        return;
      }
      resolve(response);
    });
  });
}

type ChatProgressPhase =
  | "sending"
  | "planning"
  | "tool-running"
  | "resuming"
  | "completed"
  | "error";

interface ChatProgress {
  phase: ChatProgressPhase;
  label: string;
  detail: string;
  detailBase: string;
  startedAt: number;
}

export function ChatPanel({
  apiClient,
  pageContext,
  calendarState,
  calendarConnector,
  calendarRequest,
  mode = "sidepanel",
  settingsOpen = false,
  settingsButtonRef,
  onOpenSettings,
  onOpenWorkspace,
  workspaceDisabled = false,
  disabled = false,
}: ChatPanelProps) {
  const [conversation, setConversation] = useState<ChatConversation>(() =>
    newConversation(),
  );
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [composer, setComposer] = useState("");
  const [retryText, setRetryText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ChatProgress | null>(null);
  const [localMoodleDetails, setLocalMoodleDetails] = useState<
    Record<string, MoodleLocalSnapshot>
  >({});
  const [localMyLibraryDetails, setLocalMyLibraryDetails] = useState<
    Record<string, MyLibraryLocalSnapshot>
  >({});
  const [localCastDetails, setLocalCastDetails] = useState<
    Record<string, CastLocalSnapshot>
  >({});
  const [localCastAlumniDetails, setLocalCastAlumniDetails] = useState<
    Record<string, CastAlumniLocalSnapshot>
  >({});
  const [localCastSearchDetails, setLocalCastSearchDetails] = useState<
    Record<string, CastSearchLocalKnownResult>
  >({});
  const [localCastCareerDetails, setLocalCastCareerDetails] = useState<
    Record<string, LocalCastCareerDetail>
  >({});
  type LocalLibraryRecord = NonNullable<
    LibraryCatalogSearchResult["items"]
  >[number];
  const [localLibraryDetails, setLocalLibraryDetails] = useState<
    Record<string, LocalLibraryRecord[]>
  >({});
  const [localLibraryPresentations, setLocalLibraryPresentations] = useState<
    Record<string, "summary" | "location">
  >({});
  const [libraryPreviews, setLibraryPreviews] = useState<
    Record<string, Extract<LibraryActionPreviewResponse, { status: "ready" }>>
  >({});
  const [libraryPreviewInputs, setLibraryPreviewInputs] = useState<
    Record<string, LibraryActionEditableInputs>
  >({});
  const [libraryPreviewStates, setLibraryPreviewStates] = useState<
    Record<string, "previewing" | "submitting" | "verified" | "unavailable">
  >({});
  const [libraryPreviewErrors, setLibraryPreviewErrors] = useState<
    Record<string, string>
  >({});
  const [libraryChoiceFreeform, setLibraryChoiceFreeform] = useState<
    Record<string, string>
  >({});
  // Syllabus refs are short-lived handles, not reusable URLs. Keep the
  // conversation binding alongside the URL so a ref returned in one Chat
  // cannot be replayed from a different Chat.
  const syllabusRefsRef = useRef(
    new Map<string, { conversationId: string; url: string }>(),
  );
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const pseudonymizerRef = useRef(new ConversationPseudonymizationGateway());
  // Loading the history is asynchronous.  If a user starts a new chat (or
  // sends the first message) before that read completes, the late result must
  // not replace the conversation they are actively editing with an older one.
  const conversationInteractionRef = useRef(false);

  function setChatProgress(
    phase: ChatProgressPhase,
    label: string,
    detail: string,
  ): void {
    setProgress((current) => {
      const sameBoundary =
        current?.phase === phase &&
        current.label === label &&
        current.detailBase === detail;
      return {
        phase,
        label,
        detail: sameBoundary ? current.detail : detail,
        detailBase: detail,
        startedAt: sameBoundary ? current.startedAt : Date.now(),
      };
    });
  }

  useEffect(() => {
    if (
      !progress ||
      progress.phase === "completed" ||
      progress.phase === "error"
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      setProgress((current) => {
        if (!current || current.startedAt !== progress.startedAt)
          return current;
        const elapsed = Math.floor((Date.now() - current.startedAt) / 1000);
        return {
          ...current,
          detail:
            elapsed >= 3
              ? `${current.detailBase}（${elapsed}秒経過）`
              : current.detailBase,
        };
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [progress]);

  const pageSummary = useMemo(
    () => projectScombzPageSummary(pageContext),
    [pageContext],
  );

  useEffect(() => {
    let mounted = true;
    void listConversations().then((items) => {
      if (!mounted) return;
      setConversations(items);
      if (!conversationInteractionRef.current && items[0]) {
        setConversation(items[0]);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  async function persist(next: ChatConversation): Promise<void> {
    setConversation(next);
    setConversations((items) => {
      const without = items.filter(
        (item) => item.conversationId !== next.conversationId,
      );
      return [next, ...without].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
    });
    await saveConversation(next);
  }

  function clientTools(
    serverTools: ReadonlySet<string> | null = null,
    maxClientTools = 32,
  ) {
    const liveScombzTools = new Set([
      "scombz_course_list",
      "scombz_portal_read",
      "scombz_course_read",
      "scombz_material_search",
    ]);
    const allows = (name: string): boolean => {
      if (serverTools === null) return true;
      return serverTools.has(name);
    };
    const tools: Array<{
      name:
        | "scombz_page_summary"
        | "scombz_read"
        | "scombz_course_list"
        | "scombz_portal_read"
        | "scombz_course_read"
        | "scombz_material_search"
        | "google_calendar_availability"
        | "syllabus_search"
        | "syllabus_read"
        | "browser_read_url"
        | "sitrus_read"
        | "moodle_read"
        | "my_library_read"
        | "cast_read"
        | "cast_alumni_read"
        | "cast_search"
        | "cast_career_search"
        | "library_catalog_search"
        | "library_item_read"
        | "library_catalog_browse"
        | "library_discovery_search"
        | "library_action_options";
      version: 1;
    }> = [];
    if (projectScombzRead(pageContext) && allows("scombz_read")) {
      tools.push({ name: "scombz_read", version: 1 });
    }
    if (pageContext?.kind === "scombz" && serverTools !== null) {
      for (const name of liveScombzTools as Set<
        | "scombz_course_list"
        | "scombz_portal_read"
        | "scombz_course_read"
        | "scombz_material_search"
      >) {
        if (allows(name)) tools.push({ name, version: 1 });
      }
    }
    if (
      calendarState.status === "connected" &&
      calendarState.snapshot &&
      allows("google_calendar_availability")
    ) {
      tools.push({ name: "google_calendar_availability", version: 1 });
    }
    if (allows("syllabus_search"))
      tools.push({ name: "syllabus_search", version: 1 });
    if (allows("syllabus_read"))
      tools.push({ name: "syllabus_read", version: 1 });
    if (allows("browser_read_url"))
      tools.push({ name: "browser_read_url", version: 1 });
    if (isSitrusGradeUrl(pageContext?.url) && allows("sitrus_read")) {
      tools.push({ name: "sitrus_read", version: 1 });
    }
    if (allows("moodle_read")) tools.push({ name: "moodle_read", version: 1 });
    if (allows("my_library_read"))
      tools.push({ name: "my_library_read", version: 1 });
    if (allows("cast_read")) tools.push({ name: "cast_read", version: 1 });
    if (allows("cast_alumni_read"))
      tools.push({ name: "cast_alumni_read", version: 1 });
    if (allows("cast_search")) tools.push({ name: "cast_search", version: 1 });
    if (allows("cast_career_search"))
      tools.push({ name: "cast_career_search", version: 1 });
    // OPAC/SIT Search reads are public and read-only. Advertise them on every
    // turn so the Agent can resolve elliptical follow-ups such as
    // 「どこに配架されてる？」 from the conversation context instead of
    // relying on a brittle latest-message keyword gate.
    for (const name of [
      "library_catalog_search",
      "library_item_read",
      "library_catalog_browse",
      "library_discovery_search",
      "library_action_options",
    ] as const) {
      if (allows(name)) tools.push({ name, version: 1 });
    }
    const advertised = advertiseReadOnlyTools({
      locallyAvailable: new Set(tools.map((tool) => tool.name)),
      serverAllowed: serverTools,
      maxClientTools,
    });
    return advertised as typeof tools;
  }

  async function runTool(
    response: Extract<ChatRunResponse, { status: "tool_required" }>,
    current: ChatConversation,
    progressLabel = toolLabel(response.calls[0]?.name ?? ""),
    options: { submit?: boolean } = {},
  ): Promise<{
    response: ChatRunResponse;
    conversation: ChatConversation;
    request: ChatToolResultRequest;
  }> {
    const [call] = response.calls;
    if (!call) {
      throw new Error("AgentのTool呼び出しを検証できません。");
    }
    const argumentsObject = call.arguments ?? {};
    if (call.version !== 1 || typeof argumentsObject !== "object") {
      throw new Error("AgentのTool引数を検証できません。");
    }
    if (!isRegisteredReadOnlyTool(call.name)) {
      throw new Error("このChatではまだ対応していないToolです。");
    }
    const registryValidation = validateChatToolArguments(
      call.name,
      argumentsObject,
    );
    if (!registryValidation.ok) {
      throw new Error(
        `AgentのTool引数を検証できません（${registryValidation.reason}）。`,
      );
    }
    if (
      (call.name === "scombz_page_summary" ||
        call.name === "scombz_read" ||
        call.name === "google_calendar_availability" ||
        call.name === "sitrus_read" ||
        call.name === "moodle_read" ||
        call.name === "cast_read" ||
        call.name === "cast_alumni_read") &&
      Object.keys(argumentsObject).length > 0
    ) {
      throw new Error("このToolには引数を指定できません。");
    }
    if (call.name === "cast_search" && !isCastSearchRequest(argumentsObject)) {
      throw new Error("CAST検索の意味フィルターを検証できません。");
    }
    if (
      call.name === "cast_career_search" &&
      !isCastCareerSearchRequest(argumentsObject)
    ) {
      throw new Error("CAST横断検索の意味フィルターを検証できません。");
    }
    if (
      call.name === "syllabus_search" &&
      (typeof argumentsObject.query !== "string" ||
        argumentsObject.query.trim().length === 0 ||
        argumentsObject.query.length > 200 ||
        Object.keys(argumentsObject).some(
          (key) => !["query", "year", "faculty"].includes(key),
        ))
    ) {
      throw new Error("シラバス検索の引数を検証できません。");
    }
    if (
      call.name === "scombz_course_list" &&
      Object.keys(argumentsObject).some(
        (key) => !["query", "academic_year", "term", "cursor"].includes(key),
      )
    ) {
      throw new Error("SCombZ履修科目の引数を検証できません。");
    }
    if (
      call.name === "scombz_portal_read" &&
      Object.keys(argumentsObject).some(
        (key) => !["sections", "query", "cursor"].includes(key),
      )
    ) {
      throw new Error("SCombZポータルの引数を検証できません。");
    }
    if (
      call.name === "scombz_course_read" &&
      (!Array.isArray(argumentsObject.course_refs) ||
        argumentsObject.course_refs.length < 1 ||
        argumentsObject.course_refs.length > 5 ||
        Object.keys(argumentsObject).some(
          (key) =>
            ![
              "course_refs",
              "sections",
              "query",
              "cursor",
              "include_own_submission",
            ].includes(key),
        ) ||
        (argumentsObject.include_own_submission !== undefined &&
          typeof argumentsObject.include_own_submission !== "boolean"))
    ) {
      throw new Error("SCombZ授業情報の科目指定を検証できません。");
    }
    if (
      call.name === "scombz_material_search" &&
      (typeof argumentsObject.course_ref !== "string" ||
        typeof argumentsObject.query !== "string")
    ) {
      throw new Error("SCombZ教材検索の引数を検証できません。");
    }
    if (
      call.name === "syllabus_read" &&
      (typeof argumentsObject.syllabus_ref !== "string" ||
        !/^orbit-syllabus:\/\/result\/[A-Za-z0-9_-]{16,128}$/u.test(
          argumentsObject.syllabus_ref,
        ) ||
        Object.keys(argumentsObject).length !== 1)
    ) {
      throw new Error("シラバス詳細の引数を検証できません。");
    }
    if (
      call.name === "my_library_read" &&
      (Object.keys(argumentsObject).some(
        (key) => !["scope", "query", "offset", "limit"].includes(key),
      ) ||
        (argumentsObject.scope !== undefined &&
          ![
            "current_loans",
            "reservations",
            "loan_history",
            "purchase_requests",
            "interlibrary_requests",
          ].includes(argumentsObject.scope as string)) ||
        (argumentsObject.query !== undefined &&
          argumentsObject.query !== null &&
          (typeof argumentsObject.query !== "string" ||
            argumentsObject.query.length > 200)) ||
        (argumentsObject.offset !== undefined &&
          (typeof argumentsObject.offset !== "number" ||
            !Number.isInteger(argumentsObject.offset) ||
            argumentsObject.offset < 0 ||
            argumentsObject.offset > 1000)) ||
        (argumentsObject.limit !== undefined &&
          (typeof argumentsObject.limit !== "number" ||
            !Number.isInteger(argumentsObject.limit) ||
            argumentsObject.limit < 1 ||
            argumentsObject.limit > 20)))
    ) {
      throw new Error("My Libraryのscope・ページ引数を検証できません。");
    }
    if (
      call.name === "syllabus_search" &&
      argumentsObject.year !== undefined &&
      argumentsObject.year !== null &&
      (typeof argumentsObject.year !== "number" ||
        !Number.isInteger(argumentsObject.year) ||
        argumentsObject.year < 2000 ||
        argumentsObject.year > 2100)
    ) {
      throw new Error("シラバス検索の年度を検証できません。");
    }
    if (
      call.name === "syllabus_search" &&
      argumentsObject.faculty !== undefined &&
      argumentsObject.faculty !== null &&
      (typeof argumentsObject.faculty !== "string" ||
        argumentsObject.faculty.length > 200)
    ) {
      throw new Error("シラバス検索の学部を検証できません。");
    }
    if (
      call.name === "browser_read_url" &&
      (typeof argumentsObject.url !== "string" ||
        Object.keys(argumentsObject).length !== 1)
    ) {
      throw new Error("参照先URLを検証できません。");
    }
    if (
      call.name === "library_catalog_search" &&
      (typeof argumentsObject.query !== "string" ||
        !argumentsObject.query.trim() ||
        argumentsObject.query.length > 200 ||
        Object.keys(argumentsObject).some(
          (key) =>
            ![
              "query",
              "author",
              "subject",
              "isbn",
              "pub_year",
              "campus",
              "format",
              "limit",
            ].includes(key),
        ) ||
        (argumentsObject.author !== undefined &&
          argumentsObject.author !== null &&
          (typeof argumentsObject.author !== "string" ||
            argumentsObject.author.length > 200)) ||
        (argumentsObject.subject !== undefined &&
          argumentsObject.subject !== null &&
          (typeof argumentsObject.subject !== "string" ||
            argumentsObject.subject.length > 200)) ||
        (argumentsObject.isbn !== undefined &&
          argumentsObject.isbn !== null &&
          (typeof argumentsObject.isbn !== "string" ||
            argumentsObject.isbn.length > 32)) ||
        (argumentsObject.pub_year !== undefined &&
          argumentsObject.pub_year !== null &&
          (typeof argumentsObject.pub_year !== "number" ||
            !Number.isInteger(argumentsObject.pub_year) ||
            argumentsObject.pub_year < 1000 ||
            argumentsObject.pub_year > 2100)) ||
        (argumentsObject.campus !== undefined &&
          !["toyosu", "omiya", "any"].includes(
            argumentsObject.campus as string,
          )) ||
        (argumentsObject.format !== undefined &&
          !["book", "journal", "ebook", "any"].includes(
            argumentsObject.format as string,
          )) ||
        (argumentsObject.limit !== undefined &&
          (typeof argumentsObject.limit !== "number" ||
            !Number.isInteger(argumentsObject.limit) ||
            argumentsObject.limit < 1 ||
            argumentsObject.limit > 10)))
    ) {
      throw new Error("OPAC検索の引数を検証できません。");
    }
    if (
      call.name === "library_item_read" &&
      (Object.keys(argumentsObject).some(
        (key) => !["resource_ref", "presentation"].includes(key),
      ) ||
        typeof argumentsObject.resource_ref !== "string" ||
        !/^orbit-library:\/\/record\/[A-Za-z0-9_-]{16,128}$/u.test(
          argumentsObject.resource_ref,
        ) ||
        (argumentsObject.presentation !== undefined &&
          argumentsObject.presentation !== "summary" &&
          argumentsObject.presentation !== "location"))
    ) {
      throw new Error("OPAC書誌参照の引数を検証できません。");
    }
    if (
      call.name === "library_catalog_browse" &&
      (Object.keys(argumentsObject).some(
        (key) => !["kind", "campus", "limit"].includes(key),
      ) ||
        !["new_books", "loan_ranking"].includes(
          argumentsObject.kind as string,
        ) ||
        (argumentsObject.campus !== undefined &&
          !["toyosu", "omiya", "any"].includes(
            argumentsObject.campus as string,
          )) ||
        (argumentsObject.limit !== undefined &&
          (typeof argumentsObject.limit !== "number" ||
            !Number.isInteger(argumentsObject.limit) ||
            argumentsObject.limit < 1 ||
            argumentsObject.limit > 10)))
    ) {
      throw new Error("OPAC一覧の引数を検証できません。");
    }
    if (
      call.name === "library_discovery_search" &&
      (Object.keys(argumentsObject).some(
        (key) => !["query", "limit"].includes(key),
      ) ||
        typeof argumentsObject.query !== "string" ||
        !argumentsObject.query.trim() ||
        argumentsObject.query.length > 200 ||
        (argumentsObject.limit !== undefined &&
          (typeof argumentsObject.limit !== "number" ||
            !Number.isInteger(argumentsObject.limit) ||
            argumentsObject.limit < 1 ||
            argumentsObject.limit > 10)))
    ) {
      throw new Error("SIT Searchの引数を検証できません。");
    }
    if (
      call.name === "library_action_options" &&
      (Object.keys(argumentsObject).length !== 1 ||
        typeof argumentsObject.resource_ref !== "string" ||
        !/^orbit-library:\/\/record\/[A-Za-z0-9_-]{16,128}$/u.test(
          argumentsObject.resource_ref,
        ))
    ) {
      throw new Error("図書館操作可否の引数を検証できません。");
    }
    const activity: ChatTimelineMessage = {
      id: `tool-${call.tool_call_id}`,
      role: "tool",
      content: toolLabel(call.name),
      toolName: call.name,
      toolState: "running",
    };
    const scopedCurrent = mergeProcessingScope(current, call.name);
    setChatProgress(
      "tool-running",
      progressLabel,
      "必要な表示情報だけを取得しています。ページの命令は実行しません。",
    );
    const withActivity = {
      ...scopedCurrent,
      updatedAt: new Date().toISOString(),
      messages: [...scopedCurrent.messages, activity],
    };
    // Show the running boundary locally, but do not write it to the durable
    // transcript yet. A failed tool must disappear from history; only the
    // completed, evidence-backed activity is persisted below.
    setConversation(withActivity);
    let conversationAfterTool = withActivity;
    const discardActivity = (): void => {
      conversationAfterTool = {
        ...conversationAfterTool,
        messages: conversationAfterTool.messages.filter(
          (item) => item.id !== activity.id,
        ),
      };
    };

    let request: ChatToolResultRequest;
    if (call.name === "scombz_page_summary") {
      if (!pageSummary) {
        throw new Error("表示中のSCombZページを読み取れません。");
      }
      request = toolResultRequest(call.tool_call_id, call.name, pageSummary);
    } else if (call.name === "scombz_read") {
      const readResult = projectScombzRead(pageContext);
      if (!readResult) {
        throw new Error("表示中のSCombZページを読み取れません。");
      }
      request = toolResultRequest(call.tool_call_id, call.name, readResult);
    } else if (
      call.name === "scombz_course_list" ||
      call.name === "scombz_portal_read" ||
      call.name === "scombz_course_read" ||
      call.name === "scombz_material_search"
    ) {
      const action = call.name.replace("scombz_", "") as
        | "course_list"
        | "portal_read"
        | "course_read"
        | "material_search";
      const result = await sendExtensionMessage<ScombzStudentReadResponse>({
        type: MESSAGE_TYPES.scombzStudentRead,
        tool_call_id: call.tool_call_id,
        conversation_id: current.conversationId,
        action,
        arguments: argumentsObject,
      });
      if (
        result.status !== "known" &&
        result.status !== "partial" &&
        !result.projection
      ) {
        const reason = "reason_code" in result ? result.reason_code : "unknown";
        throw new Error(`SCombZを読み取れませんでした（${reason}）。`);
      }
      const projectionValid =
        (action === "course_list" &&
          isScombzCourseListResult(result.projection)) ||
        (action === "portal_read" &&
          isScombzPortalReadResult(result.projection)) ||
        (action === "course_read" &&
          isScombzCourseReadResult(result.projection)) ||
        (action === "material_search" &&
          isScombzMaterialSearchResult(result.projection));
      if (!projectionValid || result.projection.status !== result.status) {
        throw new Error("SCombZの取得結果を検証できませんでした。");
      }
      request = toolResultRequest(
        call.tool_call_id,
        call.name,
        result.projection as ChatToolResultRequest["result"],
      );
    } else if (call.name === "google_calendar_availability") {
      const refreshed = calendarConnector
        ? await calendarConnector.refresh()
        : await calendarRequest("refresh");
      if (refreshed.status === "reauth_required") {
        throw new Error("Google Calendarの再認証が必要です。");
      }
      if (refreshed.status !== "connected" || !refreshed.snapshot) {
        throw new Error(
          refreshed.message ?? "Google Calendarを利用できません。",
        );
      }
      request = toolResultRequest(
        call.tool_call_id,
        call.name,
        projectCalendarAvailability(refreshed.snapshot),
      );
    } else if (call.name === "syllabus_search") {
      const syllabus = await sendExtensionMessage<SyllabusSearchResult>({
        type: "syllabus-search",
        tool_call_id: call.tool_call_id,
        query: argumentsObject.query as string,
        year:
          typeof argumentsObject.year === "number"
            ? argumentsObject.year
            : null,
        faculty:
          typeof argumentsObject.faculty === "string"
            ? argumentsObject.faculty
            : null,
      });
      if (!isSyllabusSearchResult(syllabus)) {
        throw new Error("シラバス検索結果を検証できません。");
      }
      for (const result of syllabus.results ?? []) {
        if (result.syllabus_ref) {
          syllabusRefsRef.current.set(result.syllabus_ref, {
            conversationId: current.conversationId,
            url: result.url,
          });
        }
      }
      request = toolResultRequest(call.tool_call_id, call.name, syllabus);
    } else if (call.name === "syllabus_read") {
      const syllabusRef = argumentsObject.syllabus_ref as string;
      const handle = syllabusRefsRef.current.get(syllabusRef);
      const targetUrl =
        handle?.conversationId === current.conversationId ? handle.url : null;
      const fallbackUrl = "https://syllabus.sic.shibaura-it.ac.jp/";
      const citationUri = `orbit-syllabus://citation/${syllabusRef.split("/").pop() ?? "detail"}`;
      const unavailableDetail = (reasonCode: string): SyllabusReadResult => ({
        schema_version: "v1",
        status: "unavailable",
        syllabus_ref: syllabusRef,
        url: targetUrl ?? fallbackUrl,
        course_code: null,
        title: null,
        instructors: [],
        objectives: null,
        weekly_plan: [],
        evaluation: null,
        textbooks: [],
        prerequisites: null,
        observed_at: new Date().toISOString(),
        reason_code: reasonCode,
        citation_uri: citationUri,
      });
      if (!targetUrl) {
        request = toolResultRequest(
          call.tool_call_id,
          call.name,
          unavailableDetail("syllabus_ref_expired"),
        );
      } else {
        try {
          const target = new URL(targetUrl);
          if (
            target.origin !== "https://syllabus.sic.shibaura-it.ac.jp" ||
            target.protocol !== "https:"
          ) {
            request = toolResultRequest(
              call.tool_call_id,
              call.name,
              unavailableDetail("syllabus_origin_rejected"),
            );
          } else {
            const response = await fetch(target.href, { credentials: "omit" });
            if (!response.ok) {
              request = toolResultRequest(
                call.tool_call_id,
                call.name,
                unavailableDetail(`http_${response.status}`),
              );
            } else {
              const detail = parseSyllabusDetailHtml(await response.text());
              const projection = {
                schema_version: "v1" as const,
                status: "known" as const,
                syllabus_ref: syllabusRef,
                url: target.href,
                course_code: detail.course_code,
                title: detail.title,
                instructors: detail.instructors,
                objectives: detail.objectives,
                weekly_plan: detail.weekly_plan,
                evaluation: detail.evaluation,
                textbooks: detail.textbooks,
                prerequisites: detail.prerequisites,
                observed_at: new Date().toISOString(),
                reason_code: null,
                citation_uri: citationUri,
              } satisfies SyllabusReadResult;
              request = toolResultRequest(
                call.tool_call_id,
                call.name,
                isSyllabusReadResult(projection)
                  ? projection
                  : unavailableDetail("syllabus_structure_not_found"),
              );
            }
          }
        } catch {
          request = toolResultRequest(
            call.tool_call_id,
            call.name,
            unavailableDetail("network_error"),
          );
        }
      }
    } else if (call.name === "library_catalog_search") {
      setChatProgress(
        "tool-running",
        progressLabel,
        "検索結果の書誌と所蔵欄を確認しています。",
      );
      const library = await sendExtensionMessage<LibraryCatalogSearchResponse>({
        type: "library-catalog-search",
        tool_call_id: call.tool_call_id,
        query: argumentsObject.query as string,
        author:
          typeof argumentsObject.author === "string"
            ? argumentsObject.author
            : null,
        subject:
          typeof argumentsObject.subject === "string"
            ? argumentsObject.subject
            : null,
        isbn:
          typeof argumentsObject.isbn === "string"
            ? argumentsObject.isbn
            : null,
        pub_year:
          typeof argumentsObject.pub_year === "number"
            ? argumentsObject.pub_year
            : null,
        campus:
          typeof argumentsObject.campus === "string"
            ? (argumentsObject.campus as "toyosu" | "omiya" | "any")
            : "any",
        format:
          typeof argumentsObject.format === "string"
            ? (argumentsObject.format as "book" | "journal" | "ebook" | "any")
            : "any",
        limit:
          typeof argumentsObject.limit === "number"
            ? argumentsObject.limit
            : 10,
      });
      if (library.status === "permission_required") {
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
        );
      }
      if (library.status === "unavailable") {
        discardActivity();
        setChatProgress(
          "tool-running",
          "OPACを再確認できませんでした",
          libraryFailureDetail(library.reason_code),
        );
        request = toolResultRequest(call.tool_call_id, call.name, {
          schema_version: "v1",
          status: "unavailable",
          query: argumentsObject.query as string,
          items: [],
          reason_code: library.reason_code,
        });
      } else if (!isLibraryCatalogSearchResult(library.projection)) {
        throw new Error("OPAC検索結果を検証できませんでした。");
      } else {
        setLocalLibraryDetails((items) => ({
          ...items,
          [activity.id]: library.projection.items ?? [],
        }));
        conversationAfterTool = mergeLibraryContext(
          conversationAfterTool,
          library.projection.items ?? [],
        );
        request = toolResultRequest(
          call.tool_call_id,
          call.name,
          library.projection,
        );
      }
    } else if (call.name === "library_item_read") {
      setChatProgress(
        "tool-running",
        "所蔵詳細を確認中",
        "所在、請求記号、貸出状態を公式書誌から確認しています。",
      );
      const libraryResourceRef = argumentsObject.resource_ref as string;
      const presentation =
        argumentsObject.presentation === "location" ? "location" : "summary";
      setLocalLibraryPresentations((items) => ({
        ...items,
        [activity.id]: presentation,
      }));
      const manifestRecord =
        conversationAfterTool.contextManifest.library_records.find(
          (item) => item.resource_ref === libraryResourceRef,
        );
      const library = await sendExtensionMessage<LibraryItemReadResponse>({
        type: "library-item-read",
        tool_call_id: call.tool_call_id,
        resource_ref: libraryResourceRef,
        presentation,
        ...(manifestRecord ? { record_url: manifestRecord.record.url } : {}),
      });
      if (library.status === "permission_required") {
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
        );
      }
      if (library.status === "unavailable") {
        discardActivity();
        setChatProgress(
          "tool-running",
          "所蔵詳細を再確認できませんでした",
          libraryFailureDetail(library.reason_code),
        );
        request = toolResultRequest(call.tool_call_id, call.name, {
          schema_version: "v1",
          status: "unavailable",
          resource_ref: libraryResourceRef,
          item: null,
          reason_code: library.reason_code,
        });
      } else if (!isLibraryItemReadResult(library.projection)) {
        throw new Error("OPAC書誌詳細を検証できませんでした。");
      } else {
        setLocalLibraryDetails((items) => ({
          ...items,
          [activity.id]: library.projection.item
            ? [library.projection.item]
            : [],
        }));
        conversationAfterTool = mergeLibraryContext(
          conversationAfterTool,
          library.projection.item ? [library.projection.item] : [],
        );
        request = toolResultRequest(
          call.tool_call_id,
          call.name,
          library.projection,
        );
      }
    } else if (call.name === "library_action_options") {
      const actionResourceRef = argumentsObject.resource_ref as string;
      const actionManifestRecord =
        conversationAfterTool.contextManifest.library_records.find(
          (item) => item.resource_ref === actionResourceRef,
        );
      const library = await sendExtensionMessage<LibraryActionOptionsResponse>({
        type: MESSAGE_TYPES.libraryActionOptions,
        tool_call_id: call.tool_call_id,
        resource_ref: actionResourceRef,
        ...(actionManifestRecord
          ? { record_url: actionManifestRecord.record.url }
          : {}),
      });
      if (library.status === "permission_required") {
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
        );
      }
      if (library.status === "reauth_required") {
        throw new Error(
          "図書館のログイン状態を確認できません。公式ページでログイン後、もう一度お試しください。",
        );
      }
      const projection = library.status === "known" ? library.projection : null;
      if (!projection || !isLibraryActionOptionsResult(projection)) {
        throw new Error("図書館の操作可否を検証できませんでした。");
      }
      if (projection.status === "unavailable") {
        discardActivity();
      }
      if (projection.data_classification === "personal") {
        const capabilities = await apiClient.capabilities();
        if (
          capabilities.agent_backend !== "azure_openai" ||
          !capabilities.my_library_personal_context
        ) {
          throw new Error(
            "My Library由来の操作可否は、明示同意済みのAzure Agentだけに送信できます。",
          );
        }
      }
      request = toolResultRequest(call.tool_call_id, call.name, projection);
    } else if (call.name === "library_catalog_browse") {
      const library = await sendExtensionMessage<LibraryCatalogBrowseResponse>({
        type: "library-catalog-browse",
        tool_call_id: call.tool_call_id,
        kind: argumentsObject.kind as "new_books" | "loan_ranking",
        campus:
          typeof argumentsObject.campus === "string"
            ? (argumentsObject.campus as "toyosu" | "omiya" | "any")
            : "any",
        limit:
          typeof argumentsObject.limit === "number"
            ? argumentsObject.limit
            : 10,
      });
      if (library.status === "permission_required") {
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
        );
      }
      if (library.status === "unavailable") {
        discardActivity();
        request = toolResultRequest(call.tool_call_id, call.name, {
          schema_version: "v1",
          status: "unavailable",
          kind: argumentsObject.kind as "new_books" | "loan_ranking",
          campus:
            typeof argumentsObject.campus === "string"
              ? (argumentsObject.campus as "toyosu" | "omiya" | "any")
              : "any",
          items: [],
          reason_code: library.reason_code,
        });
      } else if (!isLibraryCatalogBrowseResult(library.projection)) {
        throw new Error("OPAC一覧結果を検証できませんでした。");
      } else {
        conversationAfterTool = mergeLibraryContext(
          conversationAfterTool,
          library.projection.items ?? [],
        );
        request = toolResultRequest(
          call.tool_call_id,
          call.name,
          library.projection,
        );
      }
    } else if (call.name === "library_discovery_search") {
      const library =
        await sendExtensionMessage<LibraryDiscoverySearchResponse>({
          type: "library-discovery-search",
          tool_call_id: call.tool_call_id,
          query: argumentsObject.query as string,
          limit:
            typeof argumentsObject.limit === "number"
              ? argumentsObject.limit
              : 10,
        });
      if (library.status === "permission_required") {
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
        );
      }
      if (library.status === "unavailable") {
        discardActivity();
        request = toolResultRequest(call.tool_call_id, call.name, {
          schema_version: "v1",
          status: "unavailable",
          query: argumentsObject.query as string,
          items: [],
          reason_code: library.reason_code,
        });
      } else if (!isLibraryDiscoverySearchResult(library.projection)) {
        throw new Error("SIT Search結果を検証できませんでした。");
      } else {
        request = toolResultRequest(
          call.tool_call_id,
          call.name,
          library.projection,
        );
      }
    } else if (call.name === "sitrus_read") {
      if (!pageContext || !isSitrusGradeUrl(pageContext.url)) {
        throw new Error("表示中のSITRUS成績ページを読み取れません。");
      }
      const access = hostAccessRequest(pageContext.url);
      if (!access) throw new Error("SITRUSの参照先URLを検証できません。");
      const sitrus = await sendExtensionMessage<SitrusReadResponse>({
        type: "sitrus-read",
        tool_call_id: call.tool_call_id,
        page_url: pageContext.url,
      });
      if (sitrus.status === "permission_required") {
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
        );
      }
      if (
        sitrus.status !== "known" ||
        !isSitrusGradeResult(sitrus.projection)
      ) {
        throw new Error("SITRUSの成績を読み取れませんでした。");
      }
      request = toolResultRequest(
        call.tool_call_id,
        call.name,
        sitrus.projection,
      );
    } else if (call.name === "moodle_read") {
      const access = hostAccessRequest(MOODLE_DASHBOARD_URL);
      if (!access) throw new Error("Moodleの参照先URLを検証できません。");
      const moodle = await sendExtensionMessage<MoodleReadResponse>({
        type: "moodle-read",
        tool_call_id: call.tool_call_id,
      });
      if (moodle.status === "permission_required") {
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
        );
      }
      if (moodle.status === "reauth_required") {
        throw new Error(
          "Moodleのログインページを開きました。ログイン後、もう一度質問してください。",
        );
      }
      if (moodle.status !== "known" || !isMoodleReadResult(moodle.projection)) {
        throw new Error("Moodleのダッシュボードを読み取れませんでした。");
      }
      setLocalMoodleDetails((items) => ({
        ...items,
        [activity.id]: moodle.detail,
      }));
      request = toolResultRequest(
        call.tool_call_id,
        call.name,
        moodle.projection,
      );
    } else if (call.name === "my_library_read") {
      const access = hostAccessRequest(MY_LIBRARY_ENTRY_URL);
      if (!access) throw new Error("My Libraryの参照先URLを検証できません。");
      const requestedScope =
        typeof argumentsObject.scope === "string"
          ? (argumentsObject.scope as
              | "current_loans"
              | "reservations"
              | "loan_history"
              | "purchase_requests"
              | "interlibrary_requests")
          : "current_loans";
      const requestedOffset =
        typeof argumentsObject.offset === "number" ? argumentsObject.offset : 0;
      const requestedLimit =
        typeof argumentsObject.limit === "number" ? argumentsObject.limit : 20;
      const capabilities = await apiClient.capabilities();
      if (
        capabilities.agent_backend !== "azure_openai" ||
        !capabilities.my_library_personal_context
      ) {
        throw new Error(
          "My Libraryの個人情報はAzure OpenAI Agentに接続している場合だけ送信できます。",
        );
      }
      const library = await sendExtensionMessage<MyLibraryReadResponse>({
        type: "my-library-read",
        tool_call_id: call.tool_call_id,
        scope: requestedScope,
        query:
          typeof argumentsObject.query === "string"
            ? argumentsObject.query
            : null,
        offset: requestedOffset,
        limit: requestedLimit,
      });
      if (library.status === "permission_required") {
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
        );
      }
      if (library.status === "reauth_required") {
        throw new Error(
          "My Libraryを開きました。ログイン後、もう一度質問してください。",
        );
      }
      const projection = library.status === "known" ? library.projection : null;
      if (
        library.status !== "known" ||
        !isMyLibraryReadResult(projection) ||
        !("scope" in projection) ||
        projection.scope !== requestedScope
      ) {
        throw new Error("My Libraryの利用状況を読み取れませんでした。");
      }
      const expectedItemCount = Math.min(
        requestedLimit,
        Math.max(projection.total_count - requestedOffset, 0),
      );
      const expectedNextOffset =
        requestedOffset + expectedItemCount < projection.total_count
          ? requestedOffset + expectedItemCount
          : null;
      if (
        projection.items.length !== expectedItemCount ||
        projection.next_offset !== expectedNextOffset
      ) {
        throw new Error("My Libraryの利用状況を読み取れませんでした。");
      }
      setLocalMyLibraryDetails((items) => ({
        ...items,
        [activity.id]: library.detail,
      }));
      request = toolResultRequest(call.tool_call_id, call.name, projection);
    } else if (call.name === "cast_read") {
      const access = hostAccessRequest(CAST_ENTRY_URL);
      if (!access) throw new Error("CASTの参照先URLを検証できません。");
      const cast = await sendExtensionMessage<CastReadResponse>({
        type: "cast-read",
        tool_call_id: call.tool_call_id,
      });
      if (cast.status === "permission_required") {
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
        );
      }
      if (cast.status === "reauth_required") {
        throw new Error(
          "CASTを開きました。ログイン後、もう一度質問してください。",
        );
      }
      if (cast.status !== "known" || !isCastReadResult(cast.projection)) {
        throw new Error("CASTのトップ画面を読み取れませんでした。");
      }
      setLocalCastDetails((items) => ({
        ...items,
        [activity.id]: cast.detail,
      }));
      request = toolResultRequest(
        call.tool_call_id,
        call.name,
        cast.projection,
      );
    } else if (call.name === "cast_alumni_read") {
      const access = hostAccessRequest(CAST_ENTRY_URL);
      if (!access) throw new Error("CASTの参照先URLを検証できません。");
      const alumni = await sendExtensionMessage<CastAlumniReadResponse>({
        type: "cast-alumni-read",
        tool_call_id: call.tool_call_id,
        conversation_id: current.conversationId,
      });
      if (alumni.status === "permission_required") {
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
        );
      }
      if (alumni.status === "reauth_required") {
        throw new Error(
          "CASTの就活サポーター画面を開いてログイン後、もう一度質問してください。",
        );
      }
      if (
        alumni.status !== "known" ||
        !isCastAlumniReadResult(alumni.projection)
      ) {
        throw new Error("CASTの就活サポーター情報を読み取れませんでした。");
      }
      setLocalCastAlumniDetails((items) => ({
        ...items,
        [activity.id]: alumni.detail,
      }));
      if (alumni.projection.data_classification === "restricted") {
        conversationAfterTool = mergeProcessingScope(
          conversationAfterTool,
          call.name,
          "restricted",
        );
      }
      request = toolResultRequest(
        call.tool_call_id,
        call.name,
        alumni.projection,
      );
    } else if (call.name === "cast_search") {
      const cast = await sendExtensionMessage<CastSearchResponse>({
        type: MESSAGE_TYPES.castSearch,
        tool_call_id: call.tool_call_id,
        ...argumentsObject,
      });
      if (cast.status !== "known") {
        const message =
          cast.status === "reauth_required"
            ? "CASTのログインが必要です。開いた公式ページでログイン後、もう一度検索してください。"
            : cast.status === "form_changed"
              ? "CASTの検索フォームが変更されました。検索を中断しました。"
              : cast.status === "rate_limited"
                ? "CASTの検索が一時的に制限されました。時間を置いて再試行してください。"
                : `CAST検索を利用できませんでした（${cast.reason_code}）。`;
        throw new Error(message);
      }
      if (
        !isCastSearchResult(cast.projection) ||
        !cast.local ||
        cast.local.status !== "known"
      ) {
        throw new Error("CAST検索結果を検証できませんでした。");
      }
      setLocalCastSearchDetails((items) => ({
        ...items,
        [activity.id]: cast.local,
      }));
      request = toolResultRequest(
        call.tool_call_id,
        call.name,
        cast.projection,
      );
    } else if (call.name === "cast_career_search") {
      const cast = await sendExtensionMessage<CastCareerSearchResponse>({
        type: MESSAGE_TYPES.castCareerSearch,
        tool_call_id: call.tool_call_id,
        ...argumentsObject,
      });
      if (!isCastCareerSearchResult(cast.projection)) {
        throw new Error("CAST横断検索結果を検証できませんでした。");
      }
      const projectionStatus = cast.projection.status;
      const isReadable =
        projectionStatus === "known" || projectionStatus === "partial";
      const rankedItems = isReadable
        ? rankCastCareerItems(
            cast.items,
            cast.query,
            argumentsObject.limit as number,
            argumentsObject.filters as CastCareerFilters,
          )
        : [];
      const groups = isReadable
        ? groupCastCareerItems(
            rankedItems,
            argumentsObject.filters as CastCareerFilters,
          )
        : [];
      const reasoningProjection = castReasoningFromResponse(cast);
      setLocalCastCareerDetails((items) => ({
        ...items,
        [activity.id]: {
          result: cast,
          ranked_items: rankedItems,
          groups,
          filters: argumentsObject.filters as CastCareerFilters,
          reasoning_projection: reasoningProjection,
        },
      }));
      if (!isReadable) {
        // A typed failure projection is still submitted so the Agent can
        // continue with another source (for example public Web search).
        // Do not abort the complete multi-source run on one unavailable
        // campus source.
        setChatProgress(
          "resuming",
          `${sourceLabel(call.name)}を確認できませんでした`,
          `${statusLabel(projectionStatus)}。他の情報源を続けて確認します。`,
        );
      }
      request = toolResultRequest(
        call.tool_call_id,
        call.name,
        cast.projection,
      );
    } else {
      const url = argumentsObject.url as string;
      const access = hostAccessRequest(url);
      if (!access) throw new Error("参照先URLを検証できません。");
      const browser = await sendExtensionMessage<BrowserReadResponse>({
        type: "browser-read",
        tool_call_id: call.tool_call_id,
        url,
      });
      if (browser.status === "permission_required") {
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
        );
      }
      if (
        browser.status !== "known" ||
        !isBrowserReadResult(browser.projection)
      ) {
        throw new Error("Webページを読み取れませんでした。");
      }
      request = toolResultRequest(
        call.tool_call_id,
        call.name,
        browser.projection,
      );
    }
    if (
      call.name === "scombz_page_summary" ||
      call.name === "scombz_read" ||
      call.name === "scombz_course_list" ||
      call.name === "scombz_portal_read" ||
      call.name === "scombz_course_read" ||
      call.name === "scombz_material_search" ||
      call.name === "cast_alumni_read"
    ) {
      // Keep the provider-facing result behind the same conversation gateway
      // as the user message and history. The local display/detail state stays
      // untouched; only the request sent to the Agent is transformed.
      const transformed =
        await pseudonymizerRef.current.transformToolProjection(
          conversationAfterTool.conversationId,
          request.result,
        );
      request = {
        ...request,
        result: transformed.provider_result as ChatToolResultRequest["result"],
      };
    }
    const nextResponse =
      options.submit === false
        ? response
        : await apiClient.submitChatToolResult(response.run_id, request);
    setChatProgress(
      "resuming",
      "Agentが取得結果を整理中",
      "Toolの結果を会話の文脈へ戻し、次の判断を生成しています。",
    );
    const rawResult: unknown = request.result;
    const resultRecord = isRecord(rawResult) ? rawResult : null;
    const resultStatus =
      resultRecord &&
      typeof (resultRecord as { status?: unknown }).status === "string"
        ? (resultRecord as { status: string }).status
        : null;
    const failedStatus =
      resultStatus !== null &&
      !["known", "partial", "unknown"].includes(resultStatus);
    const completedConversation = {
      ...conversationAfterTool,
      messages: conversationAfterTool.messages.map((item) =>
        item.id === activity.id
          ? {
              ...item,
              content: failedStatus
                ? `${toolLabel(call.name)}（${statusLabel(resultStatus)}）`
                : item.content,
              toolState: failedStatus
                ? ("failed" as const)
                : ("completed" as const),
            }
          : item,
      ),
    };
    await persist(completedConversation);
    return {
      response: nextResponse,
      conversation: completedConversation,
      request,
    };
  }

  /**
   * Keep a recoverable CAST source failure inside the research loop.  The
   * failure projection intentionally contains only the typed status and
   * surface names, so the Agent can decide whether another public/local
   * source is needed without receiving an HTML error page or a raw message.
   */
  async function recoverToolFailure(
    response: Extract<ChatRunResponse, { status: "tool_required" }>,
    current: ChatConversation,
    error: unknown,
  ): Promise<{
    response: ChatRunResponse;
    conversation: ChatConversation;
  } | null> {
    const [call] = response.calls;
    if (call?.name !== "cast_career_search") return null;

    const projection = castCareerFailureProjection(
      isRecord(call.arguments) ? call.arguments : {},
      error,
    );
    const activityId = `tool-${call.tool_call_id}`;
    const failureContent = `${toolLabel(call.name)}（${statusLabel(projection.status)}）`;
    const failureMessages = current.messages.some(
      (item) => item.id === activityId,
    )
      ? current.messages.map((item) =>
          item.id === activityId
            ? {
                ...item,
                content: failureContent,
                toolState: "failed" as const,
              }
            : item,
        )
      : [
          ...current.messages,
          {
            id: activityId,
            role: "tool" as const,
            content: failureContent,
            toolName: call.name,
            toolState: "failed" as const,
          },
        ];
    const failureConversation: ChatConversation = {
      ...current,
      updatedAt: new Date().toISOString(),
      messages: failureMessages,
    };
    await persist(failureConversation);
    setChatProgress(
      "resuming",
      `${sourceLabel(call.name)}を確認できませんでした`,
      `${statusLabel(projection.status)}。他の情報源を続けて確認します。`,
    );
    const nextResponse = await apiClient.submitChatToolResult(
      response.run_id,
      toolResultRequest(call.tool_call_id, call.name, projection),
    );
    return { response: nextResponse, conversation: failureConversation };
  }

  async function finishResponse(
    initialResponse: ChatRunResponse,
    initialConversation: ChatConversation,
    initialSeenCallIds = new Set<string>(),
  ): Promise<void> {
    let response = initialResponse;
    let current = initialConversation;
    const seenCallIds = initialSeenCallIds;
    const requestedBookCount = explicitBookCount(initialConversation.messages);
    let librarySearchIndex = 0;
    let previousCompleteCatalogQuery: string | null = null;
    for (let index = 0; response.status === "tool_required"; index += 1) {
      if (index >= 8) throw new Error("Tool呼び出し回数の上限に達しました。");
      const call = response.calls[0];
      if (!call || seenCallIds.has(call.tool_call_id)) {
        throw new Error("重複したTool呼び出しを受け取りました。");
      }
      seenCallIds.add(call.tool_call_id);
      const catalogQuery =
        call.name === "library_catalog_search" &&
        typeof call.arguments?.query === "string"
          ? call.arguments.query.replace(/\s+/gu, " ").trim()
          : null;
      const isShortenedCatalogRetry = Boolean(
        catalogQuery &&
          previousCompleteCatalogQuery &&
          catalogQuery !== previousCompleteCatalogQuery &&
          previousCompleteCatalogQuery.includes(catalogQuery),
      );
      if (catalogQuery && !isShortenedCatalogRetry) {
        librarySearchIndex += 1;
        previousCompleteCatalogQuery = catalogQuery;
      }
      const progressLabel =
        call.name === "library_catalog_search" && requestedBookCount
          ? isShortenedCatalogRetry
            ? `${librarySearchIndex}/${requestedBookCount}冊目を短い書名で再確認中`
            : `${librarySearchIndex}/${requestedBookCount}冊目を確認中`
          : toolLabel(call.name);
      setChatProgress(
        "planning",
        "Agentが次の参照先を判断中",
        `${progressLabel}です。`,
      );
      let next: {
        response: ChatRunResponse;
        conversation: ChatConversation;
      };
      try {
        next = await runTool(response, current, progressLabel);
      } catch (error) {
        const recovered = await recoverToolFailure(response, current, error);
        if (!recovered) throw error;
        next = recovered;
      }
      response = next.response;
      current = next.conversation;
    }
    const assistantFromResponse = messageFromResponse(response);
    let restoredAssistant = {
      content: assistantFromResponse.content,
      warnings: [] as string[],
    };
    if (
      current.processing_scope === "personal/scombz_student" ||
      current.processing_scope === "restricted/cast_career" ||
      current.processing_scope === "mixed"
    ) {
      try {
        restoredAssistant = await pseudonymizerRef.current.restoreMarkdown(
          current.conversationId,
          assistantFromResponse.content,
        );
      } catch {
        // A test/fixture mount may not expose Web Crypto.  Provider output is
        // already safe in that case; keep the assistant response visible rather
        // than turning a local restore optimization into a chat failure.
      }
    }
    const assistant: ChatTimelineMessage = {
      ...assistantFromResponse,
      content: restoredAssistant.content,
      display_content: restoredAssistant.content,
      provider_content: assistantFromResponse.content,
      privacy_transform: {
        schema_version: "v1",
        replaced_count: 0,
        removed_fields: [],
        generalized_fields: [],
        warnings: restoredAssistant.warnings,
      },
    };
    setChatProgress("completed", "完了", "回答と参照元を表示しました。");
    const responseManifest =
      response.status === "completed" ? response.context_manifest : null;
    const withEvidence = mergeCompletedChatContext(
      current,
      responseManifest,
      assistant,
    );
    await persist({
      ...withEvidence,
      updatedAt: new Date().toISOString(),
      messages: [...current.messages, assistant],
    });
  }

  async function send(): Promise<void> {
    const message = composer.trim();
    if (!message || busy || disabled) return;
    conversationInteractionRef.current = true;
    setRetryText(null);
    setComposer("");
    setBusy(true);
    setChatProgress(
      "planning",
      "会話文脈を整理中",
      "会話の履歴と現在のページ概要を確認しています。",
    );
    const userMessage: ChatTimelineMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: message,
    };
    const beforeSend = conversation;
    let providerMessage = message;
    const withUser = {
      ...beforeSend,
      title:
        beforeSend.messages.length === 0
          ? message.slice(0, 40)
          : beforeSend.title,
      updatedAt: new Date().toISOString(),
      messages: [...beforeSend.messages, userMessage],
    };
    await persist(withUser);
    let current = withUser;
    try {
      let serverTools: ReadonlySet<string> | null = null;
      let maxClientTools = 32;
      let capabilitiesSnapshot: ChatCapabilities | null = null;
      let providerDestination: ChatConversation["provider_destination"] =
        "local";
      let liveScombzGate = false;
      const capabilityReader = (
        apiClient as AgentApiClient & {
          chatCapabilities?: () => Promise<{
            agent_backend: string;
            observability: string;
            scombz_student_read_mode: string;
            supported_client_tools: readonly string[];
            max_client_tools: number;
          }>;
        }
      ).chatCapabilities;
      if (typeof capabilityReader === "function") {
        try {
          const capabilities = await capabilityReader.call(apiClient);
          capabilitiesSnapshot = capabilities as ChatCapabilities;
          liveScombzGate =
            capabilities.agent_backend === "azure_openai" &&
            capabilities.observability === "off" &&
            capabilities.scombz_student_read_mode === "live";
          providerDestination =
            capabilities.agent_backend === "azure_openai"
              ? "azure_openai"
              : "local";
          const allowed = new Set(capabilities.supported_client_tools);
          maxClientTools = capabilities.max_client_tools;
          if (!liveScombzGate) {
            for (const name of [
              "scombz_course_list",
              "scombz_portal_read",
              "scombz_course_read",
              "scombz_material_search",
            ]) {
              allowed.delete(name);
            }
          }
          serverTools = allowed;
        } catch {
          // Capability failure is fail-closed. The request may still answer
          // from already stored conversation evidence, but it advertises no
          // connector that the server has not explicitly approved.
          serverTools = new Set();
          capabilitiesSnapshot = null;
        }
      }
      if (pageContext?.kind === "scombz") {
        if (!(await hasScombzStudentSessionConsent())) {
          throw new Error(
            "SCombZの授業情報をAzureへ送るには、設定で一度だけ共有同意が必要です。",
          );
        }
        // Bind the conversation to the currently authenticated SCombZ tab at
        // chat start. Subsequent connector calls use this pin and never
        // silently switch to whichever tab later becomes active.
        const pinResult = await sendExtensionMessage<ScombzPinResponse>({
          type: MESSAGE_TYPES.scombzPin,
          conversation_id: withUser.conversationId,
        });
        if (pinResult.status !== "pinned") {
          throw new Error(
            pinResult.reason_code === "scombz_source_tab_changed"
              ? "SCombZの参照元タブが変わりました。元のタブを表示してから再試行してください。"
              : "SCombZの参照元タブを固定できませんでした。ログイン状態と表示中のタブを確認してください。",
          );
        }
        // A production client must not send a personal SCombZ prompt when
        // the authenticated live capability cannot be proven.  In
        // particular, do not continue with the legacy `scombz_read` tool or
        // an unclassified provider message after a capability fetch error.
        if (typeof capabilityReader === "function" && !liveScombzGate) {
          throw new Error(
            capabilitiesSnapshot
              ? "SCombZのlive読み取り機能は現在利用できません。"
              : "SCombZのlive capabilityを確認できません。再認証後に再試行してください。",
          );
        }
      }
      // Keep every Azure-bound user turn behind the conversation gateway. The
      // first CAST question is sent before a restricted projection exists, so
      // limiting this to SCombZ would leave a later follow-up with an
      // unclassified name or contact value in the provider history. Public
      // syllabus text is unchanged unless it contains a direct credential,
      // identifier, or query-bearing URL that must be removed at the boundary.
      if (providerDestination === "azure_openai") {
        const transformed = await pseudonymizerRef.current.transformText(
          withUser.conversationId,
          message,
        );
        providerMessage = transformed.provider_content;
        current = {
          ...current,
          messages: current.messages.map((item) =>
            item.id === userMessage.id
              ? {
                  ...item,
                  display_content: message,
                  provider_content: transformed.provider_content,
                  privacy_transform: transformed.report,
                }
              : item,
          ),
        };
      }
      current = {
        ...current,
        processing_scope:
          pageContext?.kind === "scombz" && liveScombzGate
            ? mergeProcessingScope(current, "scombz_course_list")
                .processing_scope
            : current.processing_scope,
        provider_destination: providerDestination,
        // New conversations are eligible.  A legacy conversation loaded
        // without this metadata remains ineligible and is sent without its
        // old transcript or manifest.
        history_eligible: current.history_eligible,
        updatedAt: new Date().toISOString(),
      };
      await persist(current);
      let providerContextManifest = current.history_eligible
        ? toChatContextManifest(current.contextManifest)
        : null;
      if (
        providerContextManifest &&
        (current.processing_scope === "personal/scombz_student" ||
          current.processing_scope === "restricted/cast_career" ||
          current.processing_scope === "mixed")
      ) {
        const transformedEvidence =
          await pseudonymizerRef.current.transformEvidence(
            current.conversationId,
            providerContextManifest.evidence ?? [],
          );
        providerContextManifest = {
          ...providerContextManifest,
          evidence:
            transformedEvidence as typeof providerContextManifest.evidence,
        };
      }
      setChatProgress(
        "planning",
        "Agentが回答方針を検討中",
        "利用できる参照先と会話の文脈から、次の確認方法を選んでいます。",
      );
      // Keep older embedders usable while they upgrade to the v1 capability
      // endpoint.  The production AgentApiClient always exposes
      // `chatCapabilities`; this branch never advertises the new SCombZ
      // student tools and is retained only for legacy test/host adapters.
      if (typeof capabilityReader !== "function") {
        const response = await apiClient.startChat({
          conversation_id: withUser.conversationId,
          message: providerMessage,
          history: current.history_eligible
            ? toChatHistory(beforeSend.messages, {
                requireProviderContent:
                  current.processing_scope === "personal/scombz_student" ||
                  current.processing_scope === "restricted/cast_career" ||
                  current.processing_scope === "mixed",
              })
            : [],
          client_tools: clientTools(serverTools, maxClientTools),
          context_manifest: providerContextManifest,
        });
        await finishResponse(response, current);
        return;
      }
      const locallyAvailableTools = new Set(
        clientTools(serverTools, maxClientTools).map((tool) => tool.name),
      );
      let runnerConversation = current;
      const runner = new ChatRunner({
        api: apiClient,
        executeTool: async (call) => {
          const outcome = await runTool(
            {
              status: "tool_required",
              run_id: "ui-runner",
              calls: [call],
            },
            runnerConversation,
            toolLabel(call.name),
            { submit: false },
          );
          runnerConversation = outcome.conversation;
          return { request: outcome.request };
        },
      });
      const runnerResult = await runner.run({
        conversation_id: withUser.conversationId,
        message: providerMessage,
        history: current.history_eligible
          ? toChatHistory(beforeSend.messages, {
              requireProviderContent:
                current.processing_scope === "personal/scombz_student" ||
                current.processing_scope === "restricted/cast_career" ||
                current.processing_scope === "mixed",
            })
          : [],
        context_manifest: providerContextManifest,
        capabilities: capabilitiesSnapshot,
        locally_available_tools: locallyAvailableTools,
      });
      current = runnerConversation;
      await finishResponse(runnerResult.response, current);
    } catch (error) {
      const failureMessage = userFacingChatFailure(error);
      setRetryText(message);
      setProgress(null);
      await persist({
        ...current,
        updatedAt: new Date().toISOString(),
        messages: [
          ...current.messages,
          {
            id: `error-${Date.now()}`,
            role: "assistant",
            content: failureMessage,
          },
        ],
      });
    } finally {
      setBusy(false);
    }
  }

  async function selectConversation(id: string): Promise<void> {
    conversationInteractionRef.current = true;
    const selected = await loadConversation(id);
    if (selected) {
      setConversation(selected);
      setRetryText(null);
      setHistoryOpen(false);
    }
  }

  async function createConversation(): Promise<void> {
    conversationInteractionRef.current = true;
    // An explicit New Chat is a privacy boundary: do not keep the previous
    // conversation's alias mapping available for a later local restore.
    await pseudonymizerRef.current.clear(conversation.conversationId);
    // The background service worker owns the SCombZ course/material handles
    // and the CAST projection gateway. Invalidate those maps at the same
    // boundary; changing only the UI conversation id must not leave an old
    // handle usable by a later read.
    const clearResult = await sendExtensionMessage<{ ok: boolean }>({
      type: MESSAGE_TYPES.scombzClearConversation,
      conversation_id: conversation.conversationId,
    });
    if (!clearResult.ok) {
      throw new Error("会話の参照元を破棄できませんでした。");
    }
    // Syllabus refs are conversation-bound handles too.  Drop them eagerly
    // instead of merely relying on the conversation-id check in syllabus_read;
    // this keeps the local broker bounded and makes the New Chat boundary
    // explicit for audit and privacy reviews.
    syllabusRefsRef.current.clear();
    const next = newConversation();
    await persist(next);
    setRetryText(null);
    setHistoryOpen(false);
  }

  async function removeConversation(id: string): Promise<void> {
    await deleteConversation(id);
    const remaining = conversations.filter(
      (item) => item.conversationId !== id,
    );
    setConversations(remaining);
    if (conversation.conversationId === id) {
      await createConversation();
    }
  }

  async function clearConversations(): Promise<void> {
    await deleteAllConversations();
    await pseudonymizerRef.current.clearAll();
    await createConversation();
  }

  async function requestLibraryActionPreview(
    messageId: string,
    proposal: ActionProposal,
    inputs?: LibraryActionEditableInputs,
  ): Promise<void> {
    const operation = proposal.operation;
    if (!operation) return;
    const manifestRecord = conversation.contextManifest.library_records.find(
      (item) => item.resource_ref === operation.resource_ref,
    );
    const isReservation = operation.action_type === "reserve";
    setLibraryPreviewStates((states) => ({
      ...states,
      [messageId]: "previewing",
    }));
    setLibraryPreviewErrors((errors) => {
      const next = { ...errors };
      delete next[messageId];
      return next;
    });
    setChatProgress(
      "tool-running",
      isReservation ? "予約可否を確認中" : "公式ページを確認中",
      isReservation
        ? "公式OPACの予約導線と入力条件を確認しています。"
        : "対象資料の公式ページと現在の状態を確認しています。",
    );
    try {
      const result = await sendExtensionMessage<LibraryActionPreviewResponse>({
        type: MESSAGE_TYPES.libraryActionPreview,
        tool_call_id: `proposal-${messageId}`,
        operation,
        ...(inputs ? { inputs } : {}),
        ...(manifestRecord ? { record_url: manifestRecord.record.url } : {}),
      });
      if (result.status !== "ready") {
        setLibraryPreviewStates((states) => ({
          ...states,
          [messageId]: "unavailable",
        }));
        setLibraryPreviewErrors((errors) => ({
          ...errors,
          [messageId]:
            result.status === "permission_required"
              ? "公式ページの権限が必要です。"
              : libraryActionFailureDetail(result.reason_code),
        }));
        setChatProgress(
          "error",
          isReservation
            ? "予約可否を確認できませんでした"
            : "公式ページを確認できませんでした",
          "公式ページの内容を確認できないため、次の操作へ進んでいません。",
        );
        return;
      }
      setLibraryPreviews((previews) => ({ ...previews, [messageId]: result }));
      setLibraryPreviewInputs((values) => ({
        ...values,
        [messageId]: result.inputs,
      }));
      setLibraryPreviewStates((states) => ({
        ...states,
        [messageId]: "previewing",
      }));
      setChatProgress(
        "completed",
        isReservation
          ? "公式ページで予約内容を確認しました"
          : "公式ページを確認しました",
        isReservation
          ? "受取場所を含む内容を確認しました。最後のボタンで送信できます。"
          : "公式ページの対象資料と状態を確認しました。",
      );
    } catch {
      setLibraryPreviewStates((states) => ({
        ...states,
        [messageId]: "unavailable",
      }));
      setLibraryPreviewErrors((errors) => ({
        ...errors,
        [messageId]: "公式ページを再確認できませんでした。",
      }));
      setChatProgress(
        "error",
        "予約可否を確認できませんでした",
        "公式ページの内容を確認できないため、送信していません。",
      );
    }
  }

  function updateLibraryPreviewInput(
    messageId: string,
    key:
      | "pickup_campus"
      | "reason"
      | "receiver"
      | "payment"
      | "fee"
      | "page_range",
    value: string,
  ): void {
    const current = libraryPreviewInputs[messageId];
    if (!current) return;
    switch (current.action_type) {
      case "reserve":
      case "intercampus_transfer":
        if (key !== "pickup_campus") return;
        setLibraryPreviewInputs((values) => ({
          ...values,
          [messageId]: {
            action_type: current.action_type,
            values: { pickup_campus: value as "omiya" | "toyosu" },
          },
        }));
        return;
      case "purchase_request":
        if (key !== "reason") return;
        setLibraryPreviewInputs((values) => ({
          ...values,
          [messageId]: {
            action_type: current.action_type,
            values: { reason: value },
          },
        }));
        return;
      case "ill_loan":
        if (key !== "receiver" && key !== "payment" && key !== "fee") return;
        setLibraryPreviewInputs((values) => ({
          ...values,
          [messageId]: {
            action_type: "ill_loan",
            values: {
              ...current.values,
              [key]: value,
            },
          },
        }));
        return;
      case "ill_copy":
        if (
          key !== "receiver" &&
          key !== "payment" &&
          key !== "fee" &&
          key !== "page_range"
        )
          return;
        setLibraryPreviewInputs((values) => ({
          ...values,
          [messageId]: {
            action_type: "ill_copy",
            values: {
              ...current.values,
              [key]: value,
            },
          },
        }));
        return;
      case "visit_shelf":
      case "open_online":
      case "renew":
        return;
    }
  }

  async function submitLibraryAction(
    messageId: string,
    preview: Extract<LibraryActionPreviewResponse, { status: "ready" }>,
  ): Promise<void> {
    if (libraryPreviewStates[messageId] === "submitting") return;
    const inputs = libraryPreviewInputs[messageId] ?? preview.inputs;
    const isReservation = preview.action_type === "reserve";
    setLibraryPreviewStates((states) => ({
      ...states,
      [messageId]: "submitting",
    }));
    setChatProgress(
      "tool-running",
      isReservation ? "予約結果を確認中" : "公式ページを開いて確認中",
      isReservation
        ? "公式ページの完了画面と予約一覧を確認しています。"
        : "対象資料の公式ページを開き、内容を確認しています。",
    );
    try {
      const result = await sendExtensionMessage<LibraryActionSubmitResponse>({
        type: MESSAGE_TYPES.libraryActionSubmit,
        tool_call_id: `proposal-${messageId}`,
        preview_id: preview.preview_id,
        inputs,
        confirmation_label:
          preview.action_type === "visit_shelf" ||
          preview.action_type === "open_online"
            ? "公式ページを開く"
            : "この内容で送信",
      });
      if (result.status !== "verified") {
        setLibraryPreviewStates((states) => ({
          ...states,
          [messageId]: "unavailable",
        }));
        setLibraryPreviewErrors((errors) => ({
          ...errors,
          [messageId]: libraryActionFailureDetail(result.reason_code),
        }));
        setChatProgress(
          "error",
          isReservation
            ? "予約結果を確認できませんでした"
            : "公式ページを確認できませんでした",
          isReservation
            ? "完了を確認できないため、成功扱いにしていません。"
            : "公式ページを確認できないため、操作完了とは扱っていません。",
        );
        return;
      }
      setLibraryPreviewStates((states) => ({
        ...states,
        [messageId]: "verified",
      }));
      setChatProgress(
        "completed",
        isReservation ? "予約結果を確認しました" : "公式ページを確認しました",
        isReservation
          ? "公式ページと予約一覧で対象資料の予約を確認しました。"
          : "公式ページで対象資料を確認しました。",
      );
    } catch {
      setLibraryPreviewStates((states) => ({
        ...states,
        [messageId]: "unavailable",
      }));
      setLibraryPreviewErrors((errors) => ({
        ...errors,
        [messageId]: "公式ページの状態を再確認できませんでした。",
      }));
      setChatProgress(
        "error",
        isReservation
          ? "予約結果を確認できませんでした"
          : "公式ページを確認できませんでした",
        isReservation
          ? "公式ページの状態を確認できないため、成功扱いにしていません。"
          : "公式ページの状態を確認できないため、操作完了とは扱っていません。",
      );
    }
  }

  async function updateProposal(
    messageId: string,
    state: "approved" | "rejected",
  ): Promise<void> {
    const next = {
      ...conversation,
      updatedAt: new Date().toISOString(),
      messages: conversation.messages.map((message) =>
        message.id === messageId
          ? { ...message, proposalState: state }
          : message,
      ),
    };
    await persist(next);
    if (state === "approved") {
      const approved = conversation.messages.find(
        (message) => message.id === messageId,
      );
      if (approved?.proposal?.operation) {
        await requestLibraryActionPreview(messageId, approved.proposal);
      }
    }
  }

  return (
    <section className="chat-panel" aria-label="SIT ORBIT Chat">
      <header className="chat-toolbar">
        <div className="chat-brand">
          <strong>SIT ORBIT</strong>
          {pageContext?.kind === "scombz" ? (
            <span className="context-chip" title={pageContext.title}>
              ScombZ · {pageContext.title}
            </span>
          ) : null}
        </div>
        <div className="chat-toolbar-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="新規Chat"
            title="新規Chat"
            onClick={() => void createConversation()}
            disabled={busy || disabled}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7V4Z" />
            </svg>
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="履歴"
            title="履歴"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M12 3a9 9 0 1 1-8.5 6H1l3.5-4L8 9H5.6A7 7 0 1 0 12 5v3l4 2.4-1 1.7-5-3V3h2Z" />
            </svg>
          </button>
          {onOpenSettings ? (
            <button
              ref={settingsButtonRef}
              type="button"
              className="icon-button"
              aria-label="設定"
              title="設定"
              aria-expanded={settingsOpen}
              onClick={onOpenSettings}
              disabled={busy}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="m19.4 13 .1-1-.1-1 2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.7-1L15 3.5h-4l-.3 2.6a8 8 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.5-.1 1 .1 1-2 1.5 2 3.4 2.4-1a8 8 0 0 0 1.7 1l.3 2.6h4l.3-2.6a8 8 0 0 0 1.7-1l2.4 1 2-3.4-2-1.5ZM13 18.5h-2l-.2-2-.7-.3a6 6 0 0 1-1.4-.8l-.6-.5-1.8.8-1-1.8 1.6-1.2-.1-.8.1-.8-1.6-1.2 1-1.8 1.8.8.6-.5a6 6 0 0 1 1.4-.8l.7-.3.2-2h2l.2 2 .7.3a6 6 0 0 1 1.4.8l.6.5 1.8-.8 1 1.8-1.6 1.2.1.8-.1.8 1.6 1.2-1 1.8-1.8-.8-.6.5a6 6 0 0 1-1.4.8l-.7.3-.2 2ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 2a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z" />
              </svg>
            </button>
          ) : null}
          {mode === "sidepanel" && onOpenWorkspace ? (
            <button
              type="button"
              className="icon-button"
              aria-label="全画面で開く"
              title="全画面で開く"
              onClick={onOpenWorkspace}
              disabled={workspaceDisabled || busy}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M8 3H3v5h2V5h3V3Zm8 0v2h3v3h2V3h-5ZM5 16H3v5h5v-2H5v-3Zm16 0h-2v3h-3v2h5v-5Z" />
              </svg>
            </button>
          ) : null}
        </div>
      </header>
      {historyOpen ? (
        <aside className="chat-history" aria-label="Chat履歴">
          <div className="chat-history-heading">
            <strong>保存したChat</strong>
            <button
              type="button"
              className="text-button"
              onClick={() => void clearConversations()}
            >
              すべて削除
            </button>
          </div>
          {conversations.length === 0 ? (
            <p className="empty-state">履歴はありません。</p>
          ) : null}
          <ul>
            {conversations.map((item) => (
              <li key={item.conversationId}>
                <button
                  type="button"
                  onClick={() => void selectConversation(item.conversationId)}
                >
                  {item.title}
                </button>
                <button
                  type="button"
                  className="text-button"
                  aria-label={`${item.title}を削除`}
                  onClick={() => void removeConversation(item.conversationId)}
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        </aside>
      ) : null}

      <ContextManifestCard
        manifest={conversation.contextManifest}
        localReasoning={Object.values(localCastCareerDetails)
          .map((detail) => detail.reasoning_projection)
          .filter(
            (item): item is LocalCastReasoningProjection =>
              item !== null && item !== undefined,
          )}
      />
      <ResearchTrace messages={conversation.messages} />

      <div className="chat-timeline" aria-live="polite">
        {conversation.messages.length === 0 ? (
          <div className="chat-empty">
            <h3>今日は何を進めますか？</h3>
          </div>
        ) : null}
        {conversation.messages.map((message) => (
          <article
            className={`chat-message chat-message-${message.role}`}
            key={message.id}
            data-tool-state={message.toolState}
          >
            <span className="chat-message-role">
              {message.role === "user"
                ? "あなた"
                : message.role === "tool"
                  ? "Tool"
                  : "SIT ORBIT"}
            </span>
            {message.role === "tool" ? (
              <span
                className="chat-source-label"
                data-source={sourceLabel(message.toolName)}
              >
                {sourceLabel(message.toolName)}
              </span>
            ) : null}
            <div className="chat-message-content">
              <p>{message.content}</p>
              {message.role === "assistant" &&
              message.relatedBooks &&
              message.relatedBooks.length > 0 ? (
                <section
                  className="related-book-grid"
                  aria-label="関連書籍の候補"
                >
                  {message.relatedBooks.slice(0, 5).map((book) => (
                    <article
                      className="related-book-card"
                      key={book.candidate_ref}
                    >
                      <div className="related-book-card-heading">
                        <strong>{book.title}</strong>
                        <span
                          className="related-book-status"
                          data-status={
                            book.catalog_verification?.status ?? "unverified"
                          }
                        >
                          {book.catalog_verification?.status === "verified"
                            ? "SIT所蔵確認済み"
                            : book.catalog_verification?.status ===
                                "recheck_failed"
                              ? "SIT所蔵の再確認失敗"
                              : "SIT所蔵未確認"}
                        </span>
                      </div>
                      {book.authors && book.authors.length > 0 ? (
                        <small>{book.authors.join("、")}</small>
                      ) : null}
                      <p>{book.why_related}</p>
                      <div className="related-book-axes">
                        {(book.relation_axes ?? []).map((axis) => (
                          <span key={`${axis.source}-${axis.label}`}>
                            {axis.label}
                          </span>
                        ))}
                      </div>
                    </article>
                  ))}
                </section>
              ) : null}
              {message.role === "tool" && localMoodleDetails[message.id] ? (
                <details className="chat-local-detail">
                  <summary>確認した内容</summary>
                  <p>
                    コース:{" "}
                    {localMoodleDetails[message.id]?.courses.join("、") ||
                      "なし"}
                  </p>
                  <ul>
                    {localMoodleDetails[message.id]?.upcoming.map((item) => (
                      <li key={`${item.title}-${item.due_at ?? "none"}`}>
                        {item.course ? `${item.course}: ` : ""}
                        {item.title}
                        {item.due_at ? `（期限: ${item.due_at}）` : ""}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {message.role === "tool" && localMyLibraryDetails[message.id] ? (
                <details className="chat-local-detail">
                  <summary>確認した内容</summary>
                  <ul>
                    {localMyLibraryDetails[message.id]?.loans.map((loan) => (
                      <li key={`${loan.title}-${loan.due_date ?? "none"}`}>
                        貸出: {loan.title}
                        {loan.author ? ` / ${loan.author}` : ""}
                        {loan.due_date ? `（返却期限: ${loan.due_date}）` : ""}
                        {loan.overdue ? "（延滞）" : ""}
                      </li>
                    ))}
                    {localMyLibraryDetails[message.id]?.reservations.map(
                      (reservation) => (
                        <li
                          key={`${reservation.title}-${reservation.hold_until ?? "none"}`}
                        >
                          予約: {reservation.title}
                          {reservation.author ? ` / ${reservation.author}` : ""}
                          {reservation.status
                            ? `（${reservation.status}）`
                            : ""}
                          {reservation.hold_until
                            ? `（取置期限: ${reservation.hold_until}）`
                            : ""}
                        </li>
                      ),
                    )}
                    {(
                      [
                        [
                          "貸出履歴",
                          localMyLibraryDetails[message.id]?.loan_history ?? [],
                        ],
                        [
                          "購入依頼",
                          localMyLibraryDetails[message.id]
                            ?.purchase_requests ?? [],
                        ],
                        [
                          "ILL依頼",
                          localMyLibraryDetails[message.id]
                            ?.interlibrary_requests ?? [],
                        ],
                      ] as const
                    ).map(([label, items]) =>
                      items.length > 0 ? (
                        <li key={label}>
                          <strong>{label}</strong>
                          <ul>
                            {items.map((item) => (
                              <li
                                key={`${item.title}-${item.activity_date ?? item.due_date ?? "none"}`}
                              >
                                {item.title}
                                {item.author ? ` / ${item.author}` : ""}
                                {item.status ? `（${item.status}）` : ""}
                                {item.activity_date
                                  ? `（日付: ${item.activity_date}）`
                                  : ""}
                                {item.due_date
                                  ? `（期限: ${item.due_date}）`
                                  : ""}
                              </li>
                            ))}
                          </ul>
                        </li>
                      ) : null,
                    )}
                  </ul>
                </details>
              ) : null}
              {message.role === "tool" && localLibraryDetails[message.id] ? (
                <details
                  className="chat-local-detail"
                  open={
                    message.toolName === "library_item_read" &&
                    localLibraryPresentations[message.id] === "location"
                  }
                >
                  <summary>
                    {message.toolName === "library_item_read"
                      ? "確認した書誌・所蔵詳細"
                      : `確認した書誌候補（${localLibraryDetails[message.id]?.length ?? 0}件）`}
                  </summary>
                  {localLibraryDetails[message.id]?.length === 0 ? (
                    <p>該当する書誌はありません。</p>
                  ) : (
                    <ul>
                      {localLibraryDetails[message.id]?.map((item) => {
                        const holdings = item.holdings ?? [];
                        const floorMaps = uniqueLibraryFloorMaps(holdings);
                        return (
                          <li key={item.resource_ref}>
                            <strong>{item.title}</strong>
                            {(item.authors ?? []).length > 0 ? (
                              <span> / {(item.authors ?? []).join("、")}</span>
                            ) : null}
                            <ul className="library-holding-list">
                              {holdings.map((holding) => (
                                <li
                                  key={`${holding.campus}-${holding.location ?? "unknown"}-${holding.call_number ?? "unknown"}`}
                                >
                                  <strong>
                                    {libraryCampusLabel(holding.campus)}
                                  </strong>
                                  {holding.status === "available"
                                    ? " / 貸出可"
                                    : holding.status === "unavailable"
                                      ? " / 貸出中・利用不可"
                                      : " / 状態不明"}
                                  {holding.location
                                    ? ` / 配架場所: ${holding.location}`
                                    : " / 配架場所: 不明"}
                                  {holding.call_number
                                    ? ` / 請求記号: ${holding.call_number}`
                                    : " / 請求記号: 不明"}
                                  {holding.due_date
                                    ? ` / 返却予定: ${holding.due_date}`
                                    : ""}
                                  {holding.reservation_count !== null
                                    ? ` / 予約: ${holding.reservation_count}件`
                                    : ""}
                                </li>
                              ))}
                            </ul>
                            {message.toolName === "library_item_read" &&
                            localLibraryPresentations[message.id] ===
                              "location" &&
                            floorMaps.length > 0 ? (
                              <div className="library-floor-map-list">
                                {floorMaps.map((map) => (
                                  <LibraryFloorMapPreview
                                    key={`${map.page_url}#${map.image_url ?? "page"}`}
                                    map={map}
                                  />
                                ))}
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </details>
              ) : null}
              {message.role === "tool" && localCastDetails[message.id] ? (
                <details className="chat-local-detail">
                  <summary>確認した内容</summary>
                  <ul>
                    {localCastDetails[message.id]?.notices.map((notice) => (
                      <li
                        key={`${notice.title}-${notice.published_date ?? "none"}`}
                      >
                        {notice.published_date
                          ? `${notice.published_date}: `
                          : ""}
                        {notice.title}
                      </li>
                    ))}
                  </ul>
                  <p>
                    新着求人: {localCastDetails[message.id]?.new_job_count}件 /
                    インターン:
                    {localCastDetails[message.id]?.new_internship_count}件 /
                    説明会: {localCastDetails[message.id]?.new_event_count}件
                  </p>
                  <p>
                    相談予約:
                    {localCastDetails[message.id]?.has_counseling_reservation
                      ? "あり"
                      : "なし"}
                  </p>
                </details>
              ) : null}
              {message.role === "tool" && localCastAlumniDetails[message.id] ? (
                <details className="chat-local-detail">
                  <summary>確認した内容</summary>
                  <p>
                    参照ページ: {localCastAlumniDetails[message.id]?.page_path}
                  </p>
                  <ul>
                    {localCastAlumniDetails[message.id]?.profiles.map(
                      (profile) => (
                        <li key={profile.local_id}>
                          {profile.display_name ?? "氏名は端末内でマスク"}
                          {profile.answerable_topics.length > 0
                            ? ` / テーマ: ${profile.answerable_topics.join(", ")}`
                            : ""}
                          {profile.availability_frequency !== "unknown"
                            ? ` / 頻度: ${profile.availability_frequency}`
                            : ""}
                          {profile.meeting_modes.length > 0
                            ? ` / 形式: ${profile.meeting_modes.join(", ")}`
                            : ""}
                          {profile.shareable_insights.length > 0
                            ? ` / 知見: ${profile.shareable_insights.join(", ")}`
                            : ""}
                          {profile.contact_present
                            ? " / 連絡先あり（値は非表示）"
                            : ""}
                        </li>
                      ),
                    )}
                  </ul>
                  {(localCastAlumniDetails[message.id]?.discovered_links
                    .length ?? 0) > 0 ? (
                    <p>
                      CAST上の関連リンクを検出しました。リンク先を開いてから、再度確認できます。
                    </p>
                  ) : null}
                </details>
              ) : null}
              {message.role === "tool" && localCastSearchDetails[message.id] ? (
                <details className="chat-local-detail">
                  <summary>
                    CAST検索の端末内詳細（
                    {localCastSearchDetails[message.id]?.typed_items.length ??
                      0}
                    件）
                  </summary>
                  <p>
                    適用条件:{" "}
                    {localCastSearchDetails[message.id]?.applied_filters.kind} /{" "}
                    {localCastSearchDetails[message.id]?.coverage.mode} /
                    総件数: {localCastSearchDetails[message.id]?.total_count}件
                  </p>
                  <ul>
                    {localCastSearchDetails[message.id]?.typed_items.map(
                      (item) => (
                        <li key={item.item_ref}>
                          <strong>{item.title}</strong>
                          {item.company_name ? ` / ${item.company_name}` : ""}
                          {item.industry.length > 0
                            ? ` / ${item.industry.join("、")}`
                            : ""}
                          {item.deadline ? ` / 締切: ${item.deadline}` : ""}
                        </li>
                      ),
                    )}
                  </ul>
                  {localCastSearchDetails[message.id]?.next_cursor ? (
                    <p>続きの結果は、追加の検索が必要な場合だけ取得します。</p>
                  ) : null}
                </details>
              ) : null}
              {message.role === "tool" && localCastCareerDetails[message.id] ? (
                <details className="chat-local-detail" open>
                  <summary>CAST横断検索の端末内詳細</summary>
                  <p>
                    検索面:{" "}
                    {localCastCareerDetails[message.id]?.result.surfaces.join(
                      "、",
                    )}
                    <br />
                    条件: {localCastCareerDetails[message.id]?.result.query}
                    <br />
                    適用条件:{" "}
                    {formatCastCareerFilters(
                      localCastCareerDetails[message.id]?.filters ?? {},
                    ) || "指定なし"}
                  </p>
                  <ul>
                    {localCastCareerDetails[
                      message.id
                    ]?.result.surface_results.map((surface) => (
                      <li key={surface.surface}>
                        <strong>{surface.surface}</strong>：{surface.status} /{" "}
                        {surface.total_count ?? surface.returned_count}件
                        {surface.coverage
                          ? ` / ${surface.coverage.fetched_pages}ページ`
                          : ""}
                        {surface.reason_code
                          ? `（${surface.reason_code}）`
                          : ""}
                      </li>
                    ))}
                  </ul>
                  {localCastCareerDetails[message.id]?.result.status ===
                  "partial" ? (
                    <p>一部の検索面を取得できないため、結果はpartialです。</p>
                  ) : null}
                  {localCastCareerDetails[message.id]?.groups.length ? (
                    <ol>
                      {localCastCareerDetails[message.id]?.groups.map(
                        (group) => (
                          <li key={group.group_ref}>
                            <strong>{group.company_name ?? "関連情報"}</strong>
                            <span>{` / ${group.matched_surfaces.join("、")}`}</span>
                            {group.match_reasons.length > 0 ? (
                              <ul>
                                {group.match_reasons.map((reason) => (
                                  <li key={`${reason.label}-${reason.detail}`}>
                                    {reason.label}: {reason.detail}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                            {group.missing_requirements.length > 0 ? (
                              <p>
                                情報不足:{" "}
                                {group.missing_requirements.join("、")}
                              </p>
                            ) : null}
                            <ul>
                              {group.items.map(({ item }) => (
                                <li key={item.result_ref}>
                                  <strong>{item.title}</strong>
                                  {item.deadline
                                    ? ` / 締切: ${item.deadline}`
                                    : ""}
                                  {item.relation_flags.length > 0
                                    ? ` / ${item.relation_flags.join("、")}`
                                    : ""}
                                  {item.source_url ? (
                                    <a
                                      href={item.source_url}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      公式画面を開く
                                    </a>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </li>
                        ),
                      )}
                    </ol>
                  ) : (
                    <p>端末内で表示できる詳細項目はありません。</p>
                  )}
                  {localCastCareerDetails[message.id]?.reasoning_projection ? (
                    <section
                      className="chat-local-reasoning"
                      aria-label="CAST端末内推論"
                    >
                      <strong>端末内で仮名化して整理した内容</strong>
                      <p>
                        元の人物名は外部へ送らず、人物{" "}
                        {localCastCareerDetails[message.id]
                          ?.reasoning_projection?.replaced_person_count ?? 0}
                        件をこのChatの別名へ置換しました。
                      </p>
                      {localCastCareerDetails[message.id]?.reasoning_projection
                        ?.redacted_fields.length ? (
                        <p>
                          一般化・除外:{" "}
                          {localCastCareerDetails[
                            message.id
                          ]?.reasoning_projection?.redacted_fields.join("、")}
                        </p>
                      ) : null}
                      {localCastCareerDetails[message.id]?.reasoning_projection
                        ?.records.length ? (
                        <ul>
                          {localCastCareerDetails[
                            message.id
                          ]?.reasoning_projection?.records.map((record) => (
                            <li
                              key={
                                record.result_ref ??
                                `${record.surface ?? "record"}-${record.title ?? "item"}-${record.company_name ?? ""}`
                              }
                            >
                              {record.title ? (
                                <strong>{record.title}</strong>
                              ) : null}
                              {record.company_name
                                ? ` / ${record.company_name}`
                                : ""}
                              {record.person_alias
                                ? ` / ${record.person_alias}`
                                : ""}
                              {record.surface ? ` / ${record.surface}` : ""}
                              {record.graduation_year_range
                                ? ` / 卒業年度: ${record.graduation_year_range}`
                                : ""}
                              {record.academic_program
                                ? ` / 学問分野: ${record.academic_program}`
                                : ""}
                              {record.technical_domains.length > 0
                                ? ` / 技術: ${record.technical_domains.join("、")}`
                                : ""}
                              {record.occupations.length > 0
                                ? ` / 職種: ${record.occupations.join("、")}`
                                : ""}
                              {record.relation_flags.length > 0
                                ? ` / ${record.relation_flags.join("、")}`
                                : ""}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p>端末内で利用できる仮名化済み詳細はありません。</p>
                      )}
                    </section>
                  ) : null}
                </details>
              ) : null}
              {message.evidence && message.evidence.length > 0 ? (
                <details className="chat-citations">
                  <summary>参照 {message.evidence.length}件</summary>
                  <ul>
                    {message.evidence.map((item) => (
                      <li key={item.evidence_id}>
                        {item.source_type === "web" &&
                        /^https?:\/\//.test(item.locator) ? (
                          <a
                            href={item.locator}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {item.title}
                          </a>
                        ) : (
                          item.title
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {message.role === "assistant" &&
              retryText &&
              message.id === conversation.messages.at(-1)?.id ? (
                <button
                  type="button"
                  className="chat-retry-button"
                  onClick={() => {
                    setComposer(retryText);
                    composerRef.current?.focus();
                  }}
                >
                  再試行
                </button>
              ) : null}
              {message.proposal ? (
                <div
                  className="chat-proposal"
                  data-proposal-state={message.proposalState}
                >
                  <strong>確認が必要な提案</strong>
                  <p>{message.proposal.title}</p>
                  <small>
                    {message.proposal.reason}（
                    {message.proposal.duration_minutes}分）
                  </small>
                  {message.proposalState === "approved" &&
                  message.proposal.operation ? (
                    <div className="library-action-confirmation">
                      {message.proposal.operation.action_type === "reserve" &&
                      !libraryPreviews[message.id] &&
                      libraryPreviewStates[message.id] !== "previewing" ? (
                        <div
                          className="library-choice-popover"
                          role="dialog"
                          aria-label="予約の受取キャンパスを選択"
                        >
                          <strong>受取キャンパスを選択してください</strong>
                          <p>
                            公式フォームで選択した内容を確認してから送信します。
                          </p>
                          <div className="button-row">
                            {reserveCampusChoices(
                              conversation,
                              message.proposal.operation.resource_ref,
                            ).map((choice) => (
                              <button
                                key={choice.value}
                                type="button"
                                className="primary-button"
                                onClick={() =>
                                  void requestLibraryActionPreview(
                                    message.id,
                                    message.proposal as ActionProposal,
                                    {
                                      action_type: "reserve",
                                      values: { pickup_campus: choice.value },
                                    },
                                  )
                                }
                              >
                                {choice.label}
                              </button>
                            ))}
                          </div>
                          <label>
                            その他の希望（自由記述）
                            <input
                              maxLength={200}
                              value={libraryChoiceFreeform[message.id] ?? ""}
                              onChange={(event) =>
                                setLibraryChoiceFreeform((values) => ({
                                  ...values,
                                  [message.id]: event.target.value,
                                }))
                              }
                            />
                          </label>
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={
                              !(libraryChoiceFreeform[message.id] ?? "").trim()
                            }
                            onClick={() => {
                              const value =
                                libraryChoiceFreeform[message.id]?.trim();
                              if (!value) return;
                              setComposer(
                                `予約の受取場所について確認したいです：${value}`,
                              );
                              composerRef.current?.focus();
                            }}
                          >
                            Agentに希望を確認する
                          </button>
                        </div>
                      ) : null}
                      {libraryPreviewStates[message.id] === "previewing" &&
                      !libraryPreviews[message.id] ? (
                        <p className="state-message">
                          公式ページを再確認してプレビューを作成中…
                        </p>
                      ) : null}
                      {libraryPreviewErrors[message.id] ? (
                        <p className="state-message" role="alert">
                          送信不可: {libraryPreviewErrors[message.id]}
                        </p>
                      ) : null}
                      {libraryPreviews[message.id] ? (
                        <>
                          <strong>公式ページで確認した内容</strong>
                          {libraryPreviews[message.id]?.official.title ? (
                            <p>
                              資料:{" "}
                              {libraryPreviews[message.id]?.official.title}
                            </p>
                          ) : null}
                          {(libraryPreviews[message.id]?.official.holdings
                            .length ?? 0) > 0 ? (
                            <ul>
                              {libraryPreviews[
                                message.id
                              ]?.official.holdings.map((holding) => (
                                <li
                                  key={`${holding.campus}-${holding.location ?? ""}-${holding.call_number ?? ""}`}
                                >
                                  {holding.campus} ·{" "}
                                  {holding.location ?? "場所不明"} ·{" "}
                                  {holding.call_number ?? "請求記号不明"}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          {libraryPreviewInputs[message.id]?.action_type ===
                            "reserve" ||
                          libraryPreviewInputs[message.id]?.action_type ===
                            "intercampus_transfer" ? (
                            <label>
                              受取キャンパス
                              <select
                                value={editableInputValue(
                                  libraryPreviewInputs[message.id],
                                  "pickup_campus",
                                )}
                                onChange={(event) => {
                                  const current =
                                    libraryPreviewInputs[message.id];
                                  if (
                                    !current ||
                                    (current.action_type !== "reserve" &&
                                      current.action_type !==
                                        "intercampus_transfer")
                                  ) {
                                    return;
                                  }
                                  updateLibraryPreviewInput(
                                    message.id,
                                    "pickup_campus",
                                    event.target.value,
                                  );
                                }}
                              >
                                <option value="omiya">大宮</option>
                                <option value="toyosu">豊洲</option>
                              </select>
                            </label>
                          ) : null}
                          {libraryPreviewInputs[message.id]?.action_type ===
                          "purchase_request" ? (
                            <label>
                              購入理由
                              <textarea
                                maxLength={500}
                                value={editableInputValue(
                                  libraryPreviewInputs[message.id],
                                  "reason",
                                )}
                                onChange={(event) => {
                                  const current =
                                    libraryPreviewInputs[message.id];
                                  if (
                                    current?.action_type !== "purchase_request"
                                  )
                                    return;
                                  updateLibraryPreviewInput(
                                    message.id,
                                    "reason",
                                    event.target.value,
                                  );
                                }}
                              />
                            </label>
                          ) : null}
                          {libraryPreviewInputs[message.id]?.action_type ===
                            "ill_loan" ||
                          libraryPreviewInputs[message.id]?.action_type ===
                            "ill_copy" ? (
                            <>
                              <label>
                                受取人
                                <input
                                  maxLength={200}
                                  value={editableInputValue(
                                    libraryPreviewInputs[message.id],
                                    "receiver",
                                  )}
                                  onChange={(event) => {
                                    const current =
                                      libraryPreviewInputs[message.id];
                                    if (
                                      !current ||
                                      (current.action_type !== "ill_loan" &&
                                        current.action_type !== "ill_copy")
                                    )
                                      return;
                                    updateLibraryPreviewInput(
                                      message.id,
                                      "receiver",
                                      event.target.value,
                                    );
                                  }}
                                />
                              </label>
                              <label>
                                支払方法
                                <input
                                  maxLength={100}
                                  value={editableInputValue(
                                    libraryPreviewInputs[message.id],
                                    "payment",
                                  )}
                                  onChange={(event) => {
                                    const current =
                                      libraryPreviewInputs[message.id];
                                    if (
                                      !current ||
                                      (current.action_type !== "ill_loan" &&
                                        current.action_type !== "ill_copy")
                                    )
                                      return;
                                    updateLibraryPreviewInput(
                                      message.id,
                                      "payment",
                                      event.target.value,
                                    );
                                  }}
                                />
                              </label>
                              <label>
                                手数料（不明なら空欄）
                                <input
                                  maxLength={100}
                                  value={editableInputValue(
                                    libraryPreviewInputs[message.id],
                                    "fee",
                                  )}
                                  onChange={(event) => {
                                    const current =
                                      libraryPreviewInputs[message.id];
                                    if (
                                      !current ||
                                      (current.action_type !== "ill_loan" &&
                                        current.action_type !== "ill_copy")
                                    )
                                      return;
                                    updateLibraryPreviewInput(
                                      message.id,
                                      "fee",
                                      event.target.value,
                                    );
                                  }}
                                />
                              </label>
                              {libraryPreviewInputs[message.id]?.action_type ===
                              "ill_copy" ? (
                                <label>
                                  ページ範囲
                                  <input
                                    maxLength={100}
                                    value={editableInputValue(
                                      libraryPreviewInputs[message.id],
                                      "page_range",
                                    )}
                                    onChange={(event) => {
                                      const current =
                                        libraryPreviewInputs[message.id];
                                      if (current?.action_type !== "ill_copy")
                                        return;
                                      updateLibraryPreviewInput(
                                        message.id,
                                        "page_range",
                                        event.target.value,
                                      );
                                    }}
                                  />
                                </label>
                              ) : null}
                            </>
                          ) : null}
                          {libraryPreviewStates[message.id] === "verified" ? (
                            <p className="state-message success-message">
                              公式ページを開きました。
                            </p>
                          ) : (
                            <button
                              type="button"
                              className="primary-button"
                              disabled={
                                libraryPreviewStates[message.id] ===
                                "submitting"
                              }
                              onClick={() => {
                                const preview = libraryPreviews[message.id];
                                if (preview) {
                                  void submitLibraryAction(message.id, preview);
                                }
                              }}
                            >
                              {libraryPreviewStates[message.id] === "submitting"
                                ? "確認中…"
                                : libraryPreviews[message.id]?.action_type ===
                                      "visit_shelf" ||
                                    libraryPreviews[message.id]?.action_type ===
                                      "open_online"
                                  ? "公式ページを開く"
                                  : "この内容で送信"}
                            </button>
                          )}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  {message.proposalState === "pending" ? (
                    <div className="button-row">
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() =>
                          void updateProposal(message.id, "approved")
                        }
                      >
                        提案を承認
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() =>
                          void updateProposal(message.id, "rejected")
                        }
                      >
                        却下
                      </button>
                    </div>
                  ) : (
                    <span className="state-message">
                      {message.proposalState === "approved"
                        ? "承認済み"
                        : "却下済み"}
                    </span>
                  )}
                  {evidenceText(message.proposal).length > 0 ? (
                    <small>
                      根拠: {evidenceText(message.proposal).join("、")}
                    </small>
                  ) : null}
                </div>
              ) : null}
            </div>
          </article>
        ))}
        {progress ? (
          <div
            className={`chat-progress chat-progress-${progress.phase}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <span className="chat-progress-indicator" aria-hidden="true" />
            <strong>{progress.label}</strong>
            <span className="chat-progress-detail">{progress.detail}</span>
          </div>
        ) : null}
      </div>

      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={composerRef}
          aria-label="Chatメッセージ"
          placeholder="SIT ORBITに相談する"
          rows={1}
          value={composer}
          disabled={busy || disabled}
          onChange={(event) => {
            setComposer(event.target.value);
            const textarea = composerRef.current;
            if (textarea) {
              textarea.style.height = "auto";
              textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 44), 144)}px`;
            }
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (!busy && !disabled && composer.trim()) void send();
            }
          }}
        />
        <button
          type="submit"
          className="composer-send-button"
          aria-label={busy ? "処理中" : "送信"}
          title={busy ? "処理中" : "送信"}
          disabled={busy || disabled || !composer.trim()}
        >
          {busy ? (
            <span className="composer-spinner" aria-hidden="true" />
          ) : (
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="m4 12 15-8-4 16-4-6-7-2Zm4.7-.6 3.7 1.1 1.9 3.1 1.9-7.4-7.5 3.2Z" />
            </svg>
          )}
          <span className="sr-only">{busy ? "処理中" : "送信"}</span>
        </button>
      </form>
      <p className="chat-policy-note">
        一般Web検索を使う場合、公開情報の検索語はGrounding with
        Bingへ送信され、Azureの通常の地理・DPA境界外で処理されます。
      </p>
    </section>
  );
}
