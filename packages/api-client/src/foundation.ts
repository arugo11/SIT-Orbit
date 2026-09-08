import type { components } from "./generated/schema";

export type ActionProposal = components["schemas"]["ActionProposal"];
export type OrbitEvent = components["schemas"]["OrbitEvent"];
export type EvidenceLink = components["schemas"]["EvidenceLink"];
export type VerifyActionRequest = components["schemas"]["VerifyActionRequest"];
export type FoundationCapabilities = {
  agent_backend: string;
};

/** The deterministic B1 Omiya event used by the local foundation demo. */
export const B1_OMIYA_EVENT = {
  event_id: "evt-b1-omiya-campus-entry",
  event_type: "campus_entered",
  scenario_id: "b1-omiya-calculus",
  occurred_at: "2026-08-12T14:24:00+09:00",
  campus: "omiya",
  data_classification: "synthetic",
  payload: {
    minutes_until_next_class: 31,
    available_minutes: 18,
  },
} satisfies OrbitEvent;

/** Original synthetic evidence for the B1 Omiya foundation scenario. */
export const B1_OMIYA_CONTEXT = [
  {
    evidence_id: "ev-assignment-calculus-01",
    title: "微分積分学の課題は明日締切",
    source_type: "assignment",
    locator: "demo://scombz/assignments/calculus-01",
    data_classification: "synthetic",
  },
  {
    evidence_id: "ev-attempt-chain-rule-02",
    title: "合成関数の微分で直近2回誤答",
    source_type: "learning_history",
    locator: "demo://orbit/attempts/chain-rule",
    data_classification: "synthetic",
  },
  {
    evidence_id: "ev-calendar-window-18m",
    title: "次の授業まで18分利用可能",
    source_type: "calendar",
    locator: "demo://calendar/free-window",
    data_classification: "synthetic",
  },
] satisfies EvidenceLink[];

export type FoundationErrorKind =
  | "configuration"
  | "network"
  | "http"
  | "response"
  | "backend";

/** A safe, user-facing error that never includes the response body. */
export class FoundationApiError extends Error {
  readonly kind: FoundationErrorKind;
  readonly status: number | null;

  constructor(
    message: string,
    kind: FoundationErrorKind,
    status: number | null = null,
  ) {
    super(message);
    this.name = "FoundationApiError";
    this.kind = kind;
    this.status = status;
  }
}

const campuses = ["omiya", "toyosu", "other"] as const;
const dataClassifications = [
  "synthetic",
  "public",
  "personal",
  "restricted",
] as const;
const eventTypes = ["campus_entered", "action_completed"] as const;
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
const externalActions = [
  "none",
  "calendar_draft",
  "checklist_update",
  "library_write",
] as const;
const backends = ["fixture", "azure_openai"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximum = 2000): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum
  );
}

function isOneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === "string" && values.includes(value as T);
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

function isRfc3339DateTime(value: unknown): value is string {
  return (
    isBoundedString(value, 80) &&
    /(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isEvidenceLink(value: unknown): value is EvidenceLink {
  if (!isRecord(value)) return false;
  return (
    isBoundedString(value.evidence_id, 200) &&
    isBoundedString(value.title, 500) &&
    isOneOf(value.source_type, sourceTypes) &&
    isBoundedString(value.locator, 500) &&
    isOneOf(value.data_classification, dataClassifications)
  );
}

type LibraryOperation = NonNullable<ActionProposal["operation"]>;

function isLibraryOperation(value: unknown): value is LibraryOperation {
  if (!isRecord(value)) return false;
  const actionTypes = [
    "visit_shelf",
    "open_online",
    "reserve",
    "intercampus_transfer",
    "renew",
    "purchase_request",
    "ill_loan",
    "ill_copy",
  ] as const;
  return (
    Object.keys(value).length === 2 &&
    isOneOf(value.action_type, actionTypes) &&
    isBoundedString(value.resource_ref, 160) &&
    /^orbit-library:\/\/record\/[A-Za-z0-9_-]{16,128}$/u.test(
      value.resource_ref,
    )
  );
}

/** Validate an ActionProposal before its text is rendered by a client. */
export function isActionProposal(value: unknown): value is ActionProposal {
  if (!isRecord(value)) return false;
  if (
    !isBoundedString(value.action_id, 200) ||
    !isBoundedString(value.title, 500) ||
    !isBoundedString(value.reason, 2000) ||
    !isIntegerInRange(value.duration_minutes, 1, 180) ||
    !Array.isArray(value.evidence) ||
    value.evidence.length === 0 ||
    value.evidence.length > 32 ||
    !value.evidence.every(isEvidenceLink) ||
    !isOneOf(value.external_action, externalActions) ||
    typeof value.requires_confirmation !== "boolean" ||
    !isBoundedString(value.prompt_version, 200)
  ) {
    return false;
  }
  if (value.external_action !== "none" && !value.requires_confirmation) {
    return false;
  }
  if (value.operation === undefined || value.operation === null) {
    return value.external_action !== "library_write";
  }
  if (!isLibraryOperation(value.operation) || !value.requires_confirmation) {
    return false;
  }
  const writeActions = new Set([
    "reserve",
    "intercampus_transfer",
    "renew",
    "purchase_request",
    "ill_loan",
    "ill_copy",
  ]);
  return writeActions.has(value.operation.action_type)
    ? value.external_action === "library_write"
    : value.external_action !== "library_write";
}

/** Validate a bounded OrbitEvent before it is shown as a completion result. */
export function isOrbitEvent(value: unknown): value is OrbitEvent {
  if (!isRecord(value)) return false;
  return (
    (value.event_id === undefined || isBoundedString(value.event_id, 200)) &&
    isOneOf(value.event_type, eventTypes) &&
    isBoundedString(value.scenario_id, 200) &&
    (value.occurred_at === undefined || isRfc3339DateTime(value.occurred_at)) &&
    isOneOf(value.campus, campuses) &&
    isOneOf(value.data_classification, dataClassifications) &&
    (value.payload === undefined ||
      (isRecord(value.payload) && Object.keys(value.payload).length <= 32))
  );
}

function isCompletionEventResponse(value: unknown): value is OrbitEvent {
  return (
    isOrbitEvent(value) &&
    isBoundedString(value.event_id, 200) &&
    isRfc3339DateTime(value.occurred_at) &&
    value.event_type === "action_completed"
  );
}

function isCapabilities(value: unknown): value is FoundationCapabilities {
  return isRecord(value) && isOneOf(value.agent_backend, backends);
}

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/u, "");
  try {
    const url = new URL(normalized);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new FoundationApiError(
      "Agent APIの接続先が不正です。",
      "configuration",
    );
  }
  return normalized;
}

export type FoundationClient = {
  capabilities: () => Promise<FoundationCapabilities>;
  propose: () => Promise<ActionProposal>;
  verify: (
    actionId: string,
    request: VerifyActionRequest,
  ) => Promise<OrbitEvent>;
};

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new FoundationApiError(
      "Agent APIの応答を読み取れませんでした。",
      "response",
      response.status,
    );
  }
}

