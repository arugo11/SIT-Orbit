export const CAST_ORIGIN = "https://shibaura.pita.services";
export const CAST_JOB_SEARCH_URL = `${CAST_ORIGIN}/career/job_offer_search/search`;
export const CAST_INTERNSHIP_SEARCH_URL = `${CAST_ORIGIN}/career/internship_search`;

export type CastOpportunityKind = "job" | "internship";
export type CastOpportunityStatus =
  | "open"
  | "closing_soon"
  | "closed"
  | "unknown";

export interface CastOpportunityRelations {
  job_offer: boolean;
  company_session: boolean;
  internship: boolean;
  hiring_record: boolean;
  alumni_directory: boolean;
  career_supporter: boolean;
  entrance_exam: boolean;
}

export interface CastOpportunity {
  kind: CastOpportunityKind;
  local_id: string;
  company_name: string;
  industry: string[];
  status: CastOpportunityStatus;
  received_date: string | null;
  application_deadline: string | null;
  description: string | null;
  occupations: string[];
  locations: string[];
  eligible_programs: string[];
  target_grades: string[];
  period_start: string | null;
  period_end: string | null;
  duration: string[];
  application_methods: string[];
  relations: CastOpportunityRelations;
}

export interface CastOpportunityLocalSnapshot {
  schema_version: "v1";
  kind: CastOpportunityKind;
  opportunities: CastOpportunity[];
}

export interface CastOpportunityAgentProjection {
  schema_version: "v1";
  status: "known" | "reauth_required" | "unavailable";
  kind: CastOpportunityKind;
  opportunity_count: number;
  open_count: number;
  closing_soon_count: number;
  closed_count: number;
  nearest_deadline: string | null;
  reason_code: string | null;
}

