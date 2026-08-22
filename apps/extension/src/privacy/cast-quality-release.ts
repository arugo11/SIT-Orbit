import type { ApplicationMissionRecord } from "./application-mission";
import type { CastChangeSet, CastLocalChange } from "./cast-change-feed";
import type { EvidenceGroundedEsDraft } from "./evidence-grounded-es";
import type { PseudonymizedCastPayload } from "./pseudonymization";

export const CAST_QUALITY_RELEASE_SCHEMA_VERSION = "v1" as const;

export interface CastQualityPerformanceInput {
  cross_search_ms?: number[];
  prompt_ms?: number[];
  pseudonymization_ms?: number[];
}

export interface CastQualityReleaseInput {
  pseudonymized_payload: PseudonymizedCastPayload;
  forbidden_terms: string[];
  evidence_draft: EvidenceGroundedEsDraft | null;
  change_set: CastChangeSet;
  expected_change_keys: string[];
  mission: ApplicationMissionRecord;
  performance?: CastQualityPerformanceInput;
}

export type CastQualityCheckStatus = "pass" | "fail";

export interface CastQualityCheck {
  id:
    | "pseudonymization_leakage"
    | "evidence_coverage"
    | "change_exactness"
    | "mission_trace"
    | "performance_input";
  status: CastQualityCheckStatus;
  observed: number | boolean;
  threshold: number | boolean;
}

export interface CastQualityLatencySummary {
  sample_count: number;
  median_ms: number | null;
  p95_ms: number | null;
}

export interface CastQualityPerformanceSummary {
  cross_search: CastQualityLatencySummary;
  prompt: CastQualityLatencySummary;
  pseudonymization: CastQualityLatencySummary;
}

export interface CastQualityReleaseReport {
  schema_version: typeof CAST_QUALITY_RELEASE_SCHEMA_VERSION;
  status: "pass" | "fail";
  checks: CastQualityCheck[];
  leakage_count: number;
  evidence_sentence_count: number;
  grounded_sentence_count: number;
  expected_change_count: number;
  actual_change_count: number;
  matched_change_count: number;
  change_precision: number;
  change_recall: number;
  performance: CastQualityPerformanceSummary;
}

const REQUIRED_MISSION_EVENTS = [
  "requirements-confirmed",
  "history-collected",
  "evidence-collected",
  "es-drafted",
  "counseling-selected",
  "calendar-previewed",
  "calendar-confirmed",
] as const;

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("ja-JP");
}

function safeTerms(values: string[]): string[] {
  if (!Array.isArray(values))
    throw new TypeError("Quality forbidden terms must be an array.");
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map(normalized)
        .filter((value) => value.length >= 2 && value.length <= 240),
    ),
  );
}

function scanLeakage(payload: unknown, forbiddenTerms: string[]): number {
  const serialized = normalized(JSON.stringify(payload) ?? "");
  return safeTerms(forbiddenTerms).filter((term) => serialized.includes(term))
    .length;
}

function evidenceCoverage(draft: EvidenceGroundedEsDraft | null): {
  total: number;
  grounded: number;
} {
  if (!draft) return { total: 0, grounded: 0 };
  const total = draft.sentences.length;
  const grounded = draft.sentences.filter(
    (sentence) =>
      sentence.evidence_ids.length > 0 && sentence.grounding_quotes.length > 0,
  ).length;
  return { total, grounded };
}

function changeKey(change: CastLocalChange): string {
  return `${change.kind}:${change.path}`;
}

function changeExactness(
  changeSet: CastChangeSet,
  expectedKeys: string[],
): {
  expected: number;
  actual: number;
  matched: number;
  precision: number;
  recall: number;
} {
  const expected = new Set(
    expectedKeys.filter((value): value is string => typeof value === "string"),
  );
  const actual = new Set(changeSet.changes.map(changeKey));
  const matched = [...actual].filter((key) => expected.has(key)).length;
  return {
    expected: expected.size,
    actual: actual.size,
    matched,
    precision:
      actual.size === 0 ? (expected.size === 0 ? 1 : 0) : matched / actual.size,
    recall:
      expected.size === 0
        ? actual.size === 0
          ? 1
          : 0
        : matched / expected.size,
  };
}

