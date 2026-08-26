export const OPAC_DIAGNOSTIC_SCHEMA_VERSION = "v1" as const;
export const OPAC_DIAGNOSTIC_STORAGE_KEY = "orbit.opac-diagnostics.v1";
export const OPAC_DIAGNOSTIC_MAX_EVENTS = 200;

export type OpacDiagnosticPhase =
  | "search_started"
  | "entry_ready"
  | "search_submitted"
  | "navigation_ready"
  | "projection_started"
  | "search_completed"
  | "search_failed"
  | "action_options"
  | "entry_opened"
  | "form_verified"
  | "confirmation_received"
  | "submitted"
  | "readback_verified";

export type OpacDiagnosticOperationKind = "catalog_search" | "library_action";

export type OpacDiagnosticRouteKind =
  | "entry"
  | "search_results"
  | "single_record"
  | "login"
  | "error"
  | "unknown";

export interface OpacDiagnosticEvent {
  schema_version: typeof OPAC_DIAGNOSTIC_SCHEMA_VERSION;
  occurred_at: string;
  operation_id: string;
  operation_kind?: OpacDiagnosticOperationKind;
  query: string;
  phase: OpacDiagnosticPhase;
  route_kind: OpacDiagnosticRouteKind | null;
  result_count: number | null;
  duration_ms: number | null;
  status: "running" | "known" | "unavailable";
  reason_code: string | null;
}

export interface OpacDiagnosticSnapshot {
  schema_version: typeof OPAC_DIAGNOSTIC_SCHEMA_VERSION;
  events: OpacDiagnosticEvent[];
}

let diagnosticWriteQueue: Promise<void> = Promise.resolve();

export function normalizeOpacDiagnosticQuery(query: string): string {
  const withoutUrlSecrets = query.replace(/https?:\/\/[^\s]+/giu, (value) => {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}`;
    } catch {
      return "[URL]";
    }
  });
  return withoutUrlSecrets
    .replace(
      /\b(?:authorization|cookie|password|token)\s*[:=]\s*[^\s]+/giu,
      "[REDACTED]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
      "[REDACTED]",
    )
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
}

function isDiagnosticEvent(value: unknown): value is OpacDiagnosticEvent {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    item.schema_version === OPAC_DIAGNOSTIC_SCHEMA_VERSION &&
    typeof item.occurred_at === "string" &&
    typeof item.operation_id === "string" &&
    (item.operation_kind === undefined ||
      item.operation_kind === "catalog_search" ||
      item.operation_kind === "library_action") &&
    typeof item.query === "string" &&
    item.query.length <= 200 &&
    typeof item.phase === "string" &&
    (item.route_kind === null || typeof item.route_kind === "string") &&
    (item.result_count === null || typeof item.result_count === "number") &&
    (item.duration_ms === null || typeof item.duration_ms === "number") &&
    (item.status === "running" ||
      item.status === "known" ||
      item.status === "unavailable") &&
    (item.reason_code === null || typeof item.reason_code === "string")
  );
}

async function readStoredEvents(): Promise<OpacDiagnosticEvent[]> {
  const stored = await chrome.storage.session.get(OPAC_DIAGNOSTIC_STORAGE_KEY);
  const value = stored[OPAC_DIAGNOSTIC_STORAGE_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter(isDiagnosticEvent).slice(-OPAC_DIAGNOSTIC_MAX_EVENTS);
}

export async function readOpacDiagnosticEvents(): Promise<
  OpacDiagnosticEvent[]
> {
  await diagnosticWriteQueue;
  return readStoredEvents();
}

export async function appendOpacDiagnosticEvent(
  event: OpacDiagnosticEvent,
): Promise<void> {
  diagnosticWriteQueue = diagnosticWriteQueue.then(async () => {
    try {
      const events = await readStoredEvents();
      await chrome.storage.session.set({
        [OPAC_DIAGNOSTIC_STORAGE_KEY]: [...events, event].slice(
          -OPAC_DIAGNOSTIC_MAX_EVENTS,
        ),
      });
    } catch {
      // Diagnostics must never change the result of the OPAC operation.
    }
  });
  await diagnosticWriteQueue;
}

export async function clearOpacDiagnosticEvents(): Promise<void> {
  diagnosticWriteQueue = diagnosticWriteQueue.then(async () => {
    try {
      await chrome.storage.session.set({
        [OPAC_DIAGNOSTIC_STORAGE_KEY]: [],
      });
    } catch {
      // Clearing diagnostics is best-effort and isolated from OPAC operations.
    }
  });
  await diagnosticWriteQueue;
}