function compactText(
  value: string | null | undefined,
  maxLength: number,
): string {
  return (value ?? "").replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

function strictPath(value: string | null | undefined, path: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.origin === CAST_ORIGIN &&
      url.pathname === path &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export function isCastJobSearchUrl(value: string | null | undefined): boolean {
  return strictPath(value, "/career/job_offer_search/search");
}

export function isCastInternshipSearchUrl(
  value: string | null | undefined,
): boolean {
  return strictPath(value, "/career/internship_search");
}

export function isCastOpportunitySearchUrl(
  value: string | null | undefined,
): boolean {
  return isCastJobSearchUrl(value) || isCastInternshipSearchUrl(value);
}

function normalizeDate(value: string | null | undefined): string | null {
  const match = compactText(value, 100).match(
    /(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/u,
  );
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function splitList(value: string | undefined, maxItems = 50): string[] {
  return Array.from(
    new Set(
      compactText(value, 2400)
        .split(/[、,]\s*/u)
        .map((item) => compactText(item, 240))
        .filter(Boolean),
    ),
  ).slice(0, maxItems);
}

function parseStatus(value: string): CastOpportunityStatus {
  if (/締切間近/u.test(value)) return "closing_soon";
  if (/受付中/u.test(value)) return "open";
  if (/(終了|受付終了|締切)/u.test(value)) return "closed";
  return "unknown";
}

function parsePeriod(value: string | undefined): {
  start: string | null;
  end: string | null;
} {
  const dates = compactText(value, 200).match(
    /(20\d{2}[-/.]\d{1,2}[-/.]\d{1,2})\s*[～〜~-]\s*(20\d{2}[-/.]\d{1,2}[-/.]\d{1,2})/u,
  );
  return {
    start: normalizeDate(dates?.[1]),
    end: normalizeDate(dates?.[2]),
  };
}

function rowsByLabel(panel: Element): Map<string, string> {
  const rows = new Map<string, string>();
  for (const row of Array.from(panel.querySelectorAll(".panel-body .row"))) {
    const children = Array.from(row.children);
    const labels = children.filter((child) =>
      child.classList.contains("cell-th"),
    );
    const values = children.filter((child) =>
      child.classList.contains("cell-td"),
    );
    labels.forEach((label, index) => {
      const name = compactText(label.textContent, 160);
      const value = compactText(values[index]?.textContent, 4000);
      if (name && value) rows.set(name, value);
    });
  }
  return rows;
}

function relationFlags(value: string | undefined): CastOpportunityRelations {
  const text = compactText(value, 2000);
  return {
    job_offer: /求人情報/u.test(text),
    company_session: /会社説明会/u.test(text),
    internship: /インターンシップ/u.test(text),
    hiring_record: /採用実績/u.test(text),
    alumni_directory: /OB・OG名簿/u.test(text),
    career_supporter: /就活サポーター/u.test(text),
    entrance_exam: /入社試験情報/u.test(text),
  };
}

function stableLocalId(
  kind: CastOpportunityKind,
  panel: Element,
  index: number,
  receivedDate: string | null,
  deadline: string | null,
  companyName: string,
): string {
  if (kind === "job") {
    const numberText = compactText(
      panel.querySelector(".panel-heading")?.textContent,
      160,
    ).match(/求人番号\s*[：:]\s*([A-Z0-9-]+)/iu)?.[1];
    if (numberText) return `job:${numberText}`;
  }
  const companyCode = panel
    .querySelector(".linkTo")
    ?.getAttribute("data-companycode");
  const material = [
    kind,
    companyCode ?? companyName,
    receivedDate ?? "unknown-received",
    deadline ?? "unknown-deadline",
    index.toString(),
  ].join(":");
  return `${kind}:${material.replace(/[^a-z0-9:_-]+/giu, "-").slice(0, 180)}`;
}

function parsePanel(
  panel: Element,
  kind: CastOpportunityKind,
  index: number,
): CastOpportunity | null {
  const heading = compactText(
    panel.querySelector(".panel-heading")?.textContent,
    2400,
  );
  const rows = rowsByLabel(panel);
  const company = compactText(
    panel.querySelector(".panel-body .linkTo")?.textContent ??
      rows.get("企業名"),
    240,
  );
  if (!company) return null;

  const received = normalizeDate(
    kind === "job"
      ? heading.match(/求人受付日\s*[：:]\s*([^\s]+)/u)?.[1]
      : heading.match(/受付日\s*[：:]\s*([^\s]+)/u)?.[1],
  );
  const deadline = normalizeDate(
    heading.match(/応募締切日\s*[：:]\s*([^\s]+)/u)?.[1],
  );
  const period = parsePeriod(rows.get("実施時期"));
  const description =
    kind === "job"
      ? compactText(rows.get("仕事内容"), 6000) || null
      : compactText(
          panel.querySelector(".panel-body .control-label.h4")?.textContent,
          6000,
        ) || null;
  const occupation = kind === "job" ? rows.get("募集職種") : undefined;
  const location = kind === "job" ? rows.get("勤務地") : rows.get("実施地");
  const eligibility =
    kind === "job" ? rows.get("募集学部学科") : rows.get("募集学部学科");
  const targetGrades = kind === "internship" ? rows.get("対象学年") : undefined;
  const duration = kind === "internship" ? rows.get("実施日数") : undefined;
  const method = kind === "job" ? rows.get("応募方法") : undefined;
  const localId = stableLocalId(
    kind,
    panel,
    index,
    received,
    deadline,
    company,
  );
  const status = parseStatus(heading);
  return {
    kind,
    local_id: localId,
    company_name: company,
    industry: splitList(rows.get("業種")),
    status,
    received_date: received,
    application_deadline: deadline,
    description,
    occupations: splitList(occupation),
    locations: splitList(location),
    eligible_programs: splitList(eligibility),
    target_grades: splitList(targetGrades),
    period_start: period.start,
    period_end: period.end,
    duration: splitList(duration),
    application_methods: splitList(method),
    relations: relationFlags(rows.get("本学との関連")),
  };
}

function emptyResultCount(document: Document): boolean {
  return /該当数\s*[：:]\s*0件/u.test(
    compactText(document.body?.textContent, 10000),
  );
}

export function extractCastOpportunities(
  document: Document,
  pageUrl: string,
): CastOpportunityLocalSnapshot | null {
  const kind = isCastJobSearchUrl(pageUrl)
    ? "job"
    : isCastInternshipSearchUrl(pageUrl)
      ? "internship"
      : null;
  if (!kind || document.querySelector('input[type="password"]')) return null;

  const panels = Array.from(
    document.querySelectorAll(".panel.panel-default"),
  ).filter((panel) => panel.querySelector(".panel-heading .view-detail"));
  if (panels.length === 0 && !emptyResultCount(document)) return null;
  const opportunities = panels
    .slice(0, 200)
    .map((panel, index) => parsePanel(panel, kind, index))
    .filter((item): item is CastOpportunity => item !== null);
  if (panels.length > 0 && opportunities.length === 0) return null;
  return {
    schema_version: "v1",
    kind,
    opportunities,
  };
}

export function projectCastOpportunitiesForAgent(
  snapshot: CastOpportunityLocalSnapshot,
): CastOpportunityAgentProjection {
  const deadlines = snapshot.opportunities
    .map((item) => item.application_deadline)
    .filter((value): value is string => value !== null)
    .sort();
  return {
    schema_version: "v1",
    status: "known",
    kind: snapshot.kind,
    opportunity_count: snapshot.opportunities.length,
    open_count: snapshot.opportunities.filter((item) => item.status === "open")
      .length,
    closing_soon_count: snapshot.opportunities.filter(
      (item) => item.status === "closing_soon",
    ).length,
    closed_count: snapshot.opportunities.filter(
      (item) => item.status === "closed",
    ).length,
    nearest_deadline: deadlines[0] ?? null,
    reason_code: null,
  };
}
