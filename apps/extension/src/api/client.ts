import type { components } from "@sit-orbit/api-client";
import {
  CHAT_TOOL_NAMES,
  type RegisteredChatToolName,
} from "../chat/tool-registry";

export type ActionProposal = components["schemas"]["ActionProposal"];
export type OrbitEvent = components["schemas"]["OrbitEvent"];
export type ProposeActionRequest =
  components["schemas"]["ProposeActionRequest"];
export type VerifyActionRequest = components["schemas"]["VerifyActionRequest"];
export type AgentRunRequest = components["schemas"]["AgentRunRequest"];
export type AgentCapabilities = components["schemas"]["AgentCapabilities"];
export type ChatCapabilities = components["schemas"]["ChatCapabilities"];
export type AgentSessionRequest = components["schemas"]["AgentSessionRequest"];
export type AgentSessionResponse =
  components["schemas"]["AgentSessionResponse"];
export type AgentRunResponse =
  | components["schemas"]["AgentRunCompleted"]
  | components["schemas"]["AgentRunToolRequired"];
export type AgentToolResultRequest =
  components["schemas"]["AgentToolResultRequest"];
type GeneratedChatRunRequest = components["schemas"]["ChatRunRequest"];
/**
 * The API defaults to a synchronous run when execution_mode is omitted.
 * Keep that field optional at the client boundary so a newly built extension
 * can still talk to an older API image whose strict request model predates
 * background runs.  Callers that explicitly use background execution may
 * continue to provide the field.
 */
export type ChatRunRequest = Omit<GeneratedChatRunRequest, "execution_mode"> & {
  execution_mode?: GeneratedChatRunRequest["execution_mode"];
};
export type ChatRunResponse =
  | components["schemas"]["ChatRunCompleted"]
  | components["schemas"]["ChatRunToolRequired"];
export type ChatToolResultRequest =
  components["schemas"]["ChatToolResultRequest"];
export type ChatHistoryMessage = components["schemas"]["ChatHistoryMessage"];
export type ChatClientTool = components["schemas"]["ChatClientTool"];
export type ChatContextManifest = components["schemas"]["ChatContextManifest"];
export type ChatLibraryContextRecord =
  components["schemas"]["ChatLibraryContextRecord"];
export type RelatedBookCandidate =
  components["schemas"]["RelatedBookCandidate"];
export type EvidenceLink = components["schemas"]["EvidenceLink"];
export type CalendarAvailabilityResult =
  components["schemas"]["CalendarAvailabilityResult"];
export type ScombzPageSummaryResult =
  components["schemas"]["ScombzPageSummaryResult"];
export type ScombzReadResult = components["schemas"]["ScombzReadResult"];
export type ScombzCourseListResult =
  components["schemas"]["ScombzCourseListResult"];
export type ScombzPortalReadResult =
  components["schemas"]["ScombzPortalReadResult"];
export type ScombzCourseReadResult =
  components["schemas"]["ScombzCourseReadResult"];
export type ScombzMaterialSearchResult =
  components["schemas"]["ScombzMaterialSearchResult"];
export type SyllabusReadResult = components["schemas"]["SyllabusReadResult"];
export type SyllabusSearchResult =
  components["schemas"]["SyllabusSearchResult"];
export type BrowserReadResult = components["schemas"]["BrowserReadResult"];
export type SitrusGradeResult = components["schemas"]["SitrusGradeResult"];
export type MoodleReadResult = components["schemas"]["MoodleReadResult"];
export type MyLibraryItem = components["schemas"]["MyLibraryItem"];
export type MyLibraryScope =
  components["schemas"]["ScopedMyLibraryReadResult"]["scope"];
export type MyLibraryReadResult =
  | components["schemas"]["LegacyMyLibraryReadResult"]
  | components["schemas"]["ScopedMyLibraryReadResult"];
export type CastReadResult = components["schemas"]["CastReadResult"];
export type CastAlumniReadResult =
  components["schemas"]["CastAlumniReadResult"];
export type CastSearchResult = components["schemas"]["CastSearchResult"];
export type CastCareerSearchResult =
  components["schemas"]["CastCareerSearchResult"];
export type LibraryHoldingSummary =
  components["schemas"]["LibraryHoldingSummary"];
export type LibraryRelatedRecordRef =
  components["schemas"]["LibraryRelatedRecordRef"];
export type LibraryBibliographicRecord =
  components["schemas"]["LibraryBibliographicRecord"];
export type LibraryCatalogSearchResult =
  components["schemas"]["LibraryCatalogSearchResult"];
export type LibraryItemReadResult =
  components["schemas"]["LibraryItemReadResult"];
export type LibraryCatalogBrowseResult =
  components["schemas"]["LibraryCatalogBrowseResult"];
export type LibraryDiscoverySearchResult =
  components["schemas"]["LibraryDiscoverySearchResult"];
export type LibraryActionOptionsResult =
  components["schemas"]["LibraryActionOptionsResult"];
export type LibraryActionOption = components["schemas"]["LibraryActionOption"];

export const PRODUCTION_AGENT_API_BASE =
  "https://sit-orbit-demo-api.grayground-578aed68.japaneast.azurecontainerapps.io";
const compiledAgentApiBase =
  typeof __ORBIT_AGENT_API_BASE__ === "undefined"
    ? ""
    : __ORBIT_AGENT_API_BASE__.trim();
/**
 * Production uses the managed Azure endpoint.  A local endpoint is selected
 * only by an explicit build-time override so acceptance can exercise the
 * extension against a local Agent without starting an OAuth flow.
 */
export const DEFAULT_AGENT_API_BASE =
  compiledAgentApiBase || PRODUCTION_AGENT_API_BASE;
/** Backwards-compatible name for older tests and embedders. */
export const AZURE_DEMO_AGENT_API_BASE = DEFAULT_AGENT_API_BASE;
export const DEMO_FIXTURE_ENABLED =
  typeof __ORBIT_DEMO_FIXTURE__ !== "undefined" && __ORBIT_DEMO_FIXTURE__;

export function isLocalAgentApiBase(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

export type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class AgentApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "AgentApiError";
    this.status = status;
    this.body = body;
  }
}

export type AgentApiErrorReason =
  | "network"
  | "auth"
  | "context_invalid"
  | "history_invalid"
  | "tools_invalid"
  | "tool_result_invalid"
  | "agent_output_invalid"
  | "run_invalid"
  | "contract_invalid"
  | "upstream";

function errorReasonCode(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (typeof body.category === "string") return body.category;
  const detail = body.detail;
  if (typeof detail === "string") return detail;
  if (isRecord(detail) && typeof detail.reason_code === "string") {
    return detail.reason_code;
  }
  return null;
}

/** Classify an API failure without exposing response values to the UI. */
export function classifyAgentApiError(error: unknown): AgentApiErrorReason {
  if (!(error instanceof AgentApiError)) return "contract_invalid";
  if (error.status === 0) return "network";
  if (error.status === 401 || error.status === 403) return "auth";
  if (error.status >= 500) return "upstream";
  if (error.status !== 422) return "contract_invalid";
  const reason = errorReasonCode(error.body);
  switch (reason) {
    case "chat_context_invalid":
      return "context_invalid";
    case "chat_history_invalid":
      return "history_invalid";
    case "chat_tools_invalid":
      return "tools_invalid";
    case "tool_result_invalid":
      return "tool_result_invalid";
    case "agent_output_invalid":
      return "agent_output_invalid";
    case "chat_run_invalid":
      return "run_invalid";
    case "context_evidence_conflict":
      return "context_invalid";
    default:
      return "contract_invalid";
  }
}

export interface AgentApiClientOptions {
  baseUrl?: string;
  accessToken?: string;
  sessionProvider?: SessionProvider;
  fetcher?: Fetcher;
}

export type SessionProvider = (
  forceRefresh?: boolean,
) => Promise<string | null>;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Header receipts are opaque correlation values, not arbitrary response text.
 * Keep the compatibility reader permissive about the exact prefix, while
 * rejecting whitespace/control characters and unbounded values before they
 * can enter the local evidence map.
 */
function isReceiptIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 200 &&
    value.length > 0 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  );
}

function isIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isOneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isAgentCapabilities(value: unknown): value is AgentCapabilities {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, ["agent_backend", "my_library_personal_context"]) &&
    isOneOf(value.agent_backend, ["fixture", "azure_openai"]) &&
    typeof value.my_library_personal_context === "boolean"
  );
}

export type ChatToolName = RegisteredChatToolName;

export function isChatCapabilities(value: unknown): value is ChatCapabilities {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "agent_backend",
      "observability",
      "scombz_student_read_mode",
      "sitrus_personal_context_mode",
      "supported_client_tools",
      "max_client_tools",
    ]) ||
    value.schema_version !== "v1" ||
    !isOneOf(value.agent_backend, ["fixture", "azure_openai"]) ||
    !isOneOf(value.observability, ["off", "wandb"]) ||
    !isOneOf(value.scombz_student_read_mode, ["off", "fixture", "live"]) ||
    !isOneOf(value.sitrus_personal_context_mode, ["off", "fixture", "live"]) ||
    !Array.isArray(value.supported_client_tools) ||
    value.supported_client_tools.length > 32 ||
    new Set(value.supported_client_tools).size !==
      value.supported_client_tools.length ||
    !value.supported_client_tools.every((item) =>
      isOneOf(item, CHAT_TOOL_NAMES),
    ) ||
    !isIntegerInRange(value.max_client_tools, 1, 32) ||
    value.supported_client_tools.length > value.max_client_tools
  ) {
    return false;
  }
  const liveScombz =
    value.agent_backend === "azure_openai" &&
    value.observability === "off" &&
    value.scombz_student_read_mode === "live";
  const liveScombzTools = new Set([
    "scombz_course_list",
    "scombz_portal_read",
    "scombz_course_read",
    "scombz_material_search",
  ]);
  const liveSitrus =
    value.agent_backend === "azure_openai" &&
    value.observability === "off" &&
    value.sitrus_personal_context_mode === "live";
  const scombzValid =
    liveScombz ||
    !value.supported_client_tools.some((item) => liveScombzTools.has(item));
  const sitrusValid =
    liveSitrus || !value.supported_client_tools.includes("sitrus_read");
  return scombzValid && sitrusValid;
}

