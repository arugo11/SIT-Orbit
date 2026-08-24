import type { components } from "@sit-orbit/api-client";

export type ActionProposal = components["schemas"]["ActionProposal"];
export type OrbitEvent = components["schemas"]["OrbitEvent"];
export type ProposeActionRequest =
  components["schemas"]["ProposeActionRequest"];
export type VerifyActionRequest = components["schemas"]["VerifyActionRequest"];
export type AgentRunRequest = components["schemas"]["AgentRunRequest"];
export type AgentCapabilities = components["schemas"]["AgentCapabilities"];
export type AgentSessionRequest = components["schemas"]["AgentSessionRequest"];
export type AgentSessionResponse =
  components["schemas"]["AgentSessionResponse"];
export type AgentRunResponse =
  | components["schemas"]["AgentRunCompleted"]
  | components["schemas"]["AgentRunToolRequired"];
export type AgentToolResultRequest =
  components["schemas"]["AgentToolResultRequest"];
export type ChatRunRequest = components["schemas"]["ChatRunRequest"];
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

export const AZURE_DEMO_AGENT_API_BASE =
  "https://sit-orbit-demo-api.grayground-578aed68.japaneast.azurecontainerapps.io";
export const DEFAULT_AGENT_API_BASE = AZURE_DEMO_AGENT_API_BASE;

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
    isOneOf(value.agent_backend, ["fixture", "openai", "azure_openai"]) &&
    typeof value.my_library_personal_context === "boolean"
  );
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
      "reason_code",
    ]) &&
    value.schema_version === "v1" &&
    (value.status === "known" || value.status === "unavailable") &&
    typeof value.query === "string" &&
    (value.year === null || typeof value.year === "number") &&
    (value.faculty === null || typeof value.faculty === "string") &&
    Array.isArray(value.results) &&
    value.results.every(
      (item) =>
        isRecord(item) &&
        hasExactlyKeys(item, [
          "title",
          "course_code",
          "faculty",
          "url",
          "snippet",
        ]) &&
        typeof item.title === "string" &&
        (item.course_code === null || typeof item.course_code === "string") &&
        (item.faculty === null || typeof item.faculty === "string") &&
        typeof item.url === "string" &&
        item.url.startsWith("https://syllabus.sic.shibaura-it.ac.jp/") &&
        (item.snippet === null || typeof item.snippet === "string"),
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
    ]) &&
    isOneOf(value.action_type, libraryActionTypes) &&
    typeof value.available === "boolean" &&
    typeof value.reason_code === "string" &&
    /^[a-z][a-z0-9_]*$/u.test(value.reason_code) &&
    Array.isArray(value.required_inputs) &&
    value.required_inputs.length <= 8 &&
    value.required_inputs.every((item) => isOneOf(item, libraryActionInputs))
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
      "cumulative_gpa",
      "reason_code",
    ]) &&
    value.schema_version === "v1" &&
    (value.status === "known" || value.status === "unavailable") &&
    Array.isArray(value.grades) &&
    value.grades.length <= 200 &&
    value.grades.every(
      (item) =>
        isRecord(item) &&
        hasExactlyKeys(item, [
          "subject",
          "course_code",
          "credits",
          "grade",
          "year",
          "term",
          "term_slot",
          "repeated",
        ]) &&
        isNonEmptyString(item.subject) &&
        item.subject.length <= 200 &&
        (item.course_code === null ||
          (isNonEmptyString(item.course_code) &&
            item.course_code.length <= 20)) &&
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
        (item.year === null || isIntegerInRange(item.year, 2000, 2100)) &&
        (item.term === null || isIntegerInRange(item.term, 1, 3)) &&
        (item.term_slot === null || isIntegerInRange(item.term_slot, 1, 4)) &&
        typeof item.repeated === "boolean",
    ) &&
    (value.cumulative_gpa === null ||
      (typeof value.cumulative_gpa === "number" &&
        Number.isFinite(value.cumulative_gpa) &&
        value.cumulative_gpa >= 0 &&
        value.cumulative_gpa <= 4)) &&
    (value.report_label === null ||
      (typeof value.report_label === "string" &&
        value.report_label.length <= 100)) &&
    (value.reason_code === null ||
      (typeof value.reason_code === "string" &&
        value.reason_code.length <= 100))
  ) {
    const hasGradeData =
      value.report_label !== null ||
      value.grades.length > 0 ||
      value.cumulative_gpa !== null;
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
    !hasExactlyKeys(value, [
      "schema_version",
      "status",
      "data_classification",
      "profile_count",
      "topic_categories",
      "availability_frequencies",
      "meeting_modes",
      "shareable_insight_categories",
      "contact_present",
      "discovered_link_count",
      "reason_code",
    ]) ||
    value.schema_version !== "v1" ||
    value.data_classification !== "personal" ||
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
  if (value.status === "known") return true;
  return (
    value.profile_count === 0 &&
    value.topic_categories.length === 0 &&
    value.availability_frequencies.length === 0 &&
    value.meeting_modes.length === 0 &&
    value.shareable_insight_categories.length === 0 &&
    !value.contact_present &&
    value.discovered_link_count === 0
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

const chatToolNames = [
  "scombz_page_summary",
  "scombz_read",
  "google_calendar_availability",
  "syllabus_search",
  "browser_read_url",
  "sitrus_read",
  "moodle_read",
  "my_library_read",
  "cast_read",
  "cast_alumni_read",
  "library_catalog_search",
  "library_item_read",
  "library_catalog_browse",
  "library_discovery_search",
  "library_action_options",
] as const;

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

export function isChatRunResponse(value: unknown): value is ChatRunResponse {
  if (!isRecord(value) || typeof value.status !== "string") {
    return false;
  }
  if (value.status === "completed") {
    return (
      hasExactlyKeys(value, ["status", "message", "proposal"]) &&
      isChatEvidenceMessage(value.message) &&
      (value.proposal === null || isActionProposal(value.proposal))
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
    isOneOf(call.name, chatToolNames) &&
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
    return this.post("/v1/chat/runs", request, isChatRunResponse, "chat run");
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