export function createFoundationClient(
  baseUrl: string,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): FoundationClient {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  async function request<T>(
    path: string,
    init: RequestInit,
    validate: (value: unknown) => value is T,
    responseLabel: string,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`${normalizedBaseUrl}${path}`, init);
    } catch {
      throw new FoundationApiError(
        "Agent APIに接続できませんでした。",
        "network",
      );
    }
    if (!response.ok) {
      throw new FoundationApiError(
        `Agent APIが利用できません（HTTP ${response.status}）。`,
        "http",
        response.status,
      );
    }
    const payload = await readJson(response);
    if (!validate(payload)) {
      throw new FoundationApiError(
        `Agent APIの${responseLabel}が不正です。`,
        "response",
        response.status,
      );
    }
    return payload;
  }

  async function capabilities(): Promise<FoundationCapabilities> {
    return request(
      "/v1/capabilities",
      { method: "GET" },
      isCapabilities,
      "接続情報",
    );
  }

  async function propose(): Promise<ActionProposal> {
    const capability = await capabilities();
    if (capability.agent_backend !== "fixture") {
      throw new FoundationApiError(
        "fixtureバックエンドではないため、合成デモを開始できません。",
        "backend",
      );
    }
    // Each explicit proposal starts a new demo action. Let the API assign
    // its event ID; completion retries keep using the returned action ID.
    const { event_id: _templateEventId, ...event } = B1_OMIYA_EVENT;
    const nextProposal = await request(
      "/v1/actions/propose",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event,
          context: B1_OMIYA_CONTEXT,
        }),
      },
      isActionProposal,
      "提案応答",
    );
    if (
      nextProposal.operation !== undefined &&
      nextProposal.operation !== null
    ) {
      throw new FoundationApiError(
        "合成デモの提案に外部操作が含まれているため、表示を停止しました。",
        "response",
      );
    }
    if (
      nextProposal.evidence.some(
        (evidence) =>
          evidence.data_classification !== "synthetic" &&
          evidence.data_classification !== "public",
      )
    ) {
      throw new FoundationApiError(
        "合成デモの提案に許可されない根拠が含まれているため、表示を停止しました。",
        "response",
      );
    }
    return nextProposal;
  }

  async function verify(
    actionId: string,
    requestBody: VerifyActionRequest,
  ): Promise<OrbitEvent> {
    if (!isBoundedString(actionId, 200)) {
      throw new FoundationApiError("行動IDが不正です。", "configuration");
    }
    if (
      !isRecord(requestBody) ||
      !isBoundedString(requestBody.scenario_id, 200) ||
      !isOneOf(requestBody.campus, campuses) ||
      typeof requestBody.approved !== "boolean" ||
      typeof requestBody.completed !== "boolean" ||
      typeof requestBody.notes !== "string" ||
      requestBody.notes.length > 500
    ) {
      throw new FoundationApiError(
        "完了確認の入力が不正です。",
        "configuration",
      );
    }
    return request(
      `/v1/actions/${encodeURIComponent(actionId)}/verify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      },
      isCompletionEventResponse,
      "完了イベント応答",
    );
  }

  return { capabilities, propose, verify };
}