function isAgentSessionResponse(value: unknown): value is AgentSessionResponse {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, ["access_token", "expires_at"]) &&
    isNonEmptyString(value.access_token) &&
    isNonEmptyString(value.expires_at)
  );
}

const sourceTypes = [
  "syllabus",
  "assignment",
  "learning_history",
  "calendar",
  "scombz",
  "library",
  "career",
  "google_drive",
  "web",
] as const;
const dataClassifications = [
  "synthetic",
  "public",
  "personal",
  "restricted",
] as const;
const eventTypes = ["campus_entered", "action_completed"] as const;
const campuses = ["omiya", "toyosu", "other"] as const;
const externalActions = [
  "none",
  "calendar_draft",
  "checklist_update",
  "library_write",
] as const;

function isEvidenceLink(
  value: unknown,
): value is ActionProposal["evidence"][number] {
  return (
    isRecord(value) &&
    isNonEmptyString(value.evidence_id) &&
    isNonEmptyString(value.title) &&
    isOneOf(value.source_type, sourceTypes) &&
    isNonEmptyString(value.locator) &&
    isOneOf(value.data_classification, dataClassifications)
  );
}

export function isActionProposal(value: unknown): value is ActionProposal {
  if (
    isRecord(value) &&
    isNonEmptyString(value.action_id) &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.reason) &&
    isIntegerInRange(value.duration_minutes, 1, 180) &&
    Array.isArray(value.evidence) &&
    value.evidence.length > 0 &&
    value.evidence.every(isEvidenceLink) &&
    isOneOf(value.external_action, externalActions) &&
    typeof value.requires_confirmation === "boolean" &&
    isNonEmptyString(value.prompt_version)
  ) {
    if (value.operation === undefined || value.operation === null) return true;
    if (!isLibraryOperation(value.operation)) return false;
    const write = [
      "reserve",
      "intercampus_transfer",
      "renew",
      "purchase_request",
      "ill_loan",
      "ill_copy",
    ].includes(value.operation.action_type);
    if (!value.requires_confirmation) return false;
    if (write && value.external_action !== "library_write") return false;
    return !(!write && value.external_action === "library_write");
  }
  return false;
}

function isOpaqueLibraryResourceRef(value: unknown): value is string {
  return isLibraryResourceRef(value);
}

export type LibraryOperation = NonNullable<ActionProposal["operation"]>;

export function isLibraryOperation(value: unknown): value is LibraryOperation {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, ["action_type", "resource_ref"]) &&
    isOneOf(value.action_type, libraryActionTypes) &&
    isOpaqueLibraryResourceRef(value.resource_ref)
  );
}

function isCalendarAvailabilityInterval(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasExactlyKeys(value, ["start", "end"]) &&
    isNonEmptyString(value.start) &&
    isNonEmptyString(value.end)
  );
}

export function isCalendarAvailabilityResult(
  value: unknown,
): value is CalendarAvailabilityResult {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !hasExactlyKeys(value, [
      "schema_version",
      "status",
      "time_zone",
      "window_start",
      "window_end",
      "available_minutes",
      "busy_minutes",
      "free_intervals",
      "reason_code",
    ]) ||
    value.schema_version !== "v1" ||
    (value.status !== "known" &&
      value.status !== "unknown" &&
      value.status !== "reauth_required" &&
      value.status !== "unavailable") ||
    !isNonEmptyString(value.time_zone) ||
    !isNonEmptyString(value.window_start) ||
    !isNonEmptyString(value.window_end) ||
    !Array.isArray(value.free_intervals) ||
    !value.free_intervals.every(isCalendarAvailabilityInterval) ||
    (value.reason_code !== null && typeof value.reason_code !== "string")
  ) {
    return false;
  }
  const available = value.available_minutes;
  const busy = value.busy_minutes;
  if (
    (available !== null && !isIntegerInRange(available, 0, 10080)) ||
    (busy !== null && !isIntegerInRange(busy, 0, 10080))
  ) {
    return false;
  }
  return value.status === "known"
    ? available !== null && busy !== null
    : available === null && busy === null && value.free_intervals.length === 0;
}

export function isScombzPageSummaryResult(
  value: unknown,
): value is ScombzPageSummaryResult {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasExactlyKeys(value, [
      "route",
      "task_count",
      "announcement_count",
      "related_link_count",
      "has_current_course",
    ]) &&
    isOneOf(value.route, [
      "home",
      "tasks",
      "timetable",
      "announcements",
      "calendar",
      "course",
      "other",
    ]) &&
    isIntegerInRange(value.task_count, 0, 10000) &&
    isIntegerInRange(value.announcement_count, 0, 10000) &&
    isIntegerInRange(value.related_link_count, 0, 10000) &&
    typeof value.has_current_course === "boolean"
  );
}

export function isScombzReadResult(value: unknown): value is ScombzReadResult {
  if (!isRecord(value)) return false;
  return (
    hasExactlyKeys(value, [
      "schema_version",
      "status",
      "route",
      "tasks",
      "announcements",
      "timetable",
      "current_course",
      "restricted_present",
      "reason_code",
    ]) &&
    value.schema_version === "v1" &&
    (value.status === "known" || value.status === "unavailable") &&
    isOneOf(value.route, [
      "home",
      "tasks",
      "timetable",
      "announcements",
      "calendar",
      "course",
      "other",
    ]) &&
    Array.isArray(value.tasks) &&
    value.tasks.every(
      (item) =>
        isRecord(item) &&
        hasExactlyKeys(item, ["course", "title", "deadline"]) &&
        typeof item.course === "string" &&
        typeof item.title === "string" &&
        typeof item.deadline === "string",
    ) &&
    Array.isArray(value.announcements) &&
    value.announcements.every(
      (item) =>
        isRecord(item) &&
        hasExactlyKeys(item, ["title"]) &&
        typeof item.title === "string",
    ) &&
    Array.isArray(value.timetable) &&
    value.timetable.every(
      (item) =>
        isRecord(item) &&
        hasExactlyKeys(item, ["title", "starts_at", "ends_at", "status"]) &&
        typeof item.title === "string" &&
        (item.starts_at === null || typeof item.starts_at === "string") &&
        (item.ends_at === null || typeof item.ends_at === "string") &&
        isOneOf(item.status, ["class", "cancelled", "makeup", "unknown"]),
    ) &&
    (value.current_course === null ||
      typeof value.current_course === "string") &&
    typeof value.restricted_present === "boolean" &&
    (value.reason_code === null || typeof value.reason_code === "string")
  );
}

const scombzStudentStatuses = [
  "known",
  "partial",
  "reauth_required",
  "unavailable",
] as const;
const scombzCourseRefPattern =
  /^orbit-scombz:\/\/course\/[A-Za-z0-9_-]{16,128}$/u;
const scombzItemRefPattern = /^orbit-scombz:\/\/item\/[A-Za-z0-9_-]{16,128}$/u;
const scombzMaterialRefPattern =
  /^orbit-scombz:\/\/material\/[A-Za-z0-9_-]{16,128}$/u;
const syllabusRefPattern =
  /^orbit-syllabus:\/\/result\/[A-Za-z0-9_-]{16,128}$/u;

function isScombzCoverage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, [
      "scope",
      "requested",
      "attempted",
      "succeeded",
      "failed",
      "truncated",
      "next_cursor",
    ]) &&
    isNonEmptyString(value.scope) &&
    isIntegerInRange(value.requested, 0, 1000) &&
    isIntegerInRange(value.attempted, 0, 1000) &&
    isIntegerInRange(value.succeeded, 0, 1000) &&
    isIntegerInRange(value.failed, 0, 1000) &&
    typeof value.truncated === "boolean" &&
    (value.next_cursor === null || typeof value.next_cursor === "string") &&
    value.attempted >= value.succeeded + value.failed &&
    (value.truncated || value.next_cursor === null)
  );
}

function isScombzStudentEnvelope(value: unknown): value is JsonRecord {
  return (
    isRecord(value) &&
    value.schema_version === "v1" &&
    isOneOf(value.status, scombzStudentStatuses) &&
    isScombzCoverage(value.coverage) &&
    isNonEmptyString(value.observed_at) &&
    (value.reason_code === null || typeof value.reason_code === "string")
  );
}

function isScombzCitation(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.length <= 240);
}

function isScombzCourseSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, [
      "course_ref",
      "display_name",
      "academic_year",
      "term",
      "weekday",
      "period",
      "citation_uri",
    ]) &&
    typeof value.course_ref === "string" &&
    scombzCourseRefPattern.test(value.course_ref) &&
    isNonEmptyString(value.display_name) &&
    (value.academic_year === null ||
      isIntegerInRange(value.academic_year, 2000, 2100)) &&
    (value.term === null || typeof value.term === "string") &&
    (value.weekday === null || typeof value.weekday === "string") &&
    (value.period === null || typeof value.period === "string") &&
    isScombzCitation(value.citation_uri)
  );
}

function isScombzPortalItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, [
      "ref",
      "section",
      "title",
      "detail",
      "observed_at",
      "citation_uri",
    ]) &&
    typeof value.ref === "string" &&
    scombzItemRefPattern.test(value.ref) &&
    isNonEmptyString(value.section) &&
    isNonEmptyString(value.title) &&
    (value.detail === null || typeof value.detail === "string") &&
    isNonEmptyString(value.observed_at) &&
    isScombzCitation(value.citation_uri)
  );
}

function isScombzCourseReadItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, [
      "ref",
      "course_ref",
      "section",
      "title",
      "body",
      "due_at",
      "state",
      "has_pdf",
      "observed_at",
      "citation_uri",
    ]) &&
    typeof value.ref === "string" &&
    scombzItemRefPattern.test(value.ref) &&
    typeof value.course_ref === "string" &&
    scombzCourseRefPattern.test(value.course_ref) &&
    isNonEmptyString(value.section) &&
    isNonEmptyString(value.title) &&
    (value.body === null || typeof value.body === "string") &&
    (value.due_at === null || typeof value.due_at === "string") &&
    (value.state === null || typeof value.state === "string") &&
    typeof value.has_pdf === "boolean" &&
    isNonEmptyString(value.observed_at) &&
    isScombzCitation(value.citation_uri)
  );
}

