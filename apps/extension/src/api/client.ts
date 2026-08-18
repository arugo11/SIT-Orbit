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
export type CalendarAvailabilityResult =
  components["schemas"]["CalendarAvailabilityResult"];
export type ScombzPageSummaryResult =
  components["schemas"]["ScombzPageSummaryResult"];

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
