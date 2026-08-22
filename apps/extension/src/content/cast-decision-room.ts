import type { CastHistoryLocalSnapshot } from "./cast-history-reports-reader";
import type {
  CastOpportunity,
  CastOpportunityKind,
} from "./cast-opportunities-reader";
import type { CastSupportLocalSnapshot } from "./cast-support-resources-reader";

export type CastDecisionAxis =
  | "technical_domain"
  | "location"
  | "occupation"
  | "hiring_record"
  | "selection_process"
  | "alumni_support"
  | "deadline"
  | "missing_information";

export type CastDecisionSignal = "match" | "partial" | "mismatch" | "unknown";

export interface CastDecisionPreferences {
  technical_domains?: string[];
  locations?: string[];
  occupations?: string[];
  hiring_record_year_from?: number | null;
  hiring_record_year_to?: number | null;
}

/** Local-only evidence pointer. It is not a provider/API contract. */
export interface CastDecisionEvidence {
  evidence_id: string;
  source:
    | "opportunity"
    | "hiring_record"
    | "selection_report"
    | "alumni_support";
  label: string;
}

export interface CastDecisionAssessment {
  axis: CastDecisionAxis;
  signal: CastDecisionSignal;
  summary: string;
  evidence: CastDecisionEvidence[];
  missing_information: string[];
}

export interface CastDecisionRoom {
  schema_version: "v1";
  room_id: string;
  /** This object stays in extension memory and is never sent to a provider. */
  subject: {
    kind: CastOpportunityKind;
    company_name: string;
    local_id: string;
  };
  assessments: CastDecisionAssessment[];
  missing_information: string[];
  next_steps: string[];
}

export interface CastDecisionRoomInput {
  opportunity: CastOpportunity;
  history?: CastHistoryLocalSnapshot | null;
  support?: CastSupportLocalSnapshot | null;
  preferences?: CastDecisionPreferences;
  room_id?: string;
  reference_year?: number;
}

const ROOM_PREFIX = "decision-room:v1:";
const MAX_TEXT_LENGTH = 240;
const MAX_PREFERENCE_ITEMS = 12;

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u3000\s]+/gu, " ")
    .trim()
    .toLocaleLowerCase("ja-JP");
}

function display(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u3000\s]+/gu, " ")
    .trim();
}

function uniquePreferences(values: string[] | undefined): string[] {
  if (!values) return [];
  if (values.length > MAX_PREFERENCE_ITEMS) {
    throw new Error("Too many Decision Room preference terms.");
  }
  const normalizedValues = values
    .filter((value): value is string => typeof value === "string")
    .map(display)
    .filter(Boolean);
  if (normalizedValues.some((value) => value.length > MAX_TEXT_LENGTH)) {
    throw new Error(
      "Decision Room preference term exceeds the maximum length.",
    );
  }
  return Array.from(new Set(normalizedValues)).slice(0, MAX_PREFERENCE_ITEMS);
}

function containsTerm(value: string, term: string): boolean {
  const haystack = normalized(value);
  const needle = normalized(term);
  return (
    Boolean(needle) && (haystack.includes(needle) || needle.includes(haystack))
  );
}

function matchTerms(
  requested: string[],
  available: string[],
): { matched: string[]; missing: string[] } {
  const matched: string[] = [];
  const missing: string[] = [];
  for (const term of requested) {
    if (available.some((value) => containsTerm(value, term))) {
      matched.push(term);
    } else {
      missing.push(term);
    }
  }
  return { matched, missing };
}

function preferenceAssessment(
  axis: Exclude<
    CastDecisionAxis,
    | "hiring_record"
    | "selection_process"
    | "alumni_support"
    | "deadline"
    | "missing_information"
  >,
  requestedValues: string[] | undefined,
  availableValues: string[],
  evidence: CastDecisionEvidence[],
  missingLabel: string,
): CastDecisionAssessment {
  const requested = uniquePreferences(requestedValues);
  const available = availableValues.map(display).filter(Boolean);
  if (requested.length === 0) {
    return {
      axis,
      signal: "unknown",
      summary: "この判断軸の希望条件は指定されていません。",
      evidence,
      missing_information: ["希望条件"],
    };
  }
  if (available.length === 0) {
    return {
      axis,
      signal: "unknown",
      summary: `${missingLabel}を求人票から確認できません。`,
      evidence,
      missing_information: [missingLabel],
    };
  }
  const { matched, missing } = matchTerms(requested, available);
  const signal: CastDecisionSignal =
    matched.length === requested.length
      ? "match"
      : matched.length > 0
        ? "partial"
        : "mismatch";
  const summary =
    signal === "match"
      ? `${axisLabel(axis)}は希望条件と一致します。`
      : signal === "partial"
        ? `${axisLabel(axis)}は一部が一致し、未確認の希望があります。`
        : `${axisLabel(axis)}は指定した希望条件と一致する表示がありません。`;
  return {
    axis,
    signal,
    summary,
    evidence,
    missing_information:
      missing.length > 0 ? [`${missingLabel}: ${missing.join("、")}`] : [],
  };
}

