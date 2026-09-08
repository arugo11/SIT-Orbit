import { type CareerVault, serializeCareerVaultMutation } from "./career-vault";

export type CastChangeKind = "added" | "removed" | "changed";
export type CastChangeCategory =
  | "deadline"
  | "internship"
  | "history_report"
  | "support_resource"
  | "opportunity"
  | "other";

export interface CastLocalChange {
  path: string;
  kind: CastChangeKind;
  category: CastChangeCategory;
  summary: string;
  previous_value?: unknown;
  current_value?: unknown;
}

export interface CastChangeSet {
  schema_version: "v1";
  status: "baseline" | "known";
  captured_at: string;
  previous_captured_at: string | null;
  changes: CastLocalChange[];
}

/** The only change data shape that may be used by an external Agent. */
export interface CastChangeAgentProjection {
  schema_version: "v1";
  status: "baseline" | "known";
  total_change_count: number;
  added_count: number;
  removed_count: number;
  changed_count: number;
  deadline_change_count: number;
  internship_change_count: number;
  history_report_change_count: number;
  support_resource_change_count: number;
  opportunity_change_count: number;
}

export type CastChangeRecordKind =
  | "job"
  | "internship"
  | "company_session"
  | "company"
  | "hiring_record"
  | "selection_report"
  | "notice"
  | "recording"
  | "career_event"
  | "counseling"
  | "supporter"
  | "guide";

export type CastChangeRecordStatus =
  | "open"
  | "closing_soon"
  | "closed"
  | "known"
  | "unknown"
  | "available";

/**
 * A structural row retained by the local change feed.  Text copied from a
 * CAST page is deliberately absent: only an opaque reference, enums, dates,
 * and bounded counts can be persisted.
 */
export interface CastChangeSnapshotRecord {
  reference: string;
  category: CastChangeCategory;
  kind?: CastChangeRecordKind;
  status?: CastChangeRecordStatus;
  deadline?: string | null;
  published_date?: string | null;
  count?: number;
}

export interface CastChangeSnapshotCounts {
  notices?: number;
  opportunities?: number;
  hiring_records?: number;
  selection_reports?: number;
  support_resources?: number;
  people?: number;
}

/** The only snapshot shape accepted by CastChangeFeed storage. */
export interface CastChangeSnapshot {
  schema_version: "v1";
  records: CastChangeSnapshotRecord[];
  counts: CastChangeSnapshotCounts;
}

export interface CastStoredSnapshot {
  schema_version: "v1";
  captured_at: string;
  snapshot: CastChangeSnapshot;
}

const RECORD_PREFIX = "cast-change-snapshot:v1:";
const MAX_SNAPSHOT_BYTES = 2_000_000;
const MAX_CHANGES = 500;
const MAX_RECORDS = 500;
const MAX_COUNT = 100_000;
const CHANGE_FEED_MUTATION_KEY = "cast-change-feed";
const CHANGE_SNAPSHOT_KEYS = ["schema_version", "records", "counts"] as const;
const CHANGE_RECORD_KEYS = [
  "reference",
  "category",
  "kind",
  "status",
  "deadline",
  "published_date",
  "count",
] as const;
const CHANGE_COUNT_KEYS = [
  "notices",
  "opportunities",
  "hiring_records",
  "selection_reports",
  "support_resources",
  "people",
] as const;
const CHANGE_REFERENCE_PATTERN =
  /^(?:job|internship|company|company-session|company_session|employment|exam|hiring|hiring-record|selection-report|notice|opportunity|resource|support-resource|recording|career-event|counseling):[a-z0-9_-]{1,120}$/u;
const CHANGE_DATE_PATTERN = /^20\d{2}-\d{2}-\d{2}$/u;
const CHANGE_RECORD_KINDS: readonly CastChangeRecordKind[] = [
  "job",
  "internship",
  "company_session",
  "company",
  "hiring_record",
  "selection_report",
  "notice",
  "recording",
  "career_event",
  "counseling",
  "supporter",
  "guide",
];
const CHANGE_RECORD_STATUSES: readonly CastChangeRecordStatus[] = [
  "open",
  "closing_soon",
  "closed",
  "known",
  "unknown",
  "available",
];
const CHANGE_CATEGORIES: readonly CastChangeCategory[] = [
  "deadline",
  "internship",
  "history_report",
  "support_resource",
  "opportunity",
  "other",
];