export function isScombzCourseListResult(
  value: unknown,
): value is ScombzCourseListResult {
  return (
    isScombzStudentEnvelope(value) &&
    hasExactlyKeys(value, [
      "schema_version",
      "status",
      "courses",
      "coverage",
      "observed_at",
      "reason_code",
    ]) &&
    Array.isArray(value.courses) &&
    value.courses.length <= 50 &&
    (!["reauth_required", "unavailable"].includes(value.status as string) ||
      value.courses.length === 0) &&
    value.courses.every(isScombzCourseSummary)
  );
}

export function isScombzPortalReadResult(
  value: unknown,
): value is ScombzPortalReadResult {
  return (
    isScombzStudentEnvelope(value) &&
    hasExactlyKeys(value, [
      "schema_version",
      "status",
      "items",
      "coverage",
      "observed_at",
      "reason_code",
    ]) &&
    Array.isArray(value.items) &&
    value.items.length <= 200 &&
    (!["reauth_required", "unavailable"].includes(value.status as string) ||
      value.items.length === 0) &&
    value.items.every(isScombzPortalItem)
  );
}

export function isScombzCourseReadResult(
  value: unknown,
): value is ScombzCourseReadResult {
  return (
    isScombzStudentEnvelope(value) &&
    hasExactlyKeys(value, [
      "schema_version",
      "status",
      "items",
      "section_states",
      "coverage",
      "observed_at",
      "reason_code",
    ]) &&
    Array.isArray(value.items) &&
    value.items.length <= 250 &&
    value.items.every(isScombzCourseReadItem) &&
    isRecord(value.section_states) &&
    Object.keys(value.section_states).length <= 20 &&
    (!["reauth_required", "unavailable"].includes(value.status as string) ||
      (value.items.length === 0 &&
        Object.keys(value.section_states).length === 0)) &&
    Object.values(value.section_states).every((state) =>
      isOneOf(state, ["complete", "truncated", "failed", "not_requested"]),
    )
  );
}

function isScombzMaterialHit(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, [
      "material_ref",
      "course_ref",
      "material_title",
      "page",
      "quote",
      "observed_at",
      "citation_uri",
    ]) &&
    typeof value.material_ref === "string" &&
    scombzMaterialRefPattern.test(value.material_ref) &&
    typeof value.course_ref === "string" &&
    scombzCourseRefPattern.test(value.course_ref) &&
    isNonEmptyString(value.material_title) &&
    isIntegerInRange(value.page, 1, 10000) &&
    isNonEmptyString(value.quote) &&
    value.quote.length <= 1800 &&
    isNonEmptyString(value.observed_at) &&
    isScombzCitation(value.citation_uri)
  );
}

export function isScombzMaterialSearchResult(
  value: unknown,
): value is ScombzMaterialSearchResult {
  return (
    isScombzStudentEnvelope(value) &&
    hasExactlyKeys(value, [
      "schema_version",
      "status",
      "hits",
      "coverage",
      "observed_at",
      "reason_code",
    ]) &&
    Array.isArray(value.hits) &&
    value.hits.length <= 24 &&
    (!["reauth_required", "unavailable"].includes(value.status as string) ||
      value.hits.length === 0) &&
    value.hits.every(isScombzMaterialHit)
  );
}

export function isSyllabusReadResult(
  value: unknown,
): value is SyllabusReadResult {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "status",
      "syllabus_ref",
      "url",
      "course_code",
      "title",
      "instructors",
      "objectives",
      "weekly_plan",
      "evaluation",
      "textbooks",
      "prerequisites",
      "observed_at",
      "reason_code",
      "citation_uri",
    ]) ||
    value.schema_version !== "v1" ||
    (value.status !== "known" && value.status !== "unavailable") ||
    typeof value.syllabus_ref !== "string" ||
    !syllabusRefPattern.test(value.syllabus_ref) ||
    typeof value.url !== "string" ||
    !value.url.startsWith("https://syllabus.sic.shibaura-it.ac.jp/") ||
    !isNonEmptyString(value.observed_at) ||
    (value.reason_code !== null && typeof value.reason_code !== "string") ||
    !isScombzCitation(value.citation_uri) ||
    !Array.isArray(value.instructors) ||
    !value.instructors.every((item) => typeof item === "string") ||
    !Array.isArray(value.weekly_plan) ||
    !value.weekly_plan.every((item) => typeof item === "string") ||
    !Array.isArray(value.textbooks) ||
    !value.textbooks.every((item) => typeof item === "string")
  ) {
    return false;
  }
  return (
    ["course_code", "title", "objectives", "evaluation", "prerequisites"].every(
      (key) => {
        const item = value[key];
        return item === null || typeof item === "string";
      },
    ) &&
    (value.status === "known" ||
      (value.course_code === null &&
        value.title === null &&
        value.instructors.length === 0 &&
        value.objectives === null &&
        value.weekly_plan.length === 0 &&
        value.evaluation === null &&
        value.textbooks.length === 0 &&
        value.prerequisites === null))
  );
}

export function isSyllabusSearchResult(
  value: unknown,
): value is SyllabusSearchResult {
  if (!isRecord(value)) return false;
  return (
    hasExactlyKeys(value, [
      "schema_version",
      "status",
      "query",
      "year",
      "faculty",
      "results",
      "observed_at",
      "reason_code",
    ]) &&
    value.schema_version === "v1" &&
    (value.status === "known" || value.status === "unavailable") &&
    typeof value.query === "string" &&
    (value.year === null || typeof value.year === "number") &&
    (value.faculty === null || typeof value.faculty === "string") &&
    Array.isArray(value.results) &&
    typeof value.observed_at === "string" &&
    value.results.every(
      (item) =>
        isRecord(item) &&
        hasExactlyKeys(item, [
          "syllabus_ref",
          "title",
          "course_code",
          "faculty",
          "url",
          "snippet",
          "citation_uri",
        ]) &&
        typeof item.title === "string" &&
        typeof item.syllabus_ref === "string" &&
        /^orbit-syllabus:\/\/result\/[A-Za-z0-9_-]{16,128}$/u.test(
          item.syllabus_ref,
        ) &&
        (item.course_code === null || typeof item.course_code === "string") &&
        (item.faculty === null || typeof item.faculty === "string") &&
        typeof item.url === "string" &&
        item.url.startsWith("https://syllabus.sic.shibaura-it.ac.jp/") &&
        (item.snippet === null || typeof item.snippet === "string") &&
        isScombzCitation(item.citation_uri),
    )
  );
}

const libraryResourceRefPattern =
  /^orbit-library:\/\/record\/[A-Za-z0-9_-]{16,128}$/u;
const libraryRecordPath = "/opc/recordID/catalog.bib/";

function isLibraryResourceRef(value: unknown): value is string {
  return typeof value === "string" && libraryResourceRefPattern.test(value);
}

function isOfficialLibraryRecordUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.origin === "https://library.shibaura-it.ac.jp" &&
      url.pathname.startsWith(libraryRecordPath) &&
      url.pathname.slice(libraryRecordPath.length).length > 0 &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function isOfficialLibraryDiscoveryUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ((url.origin === "https://slib.shibaura-it.ac.jp" &&
        url.pathname.startsWith("/sublib/")) ||
        (url.origin === "https://library.shibaura-it.ac.jp" &&
          url.pathname.startsWith("/opc/recordID/catalog.bib/")))
    );
  } catch {
    return false;
  }
}

function isLibraryHoldingSummary(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !hasExactlyKeys(value, [
      "campus",
      "location",
      "call_number",
      "status",
      "due_date",
      "reservation_count",
    ]) ||
    !isOneOf(value.campus, ["toyosu", "omiya", "unknown"]) ||
    !isOneOf(value.status, ["available", "unavailable", "unknown"]) ||
    (value.location !== null && typeof value.location !== "string") ||
    (value.call_number !== null && typeof value.call_number !== "string") ||
    (value.due_date !== null && !isIsoDateOnly(value.due_date)) ||
    (value.reservation_count !== null &&
      !isIntegerInRange(value.reservation_count, 0, 10_000))
  ) {
    return false;
  }
  return !(
    value.status === "unknown" &&
    (value.due_date !== null || value.reservation_count !== null)
  );
}

function isLibraryRelatedRecordRef(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, ["resource_ref", "title", "relation"]) &&
    isLibraryResourceRef(value.resource_ref) &&
    isNonEmptyString(value.title) &&
    isOneOf(value.relation, ["related", "edition", "translation", "other"])
  );
}

function isLibraryBibliographicRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    hasExactlyKeys(value, [
      "resource_ref",
      "title",
      "authors",
      "subjects",
      "isbn",
      "publisher",
      "publication_year",
      "format",
      "campus",
      "url",
      "holdings",
      "related_records",
    ]) &&
    isLibraryResourceRef(value.resource_ref) &&
    isNonEmptyString(value.title) &&
    Array.isArray(value.authors) &&
    value.authors.length <= 20 &&
    value.authors.every(
      (item) => typeof item === "string" && item.length <= 200,
    ) &&
    Array.isArray(value.subjects) &&
    value.subjects.length <= 20 &&
    value.subjects.every(
      (item) => typeof item === "string" && item.length <= 200,
    ) &&
    (value.isbn === null ||
      (typeof value.isbn === "string" && value.isbn.length <= 32)) &&
    (value.publisher === null ||
      (typeof value.publisher === "string" && value.publisher.length <= 300)) &&
    (value.publication_year === null ||
      isIntegerInRange(value.publication_year, 1000, 2100)) &&
    isOneOf(value.format, ["book", "journal", "ebook", "unknown"]) &&
    isOneOf(value.campus, ["toyosu", "omiya", "any"]) &&
    isOfficialLibraryRecordUrl(value.url) &&
    Array.isArray(value.holdings) &&
    value.holdings.length >= 1 &&
    value.holdings.length <= 20 &&
    value.holdings.every(isLibraryHoldingSummary) &&
    Array.isArray(value.related_records) &&
    value.related_records.length <= 20 &&
    value.related_records.every(isLibraryRelatedRecordRef)
  );
}

