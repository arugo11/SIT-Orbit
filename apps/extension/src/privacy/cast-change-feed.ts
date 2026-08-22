import type { CareerVault } from "./career-vault";

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

export interface CastStoredSnapshot {
  schema_version: "v1";
  captured_at: string;
  snapshot: unknown;
}

const RECORD_PREFIX = "cast-change-snapshot:v1:";
const MAX_SNAPSHOT_BYTES = 2_000_000;
const MAX_CHANGES = 500;

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

function valueKey(value: unknown, index: number): string {
  if (!isRecord(value)) return `index:${index}`;
  for (const field of ["local_id", "id", "url", "source_url"]) {
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
    return this.vault.get<CastStoredSnapshot>(recordId);
  }

  async compareAndStore(
    sourceKey: string,
    snapshot: unknown,
    capturedAt = new Date().toISOString(),
  ): Promise<CastChangeSet> {
    if (jsonBytes(snapshot) > MAX_SNAPSHOT_BYTES) {
      throw new Error("CAST snapshot exceeds the local change-feed limit.");
    }
    const previous = await this.read(sourceKey);
    const changeSet: CastChangeSet = {
      schema_version: "v1",
      status: previous ? "known" : "baseline",
      captured_at: capturedAt,
      previous_captured_at: previous?.captured_at ?? null,
      changes: previous ? diffCastSnapshots(previous.snapshot, snapshot) : [],
    };
    await this.vault.put(await this.recordId(sourceKey), {
      schema_version: "v1",
      captured_at: capturedAt,
      snapshot,
    } satisfies CastStoredSnapshot);
    return changeSet;
  }
}