function text(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function assertOpaqueSourceKey(sourceKey: string): string {
  const normalized = text(sourceKey);
  if (!/^[a-z0-9:_-]{1,128}$/u.test(normalized)) {
    throw new Error(
      "CAST change-feed source keys must be opaque lowercase identifiers.",
    );
  }
  return normalized;
}

function jsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("CAST snapshots must be JSON-serializable.");
  }
  return new TextEncoder().encode(serialized).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} contains an unsupported field.`);
  }
}

function assertCount(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_COUNT
  ) {
    throw new Error(`${label} must be a bounded count.`);
  }
  return value;
}

function assertDate(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !CHANGE_DATE_PATTERN.test(value)) {
    throw new Error(`${label} must be an ISO date or null.`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function assertCapturedAt(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 80 ||
    !value.includes("T") ||
    Number.isNaN(new Date(value).valueOf())
  ) {
    throw new Error("CAST change-feed captured_at is invalid.");
  }
  return value;
}

function normalizeSnapshotRecord(value: unknown): CastChangeSnapshotRecord {
  if (!isRecord(value)) {
    throw new Error("CAST change-feed record must be an object.");
  }
  assertKeys(value, CHANGE_RECORD_KEYS, "CAST change-feed record");
  if (!Object.hasOwn(value, "reference") || !Object.hasOwn(value, "category")) {
    throw new Error("CAST change-feed record is missing required fields.");
  }
  const reference = value.reference;
  if (
    typeof reference !== "string" ||
    !CHANGE_REFERENCE_PATTERN.test(reference) ||
    /(?:access[_-]?token|cookie|password|oauth|authorization|secret)/iu.test(
      reference,
    )
  ) {
    throw new Error("CAST change-feed reference must be opaque.");
  }
  const category = value.category;
  if (
    typeof category !== "string" ||
    !CHANGE_CATEGORIES.includes(category as CastChangeCategory)
  ) {
    throw new Error("CAST change-feed category is invalid.");
  }
  const kind = value.kind;
  if (
    kind !== undefined &&
    (typeof kind !== "string" ||
      !CHANGE_RECORD_KINDS.includes(kind as CastChangeRecordKind))
  ) {
    throw new Error("CAST change-feed kind is invalid.");
  }
  const status = value.status;
  if (
    status !== undefined &&
    (typeof status !== "string" ||
      !CHANGE_RECORD_STATUSES.includes(status as CastChangeRecordStatus))
  ) {
    throw new Error("CAST change-feed status is invalid.");
  }
  const deadline =
    value.deadline === undefined
      ? undefined
      : assertDate(value.deadline, "CAST change-feed deadline");
  const publishedDate =
    value.published_date === undefined
      ? undefined
      : assertDate(value.published_date, "CAST change-feed published_date");
  const count =
    value.count === undefined
      ? undefined
      : assertCount(value.count, "CAST change-feed record count");
  return {
    reference,
    category: category as CastChangeCategory,
    ...(kind !== undefined ? { kind: kind as CastChangeRecordKind } : {}),
    ...(status !== undefined
      ? { status: status as CastChangeRecordStatus }
      : {}),
    ...(deadline !== undefined ? { deadline } : {}),
    ...(publishedDate !== undefined ? { published_date: publishedDate } : {}),
    ...(count !== undefined ? { count } : {}),
  };
}

function normalizeSnapshotCounts(value: unknown): CastChangeSnapshotCounts {
  if (!isRecord(value)) {
    throw new Error("CAST change-feed counts must be an object.");
  }
  assertKeys(value, CHANGE_COUNT_KEYS, "CAST change-feed counts");
  if (Object.keys(value).length === 0) {
    throw new Error("CAST change-feed counts must not be empty.");
  }
  const counts: CastChangeSnapshotCounts = {};
  for (const key of CHANGE_COUNT_KEYS) {
    if (Object.hasOwn(value, key)) {
      counts[key] = assertCount(value[key], `CAST change-feed ${key}`);
    }
  }
  if (Object.keys(counts).length === 0) {
    throw new Error("CAST change-feed counts must not be empty.");
  }
  return counts;
}

/** Validate and copy a change-feed snapshot before it reaches Career Vault. */
export function parseCastChangeSnapshot(value: unknown): CastChangeSnapshot {
  if (!isRecord(value)) {
    throw new Error("CAST change-feed snapshot has an invalid schema.");
  }
  assertKeys(value, CHANGE_SNAPSHOT_KEYS, "CAST change-feed snapshot");
  if (
    !Object.hasOwn(value, "schema_version") ||
    !Object.hasOwn(value, "records") ||
    !Object.hasOwn(value, "counts")
  ) {
    throw new Error("CAST change-feed snapshot is missing required fields.");
  }
  if (value.schema_version !== "v1") {
    throw new Error("CAST change-feed snapshot schema version is unsupported.");
  }
  if (!Array.isArray(value.records) || value.records.length > MAX_RECORDS) {
    throw new Error("CAST change-feed record count is out of bounds.");
  }
  const records = value.records.map(normalizeSnapshotRecord);
  if (
    new Set(records.map((record) => record.reference)).size !== records.length
  ) {
    throw new Error("CAST change-feed references must be unique.");
  }
  return {
    schema_version: "v1",
    records,
    counts: normalizeSnapshotCounts(value.counts),
  };
}

function valueKey(value: unknown, index: number): string {
  if (!isRecord(value)) return `index:${index}`;
  for (const field of ["reference", "local_id", "id", "url", "source_url"]) {
    const candidate = value[field];
    if (typeof candidate === "string" && candidate.trim()) {
      return `${field}:${candidate}`;
    }
  }
  if (typeof value.title === "string") {
    return `title:${value.title}:${String(value.published_date ?? "")}`;
  }
  return `index:${index}`;
}

function pathPart(value: string): string {
  return value.replace(/[.[\]]/gu, "_").slice(0, 160);
}

function categoryForPath(path: string): CastChangeCategory {
  if (/application_deadline|deadline|締切/u.test(path)) return "deadline";
  if (/internship|インターン/u.test(path)) return "internship";
  if (/selection_reports|hiring_records|history|採用|選考/u.test(path)) {
    return "history_report";
  }
  if (/resources|notices|support|counseling|supporter|resource/u.test(path)) {
    return "support_resource";
  }
  if (/opportunit|求人/u.test(path)) return "opportunity";
  return "other";
}

function summaryFor(
  kind: CastChangeKind,
  category: CastChangeCategory,
): string {
  if (category === "deadline") return "締切が変更されました";
  if (category === "internship") {
    return kind === "added"
      ? "インターン情報が追加されました"
      : "インターン情報が変更されました";
  }
  if (category === "history_report") {
    return kind === "added"
      ? "採用実績または選考記録が追加されました"
      : "採用実績または選考記録が変更されました";
  }
  if (category === "support_resource") {
    return kind === "added"
      ? "支援リソースが追加されました"
      : "支援リソースが変更されました";
  }
  return kind === "added"
    ? "CAST情報が追加されました"
    : kind === "removed"
      ? "CAST情報が削除されました"
      : "CAST情報が変更されました";
}

function appendChange(
  changes: CastLocalChange[],
  path: string,
  kind: CastChangeKind,
  previousValue: unknown,
  currentValue: unknown,
): void {
  if (changes.length >= MAX_CHANGES) return;
  const category = categoryForPath(path);
  changes.push({
    path,
    kind,
    category,
    summary: summaryFor(kind, category),
    ...(kind !== "added" ? { previous_value: previousValue } : {}),
    ...(kind !== "removed" ? { current_value: currentValue } : {}),
  });
}

function diffValue(
  previous: unknown,
  current: unknown,
  path: string,
  changes: CastLocalChange[],
): void {
  if (changes.length >= MAX_CHANGES) return;
  if (Object.is(previous, current)) return;

  if (Array.isArray(previous) && Array.isArray(current)) {
    const before = new Map(
      previous.map((value, index) => [valueKey(value, index), value]),
    );
    const after = new Map(
      current.map((value, index) => [valueKey(value, index), value]),
    );
    for (const [key, value] of after) {
      const itemPath = `${path}[${pathPart(key)}]`;
      if (!before.has(key)) {
        appendChange(changes, itemPath, "added", undefined, value);
      } else {
        diffValue(before.get(key), value, itemPath, changes);
      }
    }
    for (const [key, value] of before) {
      if (!after.has(key)) {
        appendChange(
          changes,
          `${path}[${pathPart(key)}]`,
          "removed",
          value,
          undefined,
        );
      }
    }
    return;
  }

  if (isRecord(previous) && isRecord(current)) {
    const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
    for (const key of keys) {
      diffValue(
        previous[key],
        current[key],
        path ? `${path}.${pathPart(key)}` : pathPart(key),
        changes,
      );
    }
    return;
  }

  appendChange(changes, path || "root", "changed", previous, current);
}

export function diffCastSnapshots(
  previous: unknown,
  current: unknown,
): CastLocalChange[] {
  const changes: CastLocalChange[] = [];
  diffValue(previous, current, "", changes);
  return changes;
}

export function projectCastChangesForAgent(
  changeSet: CastChangeSet,
): CastChangeAgentProjection {
  const count = (kind: CastChangeKind) =>
    changeSet.changes.filter((change) => change.kind === kind).length;
  const categoryCount = (category: CastChangeCategory) =>
    changeSet.changes.filter((change) => change.category === category).length;
  return {
    schema_version: "v1",
    status: changeSet.status,
    total_change_count: changeSet.changes.length,
    added_count: count("added"),
    removed_count: count("removed"),
    changed_count: count("changed"),
    deadline_change_count: categoryCount("deadline"),
    internship_change_count: categoryCount("internship"),
    history_report_change_count: categoryCount("history_report"),
    support_resource_change_count: categoryCount("support_resource"),
    opportunity_change_count: categoryCount("opportunity"),
  };
}

export class CastChangeFeed {
  constructor(private readonly vault: CareerVault) {}

  private async recordId(sourceKey: string): Promise<string> {
    const digest = await this.vault.hmac(
      `${RECORD_PREFIX}${assertOpaqueSourceKey(sourceKey)}`,
    );
    return `${RECORD_PREFIX}${Array.from(digest, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")}`;
  }

  async read(sourceKey: string): Promise<CastStoredSnapshot | null> {
    const recordId = await this.recordId(sourceKey);
    const value = await this.vault.get<unknown>(recordId);
    if (value === null) return null;
    if (!isRecord(value)) {
      throw new Error("CAST stored change-feed snapshot is invalid.");
    }
    assertKeys(
      value,
      ["schema_version", "captured_at", "snapshot"],
      "CAST stored change-feed snapshot",
    );
    if (
      !Object.hasOwn(value, "schema_version") ||
      !Object.hasOwn(value, "captured_at") ||
      !Object.hasOwn(value, "snapshot")
    ) {
      throw new Error("CAST stored change-feed snapshot is incomplete.");
    }
    if (value.schema_version !== "v1") {
      throw new Error("CAST stored change-feed schema version is unsupported.");
    }
    return {
      schema_version: "v1",
      captured_at: assertCapturedAt(value.captured_at),
      snapshot: parseCastChangeSnapshot(value.snapshot),
    };
  }

  async compareAndStore(
    sourceKey: string,
    snapshot: unknown,
    capturedAt = new Date().toISOString(),
  ): Promise<CastChangeSet> {
    const normalizedSourceKey = assertOpaqueSourceKey(sourceKey);
    if (jsonBytes(snapshot) > MAX_SNAPSHOT_BYTES) {
      throw new Error("CAST snapshot exceeds the local change-feed limit.");
    }
    const normalizedSnapshot = parseCastChangeSnapshot(snapshot);
    if (jsonBytes(normalizedSnapshot) > MAX_SNAPSHOT_BYTES) {
      throw new Error("CAST snapshot exceeds the local change-feed limit.");
    }
    const normalizedCapturedAt = assertCapturedAt(capturedAt);
    return serializeCareerVaultMutation(
      this.vault,
      `${CHANGE_FEED_MUTATION_KEY}:${normalizedSourceKey}`,
      async () => {
        const previous = await this.read(normalizedSourceKey);
        const changeSet: CastChangeSet = {
          schema_version: "v1",
          status: previous ? "known" : "baseline",
          captured_at: normalizedCapturedAt,
          previous_captured_at: previous?.captured_at ?? null,
          changes: previous
            ? diffCastSnapshots(previous.snapshot, normalizedSnapshot)
            : [],
        };
        await this.vault.put(await this.recordId(normalizedSourceKey), {
          schema_version: "v1",
          captured_at: normalizedCapturedAt,
          snapshot: normalizedSnapshot,
        } satisfies CastStoredSnapshot);
        return changeSet;
      },
    );
  }
}