function libraryResultEnvelope(value: unknown): value is JsonRecord {
  return (
    isRecord(value) &&
    value.schema_version === "v1" &&
    (value.status === "known" || value.status === "unavailable") &&
    (value.reason_code === null || typeof value.reason_code === "string")
  );
}

export function isLibraryCatalogSearchResult(
  value: unknown,
): value is LibraryCatalogSearchResult {
  if (
    !libraryResultEnvelope(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "status",
      "query",
      "items",
      "reason_code",
    ])
  ) {
    return false;
  }
  const items = Array.isArray(value.items) ? value.items : [];
  const valid =
    isNonEmptyString(value.query) &&
    value.query.length <= 200 &&
    items.length <= 10 &&
    items.every(isLibraryBibliographicRecord);
  return valid && (value.status === "known" || items.length === 0);
}

export function isLibraryItemReadResult(
  value: unknown,
): value is LibraryItemReadResult {
  if (
    !libraryResultEnvelope(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "status",
      "resource_ref",
      "item",
      "reason_code",
    ]) ||
    !isLibraryResourceRef(value.resource_ref) ||
    (value.item !== null && !isLibraryBibliographicRecord(value.item))
  ) {
    return false;
  }
  if (value.status === "known" && value.item === null) return false;
  if (value.status === "unavailable" && value.item !== null) return false;
  if (value.item === null || !isRecord(value.item)) return true;
  return value.item.resource_ref === value.resource_ref;
}

export function isLibraryCatalogBrowseResult(
  value: unknown,
): value is LibraryCatalogBrowseResult {
  if (
    !libraryResultEnvelope(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "status",
      "kind",
      "campus",
      "items",
      "reason_code",
    ]) ||
    !isOneOf(value.kind, ["new_books", "loan_ranking"]) ||
    !isOneOf(value.campus, ["toyosu", "omiya", "any"]) ||
    !Array.isArray(value.items) ||
    value.items.length > 10 ||
    !value.items.every(isLibraryBibliographicRecord)
  ) {
    return false;
  }
  return value.status === "known" || value.items.length === 0;
}

function isLibraryDiscoveryItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !hasExactlyKeys(value, [
      "title",
      "authors",
      "source_label",
      "url",
      "snippet",
      "resource_ref",
    ]) ||
    !isNonEmptyString(value.title) ||
    !Array.isArray(value.authors) ||
    value.authors.length > 20 ||
    !value.authors.every(
      (item) => typeof item === "string" && item.length <= 200,
    ) ||
    (value.source_label !== null && typeof value.source_label !== "string") ||
    (value.snippet !== null &&
      (typeof value.snippet !== "string" || value.snippet.length > 500)) ||
    (value.resource_ref !== null &&
      !isLibraryResourceRef(value.resource_ref)) ||
    !isOfficialLibraryDiscoveryUrl(value.url)
  ) {
    return false;
  }
  return true;
}

export function isLibraryDiscoverySearchResult(
  value: unknown,
): value is LibraryDiscoverySearchResult {
  if (
    !libraryResultEnvelope(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "status",
      "query",
      "items",
      "reason_code",
    ]) ||
    !isNonEmptyString(value.query) ||
    value.query.length > 200 ||
    !Array.isArray(value.items) ||
    value.items.length > 10 ||
    !value.items.every(isLibraryDiscoveryItem)
  ) {
    return false;
  }
  return value.status === "known" || value.items.length === 0;
}

const libraryActionTypes = [
  "visit_shelf",
  "open_online",
  "reserve",
  "intercampus_transfer",
  "renew",
  "purchase_request",
  "ill_loan",
  "ill_copy",
] as const;
const libraryActionInputs = [
  "pickup_campus",
  "reason",
  "receiver",
  "payment",
  "fee",
  "page_range",
] as const;

function isLibraryActionOption(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    hasExactlyKeys(value, [
      "action_type",
      "available",
      "reason_code",
      "required_inputs",
      "verification_level",
    ]) &&
    isOneOf(value.action_type, libraryActionTypes) &&
    typeof value.available === "boolean" &&
    typeof value.reason_code === "string" &&
    /^[a-z][a-z0-9_]*$/u.test(value.reason_code) &&
    isOneOf(value.verification_level, ["none", "entry_visible"]) &&
    Array.isArray(value.required_inputs) &&
    value.required_inputs.length <= 8 &&
    value.required_inputs.every((item) => isOneOf(item, libraryActionInputs)) &&
    (value.available
      ? value.reason_code === "available" &&
        value.verification_level === "entry_visible"
      : value.reason_code !== "available" &&
        value.verification_level === "none")
  );
}

export function isLibraryActionOptionsResult(
  value: unknown,
): value is LibraryActionOptionsResult {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "status",
      "resource_ref",
      "options",
      "data_classification",
      "reason_code",
    ]) ||
    value.schema_version !== "v1" ||
    !isLibraryResourceRef(value.resource_ref) ||
    !isOneOf(value.status, ["known", "reauth_required", "unavailable"]) ||
    !isOneOf(value.data_classification, ["public", "personal"]) ||
    (value.reason_code !== null && typeof value.reason_code !== "string") ||
    !Array.isArray(value.options) ||
    value.options.length > libraryActionTypes.length ||
    !value.options.every(isLibraryActionOption)
  ) {
    return false;
  }
  const actionTypes = value.options.map((item) => item.action_type);
  if (new Set(actionTypes).size !== actionTypes.length) return false;
  return value.status === "known"
    ? actionTypes.length === libraryActionTypes.length &&
        libraryActionTypes.every((item) => actionTypes.includes(item))
    : actionTypes.length === 0;
}

export function isBrowserReadResult(
  value: unknown,
): value is BrowserReadResult {
  if (!isRecord(value)) return false;
  return (
    hasExactlyKeys(value, [
      "schema_version",
      "status",
      "url",
      "title",
      "text",
      "links",
      "truncated",
      "data_classification",
      "reason_code",
    ]) &&
    value.schema_version === "v1" &&
    (value.status === "known" || value.status === "unavailable") &&
    typeof value.url === "string" &&
    typeof value.title === "string" &&
    typeof value.text === "string" &&
    Array.isArray(value.links) &&
    value.text.length <= 30_000 &&
    value.links.length <= 50 &&
    value.links.every(
      (item) =>
        isRecord(item) &&
        hasExactlyKeys(item, ["label", "url"]) &&
        typeof item.label === "string" &&
        typeof item.url === "string" &&
        (item.url.startsWith("https://") || item.url.startsWith("http://")),
    ) &&
    typeof value.truncated === "boolean" &&
    (value.data_classification === "public" ||
      value.data_classification === "personal") &&
    (value.reason_code === null || typeof value.reason_code === "string")
  );
}

export function isSitrusGradeResult(
  value: unknown,
): value is SitrusGradeResult {
  if (!isRecord(value)) return false;
  if (
    hasExactlyKeys(value, [
      "schema_version",
      "status",
      "report_label",
      "grades",
      "credit_summaries",
      "observed_at",
      "reason_code",
    ]) &&
    value.schema_version === "v1" &&
    (value.status === "known" ||
      value.status === "reauth_required" ||
      value.status === "unavailable") &&
    Array.isArray(value.grades) &&
    value.grades.length <= 200 &&
    value.grades.every(
      (item) =>
        isRecord(item) &&
        hasExactlyKeys(item, [
          "subject",
          "credits",
          "grade",
          "outcome",
          "year",
          "term",
        ]) &&
        isNonEmptyString(item.subject) &&
        item.subject.length <= 200 &&
        (item.credits === null ||
          (isIntegerInRange(item.credits, 0, 20) && item.credits >= 0)) &&
        isOneOf(item.grade, [
          "S",
          "A",
          "B",
          "C",
          "D",
          "F",
          "G",
          "N",
          "X",
          "#",
        ]) &&
        (item.outcome === null ||
          (typeof item.outcome === "string" && item.outcome.length <= 40)) &&
        (item.year === null || isIntegerInRange(item.year, 2000, 2100)) &&
        (item.term === null || isIntegerInRange(item.term, 1, 3)),
    ) &&
    Array.isArray(value.credit_summaries) &&
    value.credit_summaries.length <= 200 &&
    value.credit_summaries.every(
      (item) =>
        isRecord(item) &&
        hasExactlyKeys(item, [
          "category",
          "credit_type",
          "current_course_count",
          "current_credits",
          "cumulative_course_count",
          "cumulative_credits",
        ]) &&
        isNonEmptyString(item.category) &&
        item.category.length <= 100 &&
        (item.credit_type === null ||
          (typeof item.credit_type === "string" &&
            item.credit_type.length <= 40)) &&
        isIntegerInRange(item.current_course_count, 0, 10_000) &&
        isIntegerInRange(item.current_credits, 0, 10_000) &&
        isIntegerInRange(item.cumulative_course_count, 0, 10_000) &&
        isIntegerInRange(item.cumulative_credits, 0, 10_000),
    ) &&
    (value.report_label === null ||
      (typeof value.report_label === "string" &&
        value.report_label.length <= 100)) &&
    typeof value.observed_at === "string" &&
    value.observed_at.length <= 40 &&
    !Number.isNaN(Date.parse(value.observed_at)) &&
    (value.reason_code === null ||
      (typeof value.reason_code === "string" &&
        value.reason_code.length <= 100))
  ) {
    const hasGradeData =
      value.report_label !== null ||
      value.grades.length > 0 ||
      value.credit_summaries.length > 0;
    return value.status === "known" ? hasGradeData : !hasGradeData;
  }
  return false;
}