function missionTraceValid(record: ApplicationMissionRecord): boolean {
  if (record.schema_version !== "v1") return false;
  if (!Array.isArray(record.transitions)) return false;
  let cursor = 0;
  let previewSeen = false;
  for (const transition of record.transitions) {
    if (transition.type === "calendar-previewed") previewSeen = true;
    if (transition.type === "calendar-confirmed" && !previewSeen) return false;
    const index = REQUIRED_MISSION_EVENTS.indexOf(
      transition.type as (typeof REQUIRED_MISSION_EVENTS)[number],
    );
    if (index < 0) continue;
    if (index < cursor) return false;
    if (index > cursor) return false;
    cursor += 1;
  }
  return record.status === "completed"
    ? cursor === REQUIRED_MISSION_EVENTS.length
    : cursor <= REQUIRED_MISSION_EVENTS.length;
}

function latencySummary(
  values: number[] | undefined,
): CastQualityLatencySummary {
  if (!values || values.length === 0) {
    return { sample_count: 0, median_ms: null, p95_ms: null };
  }
  if (
    values.some(
      (value) =>
        typeof value !== "number" || !Number.isFinite(value) || value < 0,
    )
  ) {
    throw new Error(
      "Quality performance samples must be finite non-negative numbers.",
    );
  }
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number => {
    const index = Math.min(
      sorted.length - 1,
      Math.ceil(sorted.length * fraction) - 1,
    );
    const value = sorted[index];
    if (value === undefined) throw new Error("Quality sample is missing.");
    return Number(value.toFixed(3));
  };
  return {
    sample_count: sorted.length,
    median_ms: percentile(0.5),
    p95_ms: percentile(0.95),
  };
}

function performanceSummary(
  performance: CastQualityPerformanceInput | undefined,
): CastQualityPerformanceSummary {
  return {
    cross_search: latencySummary(performance?.cross_search_ms),
    prompt: latencySummary(performance?.prompt_ms),
    pseudonymization: latencySummary(performance?.pseudonymization_ms),
  };
}

export function runCastQualityRelease(
  input: CastQualityReleaseInput,
): CastQualityReleaseReport {
  const leakageCount = scanLeakage(
    input.pseudonymized_payload,
    input.forbidden_terms,
  );
  const coverage = evidenceCoverage(input.evidence_draft);
  const changes = changeExactness(input.change_set, input.expected_change_keys);
  const traceValid = missionTraceValid(input.mission);
  const performance = performanceSummary(input.performance);
  const checks: CastQualityCheck[] = [
    {
      id: "pseudonymization_leakage",
      status: leakageCount === 0 ? "pass" : "fail",
      observed: leakageCount,
      threshold: 0,
    },
    {
      id: "evidence_coverage",
      status:
        coverage.total > 0 && coverage.grounded === coverage.total
          ? "pass"
          : "fail",
      observed: coverage.total === 0 ? 0 : coverage.grounded / coverage.total,
      threshold: 1,
    },
    {
      id: "change_exactness",
      status: changes.precision === 1 && changes.recall === 1 ? "pass" : "fail",
      observed:
        changes.expected === 0 && changes.actual === 0
          ? 1
          : Math.min(changes.precision, changes.recall),
      threshold: 1,
    },
    {
      id: "mission_trace",
      status: traceValid ? "pass" : "fail",
      observed: traceValid,
      threshold: true,
    },
    {
      id: "performance_input",
      status: "pass",
      observed: true,
      threshold: true,
    },
  ];
  return {
    schema_version: CAST_QUALITY_RELEASE_SCHEMA_VERSION,
    status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    checks,
    leakage_count: leakageCount,
    evidence_sentence_count: coverage.total,
    grounded_sentence_count: coverage.grounded,
    expected_change_count: changes.expected,
    actual_change_count: changes.actual,
    matched_change_count: changes.matched,
    change_precision: changes.precision,
    change_recall: changes.recall,
    performance,
  };
}
