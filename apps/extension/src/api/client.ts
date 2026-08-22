import type { components } from "@sit-orbit/api-client";

export type ActionProposal = components["schemas"]["ActionProposal"];
export type OrbitEvent = components["schemas"]["OrbitEvent"];
export type ProposeActionRequest =
  components["schemas"]["ProposeActionRequest"];
export type VerifyActionRequest = components["schemas"]["VerifyActionRequest"];
export type AgentRunRequest = components["schemas"]["AgentRunRequest"];
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

export const DEFAULT_AGENT_API_BASE = "http://localhost:8000";

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
  fetcher?: Fetcher;
}

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

const sourceTypes = [
  "syllabus",
  "assignment",
  "learning_history",
  "calendar",
  "scombz",
  "library",
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
const externalActions = ["none", "calendar_draft", "checklist_update"] as const;

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
  return (
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
] as const;

function isChatEvidenceMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, ["message_id", "content_markdown", "evidence"]) &&
    isNonEmptyString(value.message_id) &&
    isNonEmptyString(value.content_markdown) &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isEvidenceLink)
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
  private readonly fetcher: Fetcher;

  constructor(options: AgentApiClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_AGENT_API_BASE);
    this.fetcher = options.fetcher ?? defaultFetcher;
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
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The request failed.";
      throw new AgentApiError(`Agent API request failed: ${message}`, 0, error);
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
}