export function isMoodleReadResult(value: unknown): value is MoodleReadResult {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "status",
      "course_count",
      "upcoming_item_count",
      "overdue_count",
      "earliest_due_at",
      "unread_notification_count",
      "reason_code",
    ]) ||
    value.schema_version !== "v1" ||
    !isOneOf(value.status, ["known", "reauth_required", "unavailable"]) ||
    !isIntegerInRange(value.course_count, 0, 1000) ||
    !isIntegerInRange(value.upcoming_item_count, 0, 1000) ||
    !isIntegerInRange(value.overdue_count, 0, 1000) ||
    !isIntegerInRange(value.unread_notification_count, 0, 10000) ||
    (value.earliest_due_at !== null &&
      (typeof value.earliest_due_at !== "string" ||
        Number.isNaN(Date.parse(value.earliest_due_at)))) ||
    (value.reason_code !== null && typeof value.reason_code !== "string")
  ) {
    return false;
  }
  const hasData =
    value.course_count > 0 ||
    value.upcoming_item_count > 0 ||
    value.overdue_count > 0 ||
    value.earliest_due_at !== null ||
    value.unread_notification_count > 0;
  return value.status === "known" || !hasData;
}

function isIsoDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function isMyLibraryIsoDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

export function isMyLibraryReadResult(
  value: unknown,
): value is MyLibraryReadResult {
  if (!isRecord(value)) {
    return false;
  }
  const legacyKeys = [
    "schema_version",
    "status",
    "loan_count",
    "reservation_count",
    "overdue_count",
    "renewable_count",
    "earliest_due_date",
    "reason_code",
  ] as const;
  const scopedKeys = [
    ...legacyKeys.slice(0, 2),
    "scope",
    "items",
    "total_count",
    "next_offset",
    ...legacyKeys.slice(2),
  ] as const;
  const isLegacy = hasExactlyKeys(value, legacyKeys);
  const isScoped = hasExactlyKeys(value, scopedKeys);
  if (!isLegacy && !isScoped) return false;
  const counts = [
    value.loan_count,
    value.reservation_count,
    value.overdue_count,
    value.renewable_count,
  ];
  if (
    value.schema_version !== "v1" ||
    !isOneOf(value.status, ["known", "reauth_required", "unavailable"]) ||
    (isLegacy && !counts.every((count) => isIntegerInRange(count, 0, 1000))) ||
    (isScoped &&
      !counts.every(
        (count) => count === null || isIntegerInRange(count, 0, 1000),
      )) ||
    (typeof value.overdue_count === "number" &&
      typeof value.loan_count === "number" &&
      value.overdue_count > value.loan_count) ||
    (typeof value.renewable_count === "number" &&
      typeof value.loan_count === "number" &&
      value.renewable_count > value.loan_count) ||
    (value.earliest_due_date !== null &&
      !isMyLibraryIsoDateOnly(value.earliest_due_date)) ||
    (value.reason_code !== null && typeof value.reason_code !== "string")
  ) {
    return false;
  }
  if (isScoped) {
    if (
      !isOneOf(value.scope, [
        "current_loans",
        "reservations",
        "loan_history",
        "purchase_requests",
        "interlibrary_requests",
      ]) ||
      !isIntegerInRange(value.total_count, 0, 1000) ||
      (value.next_offset !== null &&
        !isIntegerInRange(value.next_offset, 0, 1000)) ||
      !Array.isArray(value.items) ||
      value.items.length > 20 ||
      !value.items.every(isMyLibraryItem) ||
      (value.status === "known" &&
        !value.items.every((item) =>
          isMyLibraryItemForScope(item, value.scope as MyLibraryScope),
        )) ||
      value.total_count < value.items.length ||
      (value.total_count <= value.items.length && value.next_offset !== null)
    ) {
      return false;
    }
    if (
      value.status !== "known" &&
      (value.items.length > 0 ||
        value.total_count > 0 ||
        value.next_offset !== null)
    ) {
      return false;
    }
    if (value.status === "known" && value.scope === "current_loans") {
      if (
        typeof value.loan_count !== "number" ||
        value.loan_count !== value.total_count ||
        typeof value.overdue_count !== "number" ||
        typeof value.renewable_count !== "number" ||
        value.reservation_count !== null
      ) {
        return false;
      }
    } else if (value.status === "known" && value.scope === "reservations") {
      if (
        value.loan_count !== null ||
        typeof value.reservation_count !== "number" ||
        value.reservation_count !== value.total_count ||
        value.overdue_count !== null ||
        value.renewable_count !== null ||
        value.earliest_due_date !== null
      ) {
        return false;
      }
    } else if (
      value.status === "known" &&
      (counts.some((count) => count !== null) ||
        value.earliest_due_date !== null)
    ) {
      return false;
    }
  }
  if (
    value.status !== "known" &&
    ((isLegacy && counts.some((count) => count !== 0)) ||
      (isScoped && counts.some((count) => count !== null)) ||
      value.earliest_due_date !== null)
  ) {
    return false;
  }
  return true;
}

function isMyLibraryItem(value: unknown): value is MyLibraryItem {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    "resource_ref",
    "title",
    "author",
    "status",
    "due_date",
    "renewable",
    "activity_date",
    "request_type",
  ]);
  if (
    !Object.keys(value).every((key) => allowed.has(key)) ||
    !isLibraryResourceRef(value.resource_ref) ||
    !isNonEmptyString(value.title) ||
    value.title.length > 300 ||
    (value.author !== undefined &&
      value.author !== null &&
      (typeof value.author !== "string" || value.author.length > 300)) ||
    (value.status !== undefined &&
      value.status !== null &&
      (typeof value.status !== "string" || value.status.length > 100)) ||
    (value.due_date !== undefined &&
      value.due_date !== null &&
      !isMyLibraryIsoDateOnly(value.due_date)) ||
    (value.renewable !== undefined &&
      value.renewable !== null &&
      typeof value.renewable !== "boolean") ||
    (value.activity_date !== undefined &&
      value.activity_date !== null &&
      !isMyLibraryIsoDateOnly(value.activity_date)) ||
    (value.request_type !== undefined &&
      value.request_type !== null &&
      (typeof value.request_type !== "string" ||
        value.request_type.length > 100))
  ) {
    return false;
  }
  return true;
}

function isMyLibraryItemForScope(
  value: MyLibraryItem,
  scope: MyLibraryScope,
): boolean {
  if (scope === "current_loans") return isMyLibraryIsoDateOnly(value.due_date);
  if (scope === "reservations") {
    return (
      isMyLibraryIsoDateOnly(value.due_date) && isNonEmptyString(value.status)
    );
  }
  if (scope === "loan_history") {
    return (
      isMyLibraryIsoDateOnly(value.activity_date) &&
      isNonEmptyString(value.status)
    );
  }
  return (
    isMyLibraryIsoDateOnly(value.activity_date) &&
    isNonEmptyString(value.status) &&
    isNonEmptyString(value.request_type)
  );
}

export function isCastReadResult(value: unknown): value is CastReadResult {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "status",
      "notice_count",
      "new_job_count",
      "new_internship_count",
      "new_event_count",
      "has_counseling_reservation",
      "nearest_notice_date",
      "reason_code",
    ]) ||
    value.schema_version !== "v1" ||
    !isOneOf(value.status, ["known", "reauth_required", "unavailable"]) ||
    !isIntegerInRange(value.notice_count, 0, 1000) ||
    !isIntegerInRange(value.new_job_count, 0, 100_000) ||
    !isIntegerInRange(value.new_internship_count, 0, 100_000) ||
    !isIntegerInRange(value.new_event_count, 0, 100_000) ||
    typeof value.has_counseling_reservation !== "boolean" ||
    (value.nearest_notice_date !== null &&
      !isIsoDateOnly(value.nearest_notice_date)) ||
    (value.reason_code !== null && typeof value.reason_code !== "string")
  ) {
    return false;
  }
  const hasData =
    value.notice_count > 0 ||
    value.new_job_count > 0 ||
    value.new_internship_count > 0 ||
    value.new_event_count > 0 ||
    value.has_counseling_reservation ||
    value.nearest_notice_date !== null;
  return value.status === "known" || !hasData;
}