function axisLabel(axis: CastDecisionAxis): string {
  switch (axis) {
    case "technical_domain":
      return "技術領域";
    case "location":
      return "勤務地";
    case "occupation":
      return "職種";
    case "hiring_record":
      return "採用実績";
    case "selection_process":
      return "選考記録";
    case "alumni_support":
      return "OB・OG支援";
    case "deadline":
      return "締切";
    case "missing_information":
      return "不足情報";
  }
}

function dateYear(value: string | null): number | null {
  const match = value?.match(/^(20\d{2})-/u);
  return match ? Number(match[1]) : null;
}

function hiringAssessment(
  history: CastHistoryLocalSnapshot | null | undefined,
  preferences: CastDecisionPreferences,
  referenceYear: number,
): CastDecisionAssessment {
  const evidence: CastDecisionEvidence[] = [
    {
      evidence_id: "decision-evidence:v1:hiring-records",
      source: "hiring_record",
      label: "CAST採用実績",
    },
  ];
  if (!history) {
    return {
      axis: "hiring_record",
      signal: "unknown",
      summary: "企業詳細の採用実績を確認できていません。",
      evidence: [],
      missing_information: ["過去の採用実績"],
    };
  }
  const from = preferences.hiring_record_year_from ?? referenceYear - 4;
  const to = preferences.hiring_record_year_to ?? referenceYear;
  const dated = history.hiring_records.filter((record) => {
    const year = dateYear(record.graduation_date);
    return year !== null && year >= from && year <= to;
  });
  const undated = history.hiring_records.some(
    (record) => dateYear(record.graduation_date) === null,
  );
  if (dated.length > 0) {
    return {
      axis: "hiring_record",
      signal: "match",
      summary: `${from}〜${to}年の採用実績を${dated.length}件確認しました。`,
      evidence,
      missing_information: [],
    };
  }
  return {
    axis: "hiring_record",
    signal: undated ? "unknown" : "mismatch",
    summary: undated
      ? `${from}〜${to}年で照合できる卒業年月が不足しています。`
      : `${from}〜${to}年の採用実績は確認できませんでした。`,
    evidence,
    missing_information: undated ? ["採用実績の卒業年月"] : [],
  };
}

function selectionAssessment(
  history: CastHistoryLocalSnapshot | null | undefined,
): CastDecisionAssessment {
  if (!history) {
    return {
      axis: "selection_process",
      signal: "unknown",
      summary: "先輩の選考記録をまだ確認していません。",
      evidence: [],
      missing_information: ["選考記録"],
    };
  }
  const evidence: CastDecisionEvidence[] = history.selection_reports.length
    ? [
        {
          evidence_id: "decision-evidence:v1:selection-reports",
          source: "selection_report",
          label: "CAST選考記録",
        },
      ]
    : [];
  return {
    axis: "selection_process",
    signal: history.selection_reports.length > 0 ? "match" : "unknown",
    summary:
      history.selection_reports.length > 0
        ? `選考記録を${history.selection_reports.length}件確認しました。`
        : "この企業の選考記録は確認できませんでした。",
    evidence,
    missing_information:
      history.selection_reports.length > 0 ? [] : ["選考記録"],
  };
}

function alumniAssessment(
  history: CastHistoryLocalSnapshot | null | undefined,
  support: CastSupportLocalSnapshot | null | undefined,
): CastDecisionAssessment {
  const available = Boolean(
    history?.obog_available || support?.supporter_link_available,
  );
  if (!history && !support) {
    return {
      axis: "alumni_support",
      signal: "unknown",
      summary: "OB・OG訪問や就活サポーターの情報をまだ確認していません。",
      evidence: [],
      missing_information: ["OB・OG支援の可否"],
    };
  }
  return {
    axis: "alumni_support",
    signal: available ? "match" : "mismatch",
    summary: available
      ? "OB・OGまたは就活サポーターにつながる表示を確認しました。"
      : "OB・OG訪問や就活サポーターにつながる表示を確認できませんでした。",
    evidence: available
      ? [
          {
            evidence_id: "decision-evidence:v1:alumni-support",
            source: "alumni_support",
            label: "CASTのOB・OG／サポーター表示",
          },
        ]
      : [],
    missing_information: [],
  };
}