export function isCastAlumniReadResult(
  value: unknown,
): value is CastAlumniReadResult {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) =>
      [
        "schema_version",
        "status",
        "data_classification",
        "profile_count",
        "profiles",
        "topic_categories",
        "availability_frequencies",
        "meeting_modes",
        "shareable_insight_categories",
        "contact_present",
        "discovered_link_count",
        "reason_code",
      ].includes(key),
    ) ||
    value.schema_version !== "v1" ||
    !isOneOf(value.data_classification, ["personal", "restricted"]) ||
    !isOneOf(value.status, ["known", "reauth_required", "unavailable"]) ||
    !isIntegerInRange(value.profile_count, 0, 64) ||
    !Array.isArray(value.topic_categories) ||
    value.topic_categories.length > 32 ||
    !value.topic_categories.every(
      (item) =>
        typeof item === "string" && item.length > 0 && item.length <= 100,
    ) ||
    !Array.isArray(value.availability_frequencies) ||
    value.availability_frequencies.length > 4 ||
    !value.availability_frequencies.every((item) =>
      isOneOf(item, ["weekly", "monthly", "occasional", "unknown"]),
    ) ||
    !Array.isArray(value.meeting_modes) ||
    value.meeting_modes.length > 3 ||
    !value.meeting_modes.every((item) =>
      isOneOf(item, ["online", "in_person", "unknown"]),
    ) ||
    !Array.isArray(value.shareable_insight_categories) ||
    value.shareable_insight_categories.length > 32 ||
    !value.shareable_insight_categories.every(
      (item) =>
        typeof item === "string" && item.length > 0 && item.length <= 100,
    ) ||
    typeof value.contact_present !== "boolean" ||
    !isIntegerInRange(value.discovered_link_count, 0, 32) ||
    (value.reason_code !== null && typeof value.reason_code !== "string")
  ) {
    return false;
  }
  if (
    value.data_classification === "restricted" &&
    value.profiles === undefined &&
    value.profile_count !== 0
  ) {
    return false;
  }
  if (value.profiles !== undefined) {
    if (
      !Array.isArray(value.profiles) ||
      value.profiles.length > 20 ||
      value.data_classification !== "restricted" ||
      value.contact_present ||
      value.profile_count !== value.profiles.length ||
      !value.profiles.every((profile) => {
        if (!isRecord(profile)) return false;
        if (
          Object.keys(profile).some(
            (key) =>
              ![
                "alias",
                "role",
                "company",
                "technical_domains",
                "job_types",
                "location_area",
                "graduation_year_bucket",
                "evidence_id",
              ].includes(key),
          )
        ) {
          return false;
        }
        const directIdentifier =
          /(?:@|https?:\/\/|orbit-[a-z0-9-]+:\/\/|(?:\+81|0)[-\d() ]{8,}|\b[A-Z]{1,5}[-_ ]?\d{5,}\b)/iu;
        const safeText = (item: unknown, max: number): boolean =>
          item === undefined ||
          item === null ||
          (typeof item === "string" &&
            item.length <= max &&
            !directIdentifier.test(item));
        return (
          typeof profile.alias === "string" &&
          /^\[\[ORBIT_PERSON_[A-Za-z0-9_-]{16,64}\]\]$/u.test(profile.alias) &&
          isOneOf(profile.role, ["alumni", "supporter", "unknown"]) &&
          safeText(profile.company, 160) &&
          Array.isArray(profile.technical_domains) &&
          profile.technical_domains.length <= 12 &&
          new Set(profile.technical_domains).size ===
            profile.technical_domains.length &&
          profile.technical_domains.every(
            (item) =>
              typeof item === "string" &&
              item.length > 0 &&
              item.length <= 120 &&
              !directIdentifier.test(item),
          ) &&
          Array.isArray(profile.job_types) &&
          profile.job_types.length <= 12 &&
          new Set(profile.job_types).size === profile.job_types.length &&
          profile.job_types.every(
            (item) =>
              typeof item === "string" &&
              item.length > 0 &&
              item.length <= 120 &&
              !directIdentifier.test(item),
          ) &&
          safeText(profile.location_area, 80) &&
          (profile.graduation_year_bucket === undefined ||
            profile.graduation_year_bucket === null ||
            (typeof profile.graduation_year_bucket === "string" &&
              /^(?:before-2010|20[0-9]{2}-20[0-9]{2})$/u.test(
                profile.graduation_year_bucket,
              ))) &&
          (profile.evidence_id === undefined ||
            profile.evidence_id === null ||
            (typeof profile.evidence_id === "string" &&
              /^[A-Za-z0-9_-]{3,200}$/u.test(profile.evidence_id)))
        );
      })
    ) {
      return false;
    }
  }
  if (value.status === "known") return true;
  return (
    value.profile_count === 0 &&
    value.topic_categories.length === 0 &&
    value.availability_frequencies.length === 0 &&
    value.meeting_modes.length === 0 &&
    value.shareable_insight_categories.length === 0 &&
    !value.contact_present &&
    value.discovered_link_count === 0 &&
    (value.profiles === undefined || value.profiles.length === 0)
  );
}

function isCastSearchAppliedFilters(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "kind",
      "filters",
      "sort",
      "graduation_years_defaulted",
    ]) ||
    !isOneOf(value.kind, [
      "job",
      "internship",
      "company_session",
      "company",
      "hiring_record",
    ]) ||
    typeof value.graduation_years_defaulted !== "boolean"
  ) {
    return false;
  }
  if (value.filters !== undefined && !isRecord(value.filters)) return false;
  if (value.sort !== null && value.sort !== undefined) {
    if (
      !isRecord(value.sort) ||
      !hasExactlyKeys(value.sort, ["key", "direction"]) ||
      !isOneOf(value.sort.key, [
        "company_name",
        "hiring_count",
        "graduation_year",
        "deadline",
      ]) ||
      !isOneOf(value.sort.direction, ["asc", "desc"])
    ) {
      return false;
    }
  }
  const filterKeys = new Set([
    "company_name",
    "new_only",
    "year",
    "graduation_years",
    "academic_programs",
    "industries",
    "relation",
    "occupations",
    "locations",
    "deadline_before",
    "include_closed",
    "application_method",
    "target_grades",
    "duration",
    "event_start",
    "event_end",
    "advisor",
    "faculty",
  ]);
  if (value.filters === undefined) return false;
  if (Object.keys(value.filters).some((key) => !filterKeys.has(key))) {
    return false;
  }
  const listKeys = new Set([
    "graduation_years",
    "academic_programs",
    "industries",
    "occupations",
    "locations",
    "target_grades",
    "duration",
  ]);
  const relationValues = new Set([
    "hiring_record",
    "obog",
    "career_supporter",
    "company_session",
    "internship",
    "entrance_exam",
  ]);
  for (const [key, item] of Object.entries(value.filters)) {
    if (listKeys.has(key)) {
      if (
        !Array.isArray(item) ||
        item.length === 0 ||
        item.length > 20 ||
        !item.every((entry) =>
          key === "graduation_years"
            ? isIntegerInRange(entry, 1995, 2100)
            : typeof entry === "string" &&
              entry.trim().length > 0 &&
              entry.length <= 200,
        )
      ) {
        return false;
      }
      continue;
    }
    if (key === "new_only" || key === "include_closed") {
      if (typeof item !== "boolean") return false;
      continue;
    }
    if (key === "year") {
      if (!isIntegerInRange(item, 1995, 2100)) return false;
      continue;
    }
    if (key === "relation") {
      if (typeof item !== "string" || !relationValues.has(item)) return false;
      continue;
    }
    if (key === "application_method") {
      if (item !== "free" && item !== "recommendation") return false;
      continue;
    }
    if (
      typeof item !== "string" ||
      item.trim().length === 0 ||
      item.length > 200
    ) {
      return false;
    }
  }
  return true;
}

export function isCastSearchResult(value: unknown): value is CastSearchResult {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "status",
      "applied_filters",
      "total_count",
      "returned_count",
      "coverage",
      "anonymous_aggregates",
      "evidence_ids",
      "reason_code",
    ]) ||
    value.schema_version !== "v1" ||
    !isOneOf(value.status, [
      "known",
      "reauth_required",
      "form_changed",
      "rate_limited",
      "unavailable",
    ]) ||
    !isIntegerInRange(value.total_count, 0, 100_000) ||
    !isIntegerInRange(value.returned_count, 0, 1_000) ||
    value.returned_count > value.total_count ||
    !Array.isArray(value.anonymous_aggregates) ||
    value.anonymous_aggregates.length > 100 ||
    !value.anonymous_aggregates.every((item) => {
      if (
        !isRecord(item) ||
        !hasExactlyKeys(item, ["dimension", "value", "count"]) ||
        !isOneOf(item.dimension, ["industry", "location", "graduation_year"]) ||
        !isNonEmptyString(item.value) ||
        !isIntegerInRange(item.count, 5, 100_000)
      ) {
        return false;
      }
      return true;
    }) ||
    !Array.isArray(value.evidence_ids) ||
    value.evidence_ids.length > 32 ||
    new Set(value.evidence_ids).size !== value.evidence_ids.length ||
    !value.evidence_ids.every(
      (item) =>
        typeof item === "string" &&
        /^cast-search-v1-[A-Za-z0-9_-]{16,200}$/u.test(item),
    ) ||
    (value.reason_code !== null && typeof value.reason_code !== "string") ||
    new Set(
      value.anonymous_aggregates.map((item) =>
        isRecord(item)
          ? `${String(item.dimension)}\u0000${String(item.value)}`
          : "",
      ),
    ).size !== value.anonymous_aggregates.length
  ) {
    return false;
  }
  if (value.status === "known") {
    if (!isCastSearchAppliedFilters(value.applied_filters)) return false;
    if (
      !isRecord(value.coverage) ||
      !hasExactlyKeys(value.coverage, [
        "mode",
        "page_size",
        "fetched_pages",
        "total_pages",
      ]) ||
      !isOneOf(value.coverage.mode, ["page", "complete", "partial"]) ||
      !isIntegerInRange(value.coverage.page_size, 1, 50) ||
      !isIntegerInRange(value.coverage.fetched_pages, 0, 100) ||
      (value.coverage.total_pages !== null &&
        !isIntegerInRange(value.coverage.total_pages, 0, 100))
    ) {
      return false;
    }
    return true;
  }
  return (
    value.applied_filters === null &&
    value.coverage === null &&
    value.total_count === 0 &&
    value.returned_count === 0 &&
    value.anonymous_aggregates.length === 0 &&
    value.evidence_ids.length === 0
  );
}

export function isCastCareerSearchResult(
  value: unknown,
): value is CastCareerSearchResult {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "status",
      "searched_surfaces",
      "surface_coverage",
      "total_count",
      "returned_count",
      "anonymous_aggregates",
      "evidence_ids",
      "reason_codes",
    ]) ||
    value.schema_version !== "v1" ||
    !isOneOf(value.status, [
      "known",
      "partial",
      "reauth_required",
      "form_changed",
      "rate_limited",
      "local_model_unavailable",
      "unavailable",
    ]) ||
    !Array.isArray(value.searched_surfaces) ||
    value.searched_surfaces.length < 1 ||
    value.searched_surfaces.length > 9 ||
    new Set(value.searched_surfaces).size !== value.searched_surfaces.length ||
    !value.searched_surfaces.every((item) =>
      isOneOf(item, [
        "job",
        "internship",
        "company_session",
        "company",
        "hiring_record",
        "selection_report",
        "recording",
        "career_event",
        "counseling",
      ]),
    ) ||
    !Array.isArray(value.surface_coverage) ||
    value.surface_coverage.length !== value.searched_surfaces.length ||
    !value.surface_coverage.every((item) => {
      if (
        !isRecord(item) ||
        !hasExactlyKeys(item, [
          "surface",
          "status",
          "total_count",
          "returned_count",
          "fetched_pages",
          "page_size",
          "reason_code",
        ]) ||
        !isOneOf(item.surface, value.searched_surfaces as string[]) ||
        !isOneOf(item.status, [
          "known",
          "partial",
          "reauth_required",
          "form_changed",
          "rate_limited",
          "local_model_unavailable",
          "unavailable",
        ]) ||
        (item.total_count !== null &&
          !isIntegerInRange(item.total_count, 0, 100_000)) ||
        !isIntegerInRange(item.returned_count, 0, 1_000) ||
        !isIntegerInRange(item.fetched_pages, 0, 100) ||
        !isIntegerInRange(item.page_size, 0, 50) ||
        (item.reason_code !== null && typeof item.reason_code !== "string")
      ) {
        return false;
      }
      return (
        item.total_count === null || item.returned_count <= item.total_count
      );
    }) ||
    new Set(
      value.surface_coverage.map((item) =>
        isRecord(item) ? String(item.surface) : "",
      ),
    ).size !== value.surface_coverage.length ||
    new Set(value.surface_coverage.map((item) => String(item.surface))).size !==
      value.searched_surfaces.length ||
    !isIntegerInRange(value.total_count, 0, 900_000) ||
    !isIntegerInRange(value.returned_count, 0, 9_000) ||
    value.returned_count > value.total_count ||
    !Array.isArray(value.anonymous_aggregates) ||
    value.anonymous_aggregates.length > 200 ||
    !value.anonymous_aggregates.every((item) => {
      return (
        isRecord(item) &&
        hasExactlyKeys(item, ["dimension", "value", "count"]) &&
        isOneOf(item.dimension, [
          "surface",
          "industry",
          "location",
          "graduation_year",
          "occupation",
          "technical_domain",
          "relation",
        ]) &&
        isNonEmptyString(item.value) &&
        isIntegerInRange(item.count, 5, 100_000)
      );
    }) ||
    !Array.isArray(value.evidence_ids) ||
    value.evidence_ids.length > 32 ||
    new Set(value.evidence_ids).size !== value.evidence_ids.length ||
    !value.evidence_ids.every(
      (item) =>
        typeof item === "string" &&
        /^cast-career-search-v1-[A-Za-z0-9_-]{16,200}$/u.test(item),
    ) ||
    !Array.isArray(value.reason_codes) ||
    value.reason_codes.length > 32 ||
    !value.reason_codes.every(
      (item) =>
        typeof item === "string" && item.length > 0 && item.length <= 100,
    )
  ) {
    return false;
  }
  if (value.status === "known") {
    return value.surface_coverage.every((item) => item.status === "known");
  }
  if (value.status === "partial") {
    return value.surface_coverage.some((item) => item.status === "known");
  }
  return (
    value.total_count === 0 &&
    value.returned_count === 0 &&
    value.anonymous_aggregates.length === 0
  );
}

export function isAgentRunResponse(value: unknown): value is AgentRunResponse {
  if (!isRecord(value) || typeof value.status !== "string") {
    return false;
  }
  if (value.status === "completed") {
    return (
      hasExactlyKeys(value, ["status", "proposal"]) &&
      isActionProposal(value.proposal)
    );
  }
  return (
    value.status === "tool_required" &&
    hasExactlyKeys(value, ["status", "run_id", "calls"]) &&
    isNonEmptyString(value.run_id) &&
    Array.isArray(value.calls) &&
    value.calls.length === 1 &&
    isRecord(value.calls[0]) &&
    hasExactlyKeys(value.calls[0], ["tool_call_id", "name", "version"]) &&
    isNonEmptyString(value.calls[0].tool_call_id) &&
    (value.calls[0].name === "google_calendar_availability" ||
      value.calls[0].name === "scombz_page_summary") &&
    value.calls[0].version === 1
  );
}

function isChatEvidenceMessage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const hasBaseKeys = hasExactlyKeys(value, [
    "message_id",
    "content_markdown",
    "evidence",
  ]);
  const hasRelatedKeys = hasExactlyKeys(value, [
    "message_id",
    "content_markdown",
    "evidence",
    "related_books",
  ]);
  const structurallyValid =
    (hasBaseKeys || hasRelatedKeys) &&
    isNonEmptyString(value.message_id) &&
    isNonEmptyString(value.content_markdown) &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isEvidenceLink) &&
    (value.related_books === undefined ||
      (Array.isArray(value.related_books) &&
        value.related_books.length <= 5 &&
        value.related_books.every(isRelatedBookCandidate)));
  if (!structurallyValid) return false;
  const messageEvidenceIds = new Set(
    (value.evidence as EvidenceLink[]).map((item) => item.evidence_id),
  );
  if (messageEvidenceIds.size !== (value.evidence as unknown[]).length) {
    return false;
  }
  const relatedBooks = Array.isArray(value.related_books)
    ? (value.related_books as RelatedBookCandidate[])
    : [];
  return relatedBooks.every((candidate) =>
    candidate.evidence_ids.every((evidenceId) =>
      messageEvidenceIds.has(evidenceId),
    ),
  );
}

function isRelatedBookCandidate(value: unknown): value is RelatedBookCandidate {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "candidate_ref",
      "title",
      "authors",
      "isbn",
      "publication_year",
      "relation_axes",
      "why_related",
      "evidence_ids",
      "catalog_verification",
      "observed_at",
    ]) ||
    !/^orbit-book:\/\/candidate\/[A-Za-z0-9_-]{16,128}$/u.test(
      String(value.candidate_ref),
    ) ||
    !isNonEmptyString(value.title) ||
    !Array.isArray(value.authors) ||
    !value.authors.every((item) => typeof item === "string") ||
    !Array.isArray(value.relation_axes) ||
    value.relation_axes.length === 0 ||
    !value.relation_axes.every(
      (axis) =>
        isRecord(axis) &&
        hasExactlyKeys(axis, ["label", "source"]) &&
        isNonEmptyString(axis.label) &&
        isOneOf(axis.source, ["explicit", "metadata", "inferred"] as const),
    ) ||
    !isNonEmptyString(value.why_related) ||
    !Array.isArray(value.evidence_ids) ||
    value.evidence_ids.length === 0 ||
    !value.evidence_ids.every(isNonEmptyString) ||
    !isNonEmptyString(value.observed_at) ||
    !isRecord(value.catalog_verification)
  ) {
    return false;
  }
  const verification = value.catalog_verification;
  if (
    !hasExactlyKeys(verification, ["status", "resource_ref", "observed_at"]) ||
    !isOneOf(verification.status, [
      "unverified",
      "verified",
      "recheck_failed",
    ] as const)
  ) {
    return false;
  }
  if (verification.status === "verified") {
    return (
      isLibraryResourceRef(verification.resource_ref) &&
      isNonEmptyString(verification.observed_at)
    );
  }
  return (
    verification.resource_ref === null &&
    (verification.status === "unverified" ||
      isNonEmptyString(verification.observed_at))
  );
}

export function isChatContextManifest(
  value: unknown,
): value is ChatContextManifest {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "evidence",
      "library_records",
      "related_books",
    ]) ||
    value.schema_version !== "v1" ||
    !Array.isArray(value.evidence) ||
    !value.evidence.every(isEvidenceLink) ||
    value.evidence.length > 100 ||
    !Array.isArray(value.library_records) ||
    value.library_records.length > 20 ||
    !Array.isArray(value.related_books) ||
    value.related_books.length > 20 ||
    !value.related_books.every(isRelatedBookCandidate)
  ) {
    return false;
  }
  const evidenceIds = new Set(
    (value.evidence as EvidenceLink[]).map((item) => item.evidence_id),
  );
  if (evidenceIds.size !== value.evidence.length) return false;
  const resourceRefs = new Set<string>();
  for (const item of value.library_records) {
    if (
      !isRecord(item) ||
      !hasExactlyKeys(item, [
        "resource_ref",
        "record",
        "evidence_ids",
        "observed_at",
      ]) ||
      !isOpaqueLibraryResourceRef(item.resource_ref) ||
      !isLibraryBibliographicRecord(item.record) ||
      !Array.isArray(item.evidence_ids) ||
      !item.evidence_ids.every(
        (evidenceId) =>
          typeof evidenceId === "string" && evidenceIds.has(evidenceId),
      ) ||
      !isNonEmptyString(item.observed_at)
    ) {
      return false;
    }
    const record = item.record as unknown as LibraryBibliographicRecord;
    if (record.resource_ref !== item.resource_ref) return false;
    resourceRefs.add(item.resource_ref);
  }
  return value.related_books.every((candidate) => {
    if (!candidate.evidence_ids.every((id) => evidenceIds.has(id))) {
      return false;
    }
    const verification = candidate.catalog_verification;
    if (!verification) return false;
    return (
      verification.status !== "verified" ||
      (typeof verification.resource_ref === "string" &&
        resourceRefs.has(verification.resource_ref))
    );
  });
}

export function isChatRunResponse(value: unknown): value is ChatRunResponse {
  if (!isRecord(value) || typeof value.status !== "string") {
    return false;
  }
  if (value.status === "completed") {
    return (
      (hasExactlyKeys(value, ["status", "message", "proposal"]) ||
        hasExactlyKeys(value, [
          "status",
          "message",
          "proposal",
          "context_manifest",
        ])) &&
      isChatEvidenceMessage(value.message) &&
      (value.proposal === null || isActionProposal(value.proposal)) &&
      (value.context_manifest === undefined ||
        value.context_manifest === null ||
        isChatContextManifest(value.context_manifest))
    );
  }
  if (value.status !== "tool_required") {
    return false;
  }
  if (
    !hasExactlyKeys(value, ["status", "run_id", "calls"]) ||
    !isNonEmptyString(value.run_id) ||
    !Array.isArray(value.calls) ||
    value.calls.length !== 1
  ) {
    return false;
  }
  const call = value.calls[0];
  return (
    isRecord(call) &&
    hasExactlyKeys(call, ["tool_call_id", "name", "version", "arguments"]) &&
    isNonEmptyString(call.tool_call_id) &&
    isOneOf(call.name, CHAT_TOOL_NAMES) &&
    call.version === 1 &&
    isRecord(call.arguments)
  );
}