function deadlineAssessment(
  opportunity: CastOpportunity,
): CastDecisionAssessment {
  const evidence: CastDecisionEvidence[] = [
    {
      evidence_id: "decision-evidence:v1:opportunity",
      source: "opportunity",
      label: "CAST求人・インターン情報",
    },
  ];
  if (!opportunity.application_deadline) {
    return {
      axis: "deadline",
      signal: "unknown",
      summary: "応募締切が表示されていません。",
      evidence,
      missing_information: ["応募締切"],
    };
  }
  if (opportunity.status === "closed") {
    return {
      axis: "deadline",
      signal: "mismatch",
      summary: `応募締切は${opportunity.application_deadline}で、受付終了として表示されています。`,
      evidence,
      missing_information: [],
    };
  }
  if (opportunity.status === "open" || opportunity.status === "closing_soon") {
    return {
      axis: "deadline",
      signal: "match",
      summary: `応募締切は${opportunity.application_deadline}です。`,
      evidence,
      missing_information: [],
    };
  }
  return {
    axis: "deadline",
    signal: "unknown",
    summary: `応募締切は${opportunity.application_deadline}ですが、受付状態を確認できません。`,
    evidence,
    missing_information: ["受付状態"],
  };
}

function roomId(): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Web Crypto API is unavailable.");
  }
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `${ROOM_PREFIX}${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function assertRoomId(value: string): string {
  const normalizedValue = display(value);
  if (!/^decision-room:v1:[a-z0-9-]{1,128}$/u.test(normalizedValue)) {
    throw new Error("Decision Room ID must be an opaque local identifier.");
  }
  return normalizedValue;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function buildNextSteps(
  assessments: CastDecisionAssessment[],
  missingInformation: string[],
): string[] {
  const steps: string[] = [];
  const mismatch = assessments.filter(
    (assessment) => assessment.signal === "mismatch",
  );
  if (mismatch.length > 0) {
    steps.push("不一致の判断軸を求人票・企業詳細で再確認する");
  }
  if (missingInformation.length > 0) {
    steps.push("不足情報をCASTの確認済みページで補う");
  }
  if (
    assessments.some(
      (assessment) =>
        assessment.axis === "deadline" && assessment.signal === "match",
    )
  ) {
    steps.push("応募締切と必要書類を本人が確認する");
  }
  if (steps.length === 0) steps.push("各判断軸の根拠を確認して比較を続ける");
  return unique(steps);
}

/** Build a local, evidence-decomposed Decision Room. No model or network call is made. */
export function buildCastDecisionRoom(
  input: CastDecisionRoomInput,
): CastDecisionRoom {
  const opportunity = input.opportunity;
  const preferences = input.preferences ?? {};
  const referenceYear = input.reference_year ?? new Date().getUTCFullYear();
  const history =
    input.history &&
    normalized(input.history.company_name) ===
      normalized(opportunity.company_name)
      ? input.history
      : null;
  const assessments: CastDecisionAssessment[] = [
    preferenceAssessment(
      "technical_domain",
      preferences.technical_domains,
      [...opportunity.industry, ...opportunity.eligible_programs],
      [
        {
          evidence_id: "decision-evidence:v1:opportunity",
          source: "opportunity",
          label: "CAST求人・インターン情報",
        },
      ],
      "技術領域",
    ),
    preferenceAssessment(
      "location",
      preferences.locations,
      opportunity.locations,
      [
        {
          evidence_id: "decision-evidence:v1:opportunity",
          source: "opportunity",
          label: "CAST求人・インターン情報",
        },
      ],
      "勤務地",
    ),
    preferenceAssessment(
      "occupation",
      preferences.occupations,
      opportunity.occupations,
      [
        {
          evidence_id: "decision-evidence:v1:opportunity",
          source: "opportunity",
          label: "CAST求人・インターン情報",
        },
      ],
      "職種",
    ),
    hiringAssessment(history, preferences, referenceYear),
    selectionAssessment(history),
    alumniAssessment(history, input.support),
    deadlineAssessment(opportunity),
  ];
  const missingInformation = unique(
    assessments.flatMap((assessment) => assessment.missing_information),
  );
  assessments.push({
    axis: "missing_information",
    signal: missingInformation.length > 0 ? "unknown" : "match",
    summary:
      missingInformation.length > 0
        ? `判断に必要な情報が${missingInformation.length}項目あります。`
        : "主要な判断軸に不足情報はありません。",
    evidence: [],
    missing_information: missingInformation,
  });
  return {
    schema_version: "v1",
    room_id: input.room_id ? assertRoomId(input.room_id) : roomId(),
    subject: {
      kind: opportunity.kind,
      company_name: opportunity.company_name,
      local_id: opportunity.local_id,
    },
    assessments,
    missing_information: missingInformation,
    next_steps: buildNextSteps(assessments, missingInformation),
  };
}