export function isOrbitEvent(value: unknown): value is OrbitEvent {
  return (
    isRecord(value) &&
    (value.event_id === undefined || isNonEmptyString(value.event_id)) &&
    isOneOf(value.event_type, eventTypes) &&
    isNonEmptyString(value.scenario_id) &&
    (value.occurred_at === undefined || isNonEmptyString(value.occurred_at)) &&
    isOneOf(value.campus, campuses) &&
    isOneOf(value.data_classification, dataClassifications) &&
    (value.payload === undefined || isRecord(value.payload))
  );
}

function defaultFetcher(input: RequestInfo | URL, init?: RequestInit) {
  return globalThis.fetch(input, init);
}

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new TypeError("Agent API base URL must not be empty.");
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new TypeError("Agent API base URL must be an absolute HTTP(S) URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Agent API base URL must use HTTP or HTTPS.");
  }

  return normalized;
}

function responseIsOk(response: Response): boolean {
  if (response.ok) {
    return true;
  }

  return response.status >= 200 && response.status < 300;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export class AgentApiClient {
  private readonly baseUrl: string;
  private readonly accessToken: string | null;
  private readonly sessionProvider: SessionProvider | null;
  private readonly fetcher: Fetcher;

  constructor(options: AgentApiClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_AGENT_API_BASE);
    this.accessToken = options.accessToken?.trim() || null;
    this.sessionProvider = options.sessionProvider ?? null;
    this.fetcher = options.fetcher ?? defaultFetcher;
  }

  async createSession(
    request: AgentSessionRequest,
  ): Promise<AgentSessionResponse> {
    if (!request.authorization_code.trim())
      throw new TypeError("Google authorization code must not be empty.");
    if (!request.code_verifier.trim())
      throw new TypeError("Google PKCE verifier must not be empty.");
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/v1/auth/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch (error) {
      throw this.networkError(error);
    }
    const payload = await readJson(response);
    if (!responseIsOk(response)) {
      throw new AgentApiError(
        `Agent API returned HTTP ${response.status}.`,
        response.status,
        payload,
      );
    }
    if (!isAgentSessionResponse(payload)) {
      throw new AgentApiError(
        "Agent API returned an invalid session.",
        response.status,
        payload,
      );
    }
    return payload;
  }

  async health(): Promise<boolean> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/health`, {
        method: "GET",
        // `/health` is intentionally public. Sending the bearer token here
        // needlessly triggers a CORS preflight from extension pages.
        headers: {},
      });
    } catch (error) {
      throw this.networkError(error);
    }
    return responseIsOk(response);
  }

  async capabilities(): Promise<AgentCapabilities> {
    const requestInit = {
      method: "GET",
    } satisfies RequestInit;
    let response = await this.authorizedFetch("/v1/capabilities", requestInit);
    if (response.status === 401 && this.sessionProvider) {
      response = await this.authorizedFetch(
        "/v1/capabilities",
        requestInit,
        true,
      );
    }
    const payload = await readJson(response);
    if (!responseIsOk(response)) {
      throw new AgentApiError(
        `Agent API returned HTTP ${response.status}.`,
        response.status,
        payload,
      );
    }
    if (!isAgentCapabilities(payload)) {
      throw new AgentApiError(
        "Agent API returned invalid capabilities.",
        response.status,
        payload,
      );
    }
    return payload;
  }

  async chatCapabilities(): Promise<ChatCapabilities> {
    const requestInit = { method: "GET" } satisfies RequestInit;
    let response = await this.authorizedFetch(
      "/v1/chat/capabilities",
      requestInit,
    );
    if (response.status === 401 && this.sessionProvider) {
      response = await this.authorizedFetch(
        "/v1/chat/capabilities",
        requestInit,
        true,
      );
    }
    const payload = await readJson(response);
    if (!responseIsOk(response)) {
      throw new AgentApiError(
        `Agent API returned HTTP ${response.status}.`,
        response.status,
        payload,
      );
    }
    if (!isChatCapabilities(payload)) {
      throw new AgentApiError(
        "Agent API returned invalid Chat capabilities.",
        response.status,
        payload,
      );
    }
    return payload;
  }

  propose(request: ProposeActionRequest): Promise<ActionProposal> {
    return this.post(
      "/v1/actions/propose",
      request,
      isActionProposal,
      "proposal",
    );
  }

  startRun(request: AgentRunRequest): Promise<AgentRunResponse> {
    return this.post(
      "/v1/agent/runs",
      request,
      isAgentRunResponse,
      "agent run",
    );
  }

  submitToolResult(
    runId: string,
    request: AgentToolResultRequest,
  ): Promise<AgentRunResponse> {
    if (!runId.trim()) {
      throw new TypeError("Agent run ID must not be empty.");
    }
    return this.post(
      `/v1/agent/runs/${encodeURIComponent(runId)}/tool-results`,
      request,
      isAgentRunResponse,
      "agent run",
    );
  }

  startChat(request: ChatRunRequest): Promise<ChatRunResponse> {
    // The server defaults to a synchronous run.  Do not send the default
    // value to older strict API images that predate `execution_mode`; an
    // explicitly requested background run still carries the field.
    const { execution_mode, ...requestWithoutExecutionMode } = request;
    const body =
      execution_mode === "sync" ? requestWithoutExecutionMode : request;
    return this.post("/v1/chat/runs", body, isChatRunResponse, "chat run");
  }

  submitChatToolResult(
    runId: string,
    request: ChatToolResultRequest,
  ): Promise<ChatRunResponse> {
    if (!runId.trim()) {
      throw new TypeError("Chat run ID must not be empty.");
    }
    return this.post(
      `/v1/chat/runs/${encodeURIComponent(runId)}/tool-results`,
      request,
      isChatRunResponse,
      "chat run",
    );
  }

  /**
   * Submit one deferred result and retain the server's call-specific evidence
   * receipt.  The regular method remains unchanged for older deployments;
   * audit and multi-turn runners use this method when the headers are
   * available and otherwise receive a null receipt.
   */
  async submitChatToolResultWithReceipt(
    runId: string,
    request: ChatToolResultRequest,
  ): Promise<{ response: ChatRunResponse; evidence_id: string | null }> {
    if (!runId.trim()) {
      throw new TypeError("Chat run ID must not be empty.");
    }
    const requestInit = {
      method: "POST",
      body: JSON.stringify(request),
    } satisfies RequestInit;
    let response = await this.authorizedFetch(
      `/v1/chat/runs/${encodeURIComponent(runId)}/tool-results`,
      requestInit,
    );
    if (response.status === 401 && this.sessionProvider) {
      response = await this.authorizedFetch(
        `/v1/chat/runs/${encodeURIComponent(runId)}/tool-results`,
        requestInit,
        true,
      );
    }
    const payload = await readJson(response);
    if (!responseIsOk(response)) {
      throw new AgentApiError(
        `Agent API returned HTTP ${response.status}.`,
        response.status,
        payload,
      );
    }
    if (!isChatRunResponse(payload)) {
      throw new AgentApiError(
        "Agent API returned an invalid chat run.",
        response.status,
        payload,
      );
    }
    // Older test hosts and pre-receipt deployments may not expose a Headers
    // object at all.  Treat that as the documented compatibility case; once
    // either receipt header is present, however, the pair must be complete.
    const headerCallId = response.headers?.get("X-Orbit-Tool-Call-Id") ?? null;
    const headerEvidenceId =
      response.headers?.get("X-Orbit-Evidence-Id") ?? null;
    const hasCallReceipt = headerCallId !== null;
    const hasEvidenceReceipt = headerEvidenceId !== null;
    // A receipt is an atomic pair.  Accepting one header without the other
    // would make a later retry fall back to positional matching and could
    // attach evidence from a repeated read-only call to the wrong request.
    if (hasCallReceipt !== hasEvidenceReceipt) {
      throw new AgentApiError(
        "Agent API returned an incomplete tool receipt.",
        response.status,
        { category: "tool_result_invalid" },
      );
    }
    if (
      hasCallReceipt &&
      (!isReceiptIdentifier(headerCallId) ||
        !isReceiptIdentifier(headerEvidenceId) ||
        headerCallId !== request.tool_call_id)
    ) {
      throw new AgentApiError(
        "Agent API returned a mismatched tool receipt.",
        response.status,
        { category: "tool_result_invalid" },
      );
    }
    return {
      response: payload,
      evidence_id: hasEvidenceReceipt ? headerEvidenceId : null,
    };
  }

  async verify(
    actionId: string,
    request: VerifyActionRequest,
  ): Promise<OrbitEvent> {
    if (!actionId.trim()) {
      throw new TypeError("Action ID must not be empty.");
    }

    return this.post(
      `/v1/actions/${encodeURIComponent(actionId)}/verify`,
      request,
      isOrbitEvent,
      "completion event",
    );
  }

  private async post<T>(
    path: string,
    body: unknown,
    validate: (value: unknown) => value is T,
    responseName: string,
  ): Promise<T> {
    const requestInit = {
      method: "POST",
      body: JSON.stringify(body),
    } satisfies RequestInit;
    let response = await this.authorizedFetch(path, requestInit);
    if (response.status === 401 && this.sessionProvider) {
      response = await this.authorizedFetch(path, requestInit, true);
    }

    const payload = await readJson(response);
    if (!responseIsOk(response)) {
      throw new AgentApiError(
        `Agent API returned HTTP ${response.status}.`,
        response.status,
        payload,
      );
    }

    if (payload === undefined) {
      throw new AgentApiError(
        "Agent API returned an empty JSON response.",
        response.status,
        payload,
      );
    }

    if (!validate(payload)) {
      throw new AgentApiError(
        `Agent API returned an invalid ${responseName}.`,
        response.status,
        payload,
      );
    }

    return payload;
  }

  private async authorizedFetch(
    path: string,
    init: RequestInit,
    forceRefresh = false,
  ): Promise<Response> {
    try {
      return await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
          ...(await this.headers(forceRefresh)),
        },
      });
    } catch (error) {
      throw this.networkError(error);
    }
  }

  private async headers(forceRefresh = false): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    const token =
      this.accessToken ??
      (this.sessionProvider ? await this.sessionProvider(forceRefresh) : null);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private networkError(_error: unknown): AgentApiError {
    return new AgentApiError("Agent API request failed: network", 0, {
      category: "network",
    });
  }
}
