import {
  type CastHistoryLocalSnapshot,
  extractCastHistory,
  isCastCompanyDetailUrl,
} from "./cast-history-reports-reader";
import {
  type CastSearchFilters,
  type CastSearchItem,
  type CastSearchKind,
  type CastSearchLocalResult,
  type CastSearchRequest,
  runCastSearch,
} from "./cast-search-api";
import {
  CAST_NOTION_EVENT_URL,
  CAST_NOTION_RECORDING_URL,
  type CastSupportPageItem,
  type CastSupportPageKind,
  type CastSupportPageReadResult,
  type CastSupportPageSnapshot,
  extractCastSupportPage,
  isCastSupportPageUrl,
} from "./cast-support-reader";
import {
  CAST_TOP_URL,
  extractCastSupportResources,
} from "./cast-support-resources-reader";

/** Message handled by the CAST page content script. */
export const CAST_CAREER_INTERNAL_MESSAGE = "orbit-cast-career-search" as const;
export const CAST_CAREER_SOURCE_SCHEMA_VERSION = "v1" as const;
export const CAST_CAREER_SUPPORT_LINKS = {
  recording: CAST_NOTION_RECORDING_URL,
  career_event: CAST_NOTION_EVENT_URL,
} as const;

export type CastCareerSurface =
  | "job"
  | "internship"
  | "company_session"
  | "company"
  | "hiring_record"
  | "selection_report"
  | "recording"
  | "career_event"
  | "counseling";

export type CastCareerSourceStatus =
  | "known"
  | "partial"
  | "reauth_required"
  | "form_changed"
  | "rate_limited"
  | "unavailable";

export interface CastCareerFilters {
  company_name?: string;
  locations?: string[];
  industries?: string[];
  technical_domains?: string[];
  occupations?: string[];
  academic_programs?: string[];
  graduation_years?: number[];
  deadline_before?: string;
  target_grades?: string[];
  obog_required?: boolean;
  career_supporter_required?: boolean;
  recording_required?: boolean;
}

export interface CastCareerSearchRequest {
  query: string;
  surfaces: CastCareerSurface[];
  filters: CastCareerFilters;
  limit: number;
  exhaustive?: boolean;
}

export interface CastCareerSourceItem {
  /** Run-scoped opaque reference; never derived from a CAST company code. */
  result_ref: string;
  surface: CastCareerSurface;
  title: string;
  company_name: string | null;
  dates: string[];
  deadline: string | null;
  locations: string[];
  industries: string[];
  occupations: string[];
  academic_programs: string[];
  graduation_years: number[];
  relation_flags: string[];
  /** Local-only text used by the deterministic card / Prompt API. */
  local_summary: string | null;
  /** Strict, query-free URL for an official local open operation. */
  source_url: string | null;
}

export interface CastCareerSurfaceResult {
  surface: CastCareerSurface;
  status: CastCareerSourceStatus;
  total_count: number | null;
  returned_count: number;
  coverage: {
    mode: "page" | "complete" | "partial";
    fetched_pages: number;
    page_size: number;
  } | null;
  items: CastCareerSourceItem[];
  reason_code: string | null;
  evidence_ids: string[];
}

export interface CastCareerSupportLink {
  kind: Extract<CastCareerSurface, "recording" | "career_event">;
  url: string;
}

export interface CastCareerLocalEvidence {
  evidence_id: string;
  title: string;
  locator: string;
}

export interface CastCareerLocalResult {
  schema_version: typeof CAST_CAREER_SOURCE_SCHEMA_VERSION;
  status: CastCareerSourceStatus;
  query: string;
  surfaces: CastCareerSurface[];
  surface_results: CastCareerSurfaceResult[];
  items: CastCareerSourceItem[];
  local_evidence: CastCareerLocalEvidence[];
  discovered_support_links: CastCareerSupportLink[];
  reason_codes: string[];
}

export interface CastCareerSupportRuntimeResult {
  kind: Extract<CastCareerSurface, "recording" | "career_event">;
  result: CastSupportPageReadResult;
}

const CAST_ORIGIN = "https://shibaura.pita.services";
const COUNSELING_PATH = "/career/consultation_reservation";
const SURFACES: readonly CastCareerSurface[] = [
  "job",
  "internship",
  "company_session",
  "company",
  "hiring_record",
  "selection_report",
  "recording",
  "career_event",
  "counseling",
];
const DIRECT_SURFACE_KIND: Readonly<
  Partial<Record<CastCareerSurface, CastSearchKind>>
> = {
  job: "job",
  internship: "internship",
  company_session: "company_session",
  company: "company",
  hiring_record: "hiring_record",
};
const PAGE_SIZE = 10;
const COMPANY_DETAIL_LIMIT = 5;
const MAX_ITEMS = 20;
const MAX_SUPPORT_ITEMS = 100;
const SAFE_DATE = /^20\d{2}-\d{2}-\d{2}$/u;

function compact(value: string | null | undefined, limit = 800): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

function unique(values: readonly string[], limit = 30): string[] {
  return Array.from(
    new Set(values.map((value) => compact(value, 180)).filter(Boolean)),
  ).slice(0, limit);
}

function randomRef(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replaceAll("-", "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `orbit-cast-${prefix}-${random.slice(0, 24)}`;
}

function safeDate(value: unknown): string | null {
  if (typeof value !== "string" || !SAFE_DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : value;
}

function safeString(value: unknown, limit = 200): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= limit
  );
}

function stringArray(value: unknown, limit = 20): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= limit &&
    value.every((item) => safeString(item, 200))
  );
}

function integerArray(value: unknown, limit = 20): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= limit &&
    value.every(
      (item) =>
        typeof item === "number" &&
        Number.isInteger(item) &&
        item >= 1995 &&
        item <= 2100,
    )
  );
}

function isSurface(value: unknown): value is CastCareerSurface {
  return (
    typeof value === "string" && SURFACES.includes(value as CastCareerSurface)
  );
}

/** Validate only semantic fields; URL, form field, and company-code inputs are rejected. */
export function isCastCareerSearchRequest(
  value: unknown,
): value is CastCareerSearchRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).some(
      (key) =>
        !["query", "surfaces", "filters", "limit", "exhaustive"].includes(key),
    )
  )
    return false;
  if (!safeString(candidate.query, 1000)) return false;
  if (
    !Array.isArray(candidate.surfaces) ||
    candidate.surfaces.length === 0 ||
    candidate.surfaces.length > SURFACES.length ||
    candidate.surfaces.some((surface) => !isSurface(surface)) ||
    new Set(candidate.surfaces as unknown[]).size !== candidate.surfaces.length
  )
    return false;
  if (
    typeof candidate.limit !== "number" ||
    !Number.isInteger(candidate.limit) ||
    candidate.limit < 1 ||
    candidate.limit > MAX_ITEMS
  )
    return false;
  if (
    candidate.exhaustive !== undefined &&
    typeof candidate.exhaustive !== "boolean"
  )
    return false;
  if (
    !candidate.filters ||
    typeof candidate.filters !== "object" ||
    Array.isArray(candidate.filters)
  )
    return false;
  const filters = candidate.filters as Record<string, unknown>;
  const allowed = new Set([
    "company_name",
    "locations",
    "industries",
    "technical_domains",
    "occupations",
    "academic_programs",
    "graduation_years",
    "deadline_before",
    "target_grades",
    "obog_required",
    "career_supporter_required",
    "recording_required",
  ]);
  if (Object.keys(filters).some((key) => !allowed.has(key))) return false;
  if (filters.company_name !== undefined && !safeString(filters.company_name))
    return false;
  for (const key of [
    "locations",
    "industries",
    "technical_domains",
    "occupations",
    "academic_programs",
    "target_grades",
  ]) {
    if (filters[key] !== undefined && !stringArray(filters[key])) return false;
  }
  if (
    filters.graduation_years !== undefined &&
    !integerArray(filters.graduation_years)
  )
    return false;
  if (
    filters.deadline_before !== undefined &&
    safeDate(filters.deadline_before) === null
  )
    return false;
  for (const key of [
    "obog_required",
    "career_supporter_required",
    "recording_required",
  ]) {
    if (filters[key] !== undefined && typeof filters[key] !== "boolean")
      return false;
  }
  return true;
}

function safeSearchFilters(filters: CastCareerFilters): CastSearchFilters {
  const next: CastSearchFilters = {};
  if (filters.company_name !== undefined)
    next.company_name = filters.company_name;
  if (filters.locations !== undefined) next.locations = filters.locations;
  if (filters.industries !== undefined) next.industries = filters.industries;
  if (filters.occupations !== undefined) next.occupations = filters.occupations;
  if (filters.academic_programs !== undefined)
    next.academic_programs = filters.academic_programs;
  if (filters.graduation_years !== undefined)
    next.graduation_years = filters.graduation_years;
  if (filters.deadline_before !== undefined)
    next.deadline_before = filters.deadline_before;
  if (filters.target_grades !== undefined)
    next.target_grades = filters.target_grades;
  if (filters.obog_required === true) next.relation = "obog";
  else if (filters.career_supporter_required === true)
    next.relation = "career_supporter";
  return next;
}

function directRequest(
  surface: Extract<CastCareerSurface, keyof typeof DIRECT_SURFACE_KIND>,
  request: CastCareerSearchRequest,
): CastSearchRequest {
  const kind = DIRECT_SURFACE_KIND[surface];
  if (!kind) throw new Error("direct surface is unavailable");
  return {
    kind,
    filters: safeSearchFilters(request.filters),
    exhaustive: request.exhaustive === true,
  };
}

function toSourceItem(
  surface: CastCareerSurface,
  item: CastSearchItem,
  sourceUrl: string | null,
): CastCareerSourceItem {
  return {
    result_ref: randomRef("result"),
    surface,
    title: compact(item.title, 240),
    company_name: compact(item.company_name, 240) || null,
    dates: [],
    deadline: item.deadline,
    locations: unique(item.locations),
    industries: unique(item.industry),
    occupations: unique(item.occupations),
    academic_programs: unique(item.academic_programs),
    graduation_years:
      item.graduation_year === null ? [] : [item.graduation_year],
    relation_flags: unique(item.relation_flags),
    local_summary:
      compact(item.local_summary, 1000)
        .replace(/https?:\/\/\S+/giu, "")
        .replace(/[\w.+-]+@[\w.-]+\.[A-Z]{2,}/giu, "")
        .trim() || null,
    source_url: sourceUrl,
  };
}

function statusFromSearch(
  result: CastSearchLocalResult,
): CastCareerSourceStatus {
  return result.status === "known" ? "known" : result.status;
}

function searchSurfaceResult(
  surface: CastCareerSurface,
  result: CastSearchLocalResult,
  sourceUrl: string | null,
): CastCareerSurfaceResult {
  if (result.status !== "known") {
    return {
      surface,
      status: statusFromSearch(result),
      total_count: null,
      returned_count: 0,
      coverage: null,
      items: [],
      reason_code: result.reason_code,
      evidence_ids: [],
    };
  }
  return {
    surface,
    status: "known",
    total_count: result.total_count,
    returned_count: result.typed_items.length,
    coverage: {
      mode: result.coverage.mode,
      fetched_pages: result.coverage.fetched_pages,
      page_size: result.coverage.page_size,
    },
    items: result.typed_items.map((item) =>
      toSourceItem(surface, item, sourceUrl),
    ),
    reason_code: null,
    evidence_ids: result.local_evidence.map((evidence) => evidence.evidence_id),
  };
}

function pageText(element: Element | null | undefined, limit = 2000): string {
  if (!element) return "";
  const clone = element.cloneNode(true) as Element;
  clone
    .querySelectorAll(
      "script,style,noscript,template,[hidden],[aria-hidden='true'],input,textarea,select,button",
    )
    .forEach((node) => {
      node.remove();
    });
  return compact(clone.textContent, limit);
}

function isLoginDocument(document: Document): boolean {
  return Boolean(
    document.querySelector('input[type="password"]') ||
      /ログイン|セッション.*(?:切れ|期限)|再認証/u.test(
        `${document.title} ${pageText(document.body, 500)}`,
      ),
  );
}

function strictCastUrl(value: string, path: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === CAST_ORIGIN &&
      url.pathname === path &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function formDataFromForm(form: HTMLFormElement): FormData {
  const data = new FormData();
  form
    .querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >("input,select,textarea")
    .forEach((element) => {
      const name = element.name.trim();
      if (!name || element.disabled) return;
      if (element.tagName.toLowerCase() === "input") {
        const input = element as HTMLInputElement;
        if (
          (input.type === "checkbox" || input.type === "radio") &&
          !input.checked
        )
          return;
        if (["submit", "button", "file", "reset"].includes(input.type)) return;
        data.append(name, input.value);
      } else if (element.tagName.toLowerCase() === "select") {
        const select = element as HTMLSelectElement;
        Array.from(select.selectedOptions).forEach((option) => {
          data.append(name, option.value);
        });
      } else {
        data.append(name, element.value);
      }
    });
  return data;
}

function responseFailure(
  response: Response,
): { status: CastCareerSourceStatus; reason_code: string } | null {
  if (response.status === 401 || response.status === 403)
    return { status: "reauth_required", reason_code: "session_expired" };
  if (response.status === 404)
    return { status: "unavailable", reason_code: "not_found" };
  if (response.status === 429)
    return { status: "rate_limited", reason_code: "cast_rate_limited" };
  if (response.status >= 500)
    return { status: "unavailable", reason_code: "cast_server_error" };
  if (!response.ok)
    return { status: "unavailable", reason_code: "cast_http_error" };
  return null;
}

async function fetchCastDocument(
  url: string,
  init: RequestInit,
): Promise<
  | { document: Document; url: string }
  | { error: { status: CastCareerSourceStatus; reason_code: string } }
> {
  try {
    const response = await fetch(url, {
      ...init,
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
    });
    const failure = responseFailure(response);
    if (failure) return { error: failure };
    const finalUrl = response.url || url;
    const document = new DOMParser().parseFromString(
      await response.text(),
      "text/html",
    );
    if (isLoginDocument(document))
      return {
        error: { status: "reauth_required", reason_code: "login_required" },
      };
    return { document, url: finalUrl };
  } catch {
    return {
      error: { status: "unavailable", reason_code: "cast_network_error" },
    };
  }
}

interface CompanyReference {
  name: string;
  companyCode: string;
  relationFlags: string[];
}

function companyReferences(document: Document): CompanyReference[] {
  const seen = new Set<string>();
  const references: CompanyReference[] = [];
  for (const anchor of Array.from(
    document.querySelectorAll<HTMLAnchorElement>("a[data-companycode]"),
  )) {
    const companyCode = anchor.getAttribute("data-companycode")?.trim();
    const name = compact(anchor.textContent, 240);
    if (
      !companyCode ||
      !/^\d{1,20}$/u.test(companyCode) ||
      !name ||
      seen.has(companyCode)
    )
      continue;
    seen.add(companyCode);
    const parentText = pageText(
      anchor.closest("tr,.panel,.row,li") ?? anchor,
      1600,
    );
    const relationFlags = [
      ["job", /求人情報/u],
      ["internship", /インターンシップ/u],
      ["company_session", /会社説明会/u],
      ["hiring_record", /採用実績/u],
      ["obog", /OB.?OG/u],
      ["career_supporter", /就活サポーター/u],
      ["selection_report", /入社試験情報/u],
    ] as const;
    const enabledRelationFlags = relationFlags
      .filter(([, marker]) => marker.test(parentText))
      .map(([flag]) => flag);
    references.push({ name, companyCode, relationFlags: enabledRelationFlags });
    if (references.length >= COMPANY_DETAIL_LIMIT) break;
  }
  return references;
}

function setKnownField(
  data: FormData,
  form: HTMLFormElement,
  name: string,
  value: string,
): void {
  const hasField = Array.from(form.querySelectorAll("[name]")).some(
    (element) => element.getAttribute("name") === name,
  );
  if (hasField) data.set(name, value);
}

async function readCompanyHistory(
  reference: CompanyReference,
  companyDocument: Document,
): Promise<
  | { status: "known"; history: CastHistoryLocalSnapshot; detailUrl: string }
  | { status: CastCareerSourceStatus; reason_code: string }
> {
  const form = Array.from(
    companyDocument.querySelectorAll<HTMLFormElement>("form"),
  ).find((candidate) => {
    try {
      return isCastCompanyDetailUrl(
        new URL(
          candidate.getAttribute("action") || CAST_ORIGIN,
          CAST_ORIGIN,
        ).toString(),
      );
    } catch {
      return false;
    }
  });
  if (!form)
    return {
      status: "form_changed",
      reason_code: "company_detail_form_missing",
    };
  const data = formDataFromForm(form);
  setKnownField(data, form, "companyCode", reference.companyCode);
  for (const field of [
    "jobOfferTabActive",
    "companySessionTabActive",
    "internshipTabActive",
    "employmentTabActive",
    "companyObogTabActive",
    "careerAdviserTabActive",
    "companyExamTabActive",
  ]) {
    setKnownField(
      data,
      form,
      field,
      field === "employmentTabActive" || field === "companyExamTabActive"
        ? "active"
        : "",
    );
  }
  const detail = await fetchCastDocument(
    `${CAST_ORIGIN}/career/company_detail_view`,
    {
      method: "POST",
      body: data,
    },
  );
  if ("error" in detail) return detail.error;
  if (!isCastCompanyDetailUrl(detail.url))
    return {
      status: "form_changed",
      reason_code: "company_detail_unexpected_path",
    };
  const detailForm = Array.from(
    detail.document.querySelectorAll<HTMLFormElement>("form"),
  ).find((candidate) => candidate.querySelector('[name="companyCode"]'));
  if (!detailForm)
    return {
      status: "form_changed",
      reason_code: "company_detail_state_missing",
    };
  const fragmentData = formDataFromForm(detailForm);
  setKnownField(fragmentData, detailForm, "companyCode", reference.companyCode);
  const fragments: Document[] = [];
  for (const path of [
    "/career/get/employmentSub",
    "/career/get/companyExamSub",
  ]) {
    const fragment = await fetchCastDocument(CAST_ORIGIN + path, {
      method: "POST",
      body: fragmentData,
    });
    if ("error" in fragment) return fragment.error;
    if (!strictCastUrl(fragment.url, path)) {
      return {
        status: "form_changed",
        reason_code: "company_fragment_unexpected_path",
      };
    }
    fragments.push(fragment.document);
  }
  const merged = new DOMParser().parseFromString(
    `<!doctype html><html><body>${detail.document.body.innerHTML}</body></html>`,
    "text/html",
  );
  const sections = ["employment", "company_exam_entry"];
  fragments.forEach((fragment, index) => {
    const section = fragment.querySelector(`#${sections[index]}`);
    if (section) merged.body.appendChild(merged.importNode(section, true));
  });
  const history = extractCastHistory(
    merged,
    `${CAST_ORIGIN}/career/company_detail_view`,
  );
  if (!history)
    return {
      status: "form_changed",
      reason_code: "company_history_structure_changed",
    };
  return {
    status: "known",
    history,
    detailUrl: `${CAST_ORIGIN}/career/company_detail_view`,
  };
}

function historyItems(
  surface: "hiring_record" | "selection_report",
  history: CastHistoryLocalSnapshot,
  relationFlags: string[],
): CastCareerSourceItem[] {
  const records =
    surface === "hiring_record"
      ? history.hiring_records
      : history.selection_reports;
  const graduationYears = records
    .map((record) => record.graduation_date?.slice(0, 4))
    .filter((year): year is string => Boolean(year))
    .map(Number)
    .filter(Number.isInteger);
  const academic = records
    .flatMap((record) => [record.academic_field, record.department])
    .filter((value): value is string => Boolean(value));
  const occupations = records
    .map((record) => ("job_type" in record ? record.job_type : null))
    .filter((value): value is string => Boolean(value));
  const count = records.length;
  return [
    {
      result_ref: randomRef(surface),
      surface,
      title: `${history.company_name} ${surface === "hiring_record" ? "採用実績" : "入社試験・選考記録"}`,
      company_name: history.company_name,
      dates: records
        .map((record) => record.graduation_date)
        .filter((date): date is string => Boolean(date)),
      deadline: null,
      locations: [],
      industries: [],
      occupations: unique(occupations),
      academic_programs: unique(academic),
      graduation_years: unique(graduationYears.map(String)).map(Number),
      relation_flags: unique([
        ...relationFlags,
        "hiring_record",
        ...(surface === "selection_report" ? ["selection_report"] : []),
        ...(history.obog_available ? ["obog"] : []),
      ]),
      local_summary: `${count}件を確認${surface === "selection_report" ? `、参考ES ${history.selection_reports.filter((report) => report.has_reference_es).length}件` : ""}`,
      source_url: `${CAST_ORIGIN}/career/company_detail_view`,
    },
  ];
}

function counselingItems(document: Document): CastCareerSourceItem[] {
  const rows = Array.from(document.querySelectorAll("table tr,.row")).filter(
    (row) => pageText(row, 600),
  );
  return rows
    .flatMap((row): CastCareerSourceItem[] => {
      const text = pageText(row, 1000);
      if (!/[○◯]/u.test(text) || !/20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/u.test(text))
        return [];
      const dateMatch = text.match(/20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/u)?.[0];
      const normalizedDate = dateMatch
        ? dateMatch.replace(/\//gu, "-").replace(/\.(?=\d)/gu, "-")
        : null;
      const time =
        text.match(/\d{1,2}:\d{2}\s*[〜～-]?\s*\d{0,2}:?\d{0,2}/u)?.[0] ?? null;
      const category =
        compact(
          row.closest("section,form")?.querySelector("h1,h2,h3,legend,label")
            ?.textContent,
          160,
        ) || "キャリア相談";
      return [
        {
          result_ref: randomRef("counseling"),
          surface: "counseling",
          title: category,
          company_name: null,
          dates: [
            compact(`${normalizedDate ?? dateMatch ?? ""} ${time ?? ""}`, 80),
          ].filter(Boolean),
          deadline: null,
          locations: [],
          industries: [],
          occupations: [],
          academic_programs: [],
          graduation_years: [],
          relation_flags: [],
          local_summary: "空き枠（予約操作は行っていません）",
          source_url: CAST_ORIGIN + COUNSELING_PATH,
        },
      ];
    })
    .slice(0, MAX_ITEMS);
}

async function readCounseling(
  request: CastCareerSearchRequest,
): Promise<CastCareerSurfaceResult> {
  if (!strictCastUrl(CAST_ORIGIN + COUNSELING_PATH, COUNSELING_PATH)) {
    return {
      surface: "counseling",
      status: "unavailable",
      total_count: null,
      returned_count: 0,
      coverage: null,
      items: [],
      reason_code: "counseling_route_not_allowlisted",
      evidence_ids: [],
    };
  }
  const page = await fetchCastDocument(CAST_ORIGIN + COUNSELING_PATH, {
    method: "GET",
  });
  if ("error" in page) {
    return {
      surface: "counseling",
      status: page.error.status,
      total_count: null,
      returned_count: 0,
      coverage: null,
      items: [],
      reason_code: page.error.reason_code,
      evidence_ids: [],
    };
  }
  if (!strictCastUrl(page.url, COUNSELING_PATH)) {
    return {
      surface: "counseling",
      status: "form_changed",
      total_count: null,
      returned_count: 0,
      coverage: null,
      items: [],
      reason_code: "counseling_unexpected_path",
      evidence_ids: [],
    };
  }
  const text = pageText(page.document.body, 5000);
  if (!/相談|カウンセ/u.test(text)) {
    return {
      surface: "counseling",
      status: "form_changed",
      total_count: null,
      returned_count: 0,
      coverage: null,
      items: [],
      reason_code: "counseling_marker_missing",
      evidence_ids: [],
    };
  }
  const items = counselingItems(page.document).slice(0, request.limit);
  return {
    surface: "counseling",
    status: "known",
    total_count: items.length,
    returned_count: items.length,
    coverage: { mode: "page", fetched_pages: 1, page_size: PAGE_SIZE },
    items,
    reason_code: null,
    evidence_ids: [randomRef("evidence")],
  };
}

function supportLinks(
  document: Document,
  requested: readonly CastCareerSurface[],
): CastCareerSupportLink[] {
  const snapshot = extractCastSupportResources(document, CAST_TOP_URL);
  if (!snapshot) return [];
  const links: CastCareerSupportLink[] = [];
  const seen = new Set<string>();
  for (const resource of snapshot.resources) {
    const kind: CastCareerSupportLink["kind"] =
      resource.kind === "video"
        ? "recording"
        : resource.kind === "event"
          ? "career_event"
          : "recording";
    if (!requested.includes(kind)) continue;
    if (kind === "recording" && !/録画|動画|講座/u.test(resource.title))
      continue;
    if (
      kind === "career_event" &&
      !/説明会|イベント|スケジュール|会社見学会/u.test(resource.title)
    )
      continue;
    if (!isCastSupportPageUrl(resource.url, kind)) continue;
    const url =
      kind === "recording" ? CAST_NOTION_RECORDING_URL : CAST_NOTION_EVENT_URL;
    if (seen.has(kind)) continue;
    seen.add(kind);
    links.push({ kind, url });
  }
  return links;
}

function supportItems(
  kind: Extract<CastCareerSurface, "recording" | "career_event">,
  snapshot: CastSupportPageSnapshot,
  limit: number,
): CastCareerSourceItem[] {
  return snapshot.items
    .slice(0, Math.min(limit, MAX_SUPPORT_ITEMS))
    .map((item: CastSupportPageItem) => ({
      result_ref: randomRef(kind),
      surface: kind,
      title: compact(item.title, 240),
      company_name: null,
      dates: item.date ? [item.date] : [],
      deadline: null,
      locations: [],
      industries: [],
      occupations: [],
      academic_programs: [],
      graduation_years: [],
      relation_flags: [],
      local_summary:
        compact([item.target, item.summary].filter(Boolean).join(" "), 800) ||
        null,
      source_url: snapshot.source_url,
    }));
}

function pendingSupportResult(
  surface: Extract<CastCareerSurface, "recording" | "career_event">,
): CastCareerSurfaceResult {
  return {
    surface,
    status: "partial",
    total_count: null,
    returned_count: 0,
    coverage: null,
    items: [],
    reason_code: "support_read_pending",
    evidence_ids: [],
  };
}

function overallStatus(
  results: readonly CastCareerSurfaceResult[],
): CastCareerSourceStatus {
  const known = results.filter((result) => result.status === "known").length;
  const failed = results.filter((result) => result.status !== "known").length;
  if (known > 0 && failed > 0) return "partial";
  if (known > 0) return "known";
  return results[0]?.status ?? "unavailable";
}

function collectReasons(results: readonly CastCareerSurfaceResult[]): string[] {
  return unique(
    results
      .map((result) => result.reason_code)
      .filter((value): value is string => Boolean(value)),
    50,
  );
}

function replaceSurfaceResult(
  results: CastCareerSurfaceResult[],
  replacement: CastCareerSurfaceResult,
): void {
  const index = results.findIndex(
    (result) => result.surface === replacement.surface,
  );
  if (index < 0) results.push(replacement);
  else results[index] = replacement;
}

function makeLocalResult(
  request: CastCareerSearchRequest,
  results: CastCareerSurfaceResult[],
  links: CastCareerSupportLink[],
): CastCareerLocalResult {
  return {
    schema_version: CAST_CAREER_SOURCE_SCHEMA_VERSION,
    status: overallStatus(results),
    query: compact(request.query, 1000),
    surfaces: request.surfaces,
    surface_results: results,
    items: results.flatMap((result) => result.items).slice(0, MAX_ITEMS),
    local_evidence: results.flatMap((result) =>
      result.evidence_ids.map((evidence_id) => ({
        evidence_id,
        title: `CAST ${result.surface}`,
        locator: `orbit-cast://career/${evidence_id}`,
      })),
    ),
    discovered_support_links: links,
    reason_codes: collectReasons(results),
  };
}

/** Execute the nine read-only CAST source surfaces from inside the CAST origin. */
export async function runCastCareerSourceSearch(
  request: CastCareerSearchRequest,
): Promise<CastCareerLocalResult> {
  if (!isCastCareerSearchRequest(request)) {
    return {
      schema_version: CAST_CAREER_SOURCE_SCHEMA_VERSION,
      status: "unavailable",
      query: "",
      surfaces: [],
      surface_results: [],
      items: [],
      local_evidence: [],
      discovered_support_links: [],
      reason_codes: ["request_rejected"],
    };
  }
  if (typeof window === "undefined" || window.location.origin !== CAST_ORIGIN) {
    return makeLocalResult(
      request,
      request.surfaces.map((surface) => ({
        surface,
        status: "unavailable",
        total_count: null,
        returned_count: 0,
        coverage: null,
        items: [],
        reason_code: "unexpected_origin",
        evidence_ids: [],
      })),
      [],
    );
  }
  const results: CastCareerSurfaceResult[] = [];
  const directDocuments = new Map<CastCareerSurface, Document>();
  for (const surface of request.surfaces) {
    const kind = DIRECT_SURFACE_KIND[surface];
    if (!kind) continue;
    let resultDocument: Document | null = null;
    const result = await runCastSearch(directRequest(surface, request), {
      maxPages: request.exhaustive === true ? 100 : 3,
      onDocument: (document, url) => {
        try {
          if (
            new URL(url).pathname ===
            `/career/${kind === "job" ? "job_offer_search/search" : kind === "internship" ? "internship_search" : kind === "company_session" ? "company_session_search" : kind === "company" ? "company_search/search" : "adopters_search/search"}`
          ) {
            resultDocument = document;
          }
        } catch {
          // The search transport validates the final URL; no fallback here.
        }
      },
    });
    if (resultDocument) directDocuments.set(surface, resultDocument);
    const definitionUrl =
      kind === "job"
        ? `${CAST_ORIGIN}/career/job_offer_search/search`
        : kind === "internship"
          ? `${CAST_ORIGIN}/career/internship_search`
          : kind === "company_session"
            ? `${CAST_ORIGIN}/career/company_session_search`
            : kind === "company"
              ? `${CAST_ORIGIN}/career/company_search/search`
              : `${CAST_ORIGIN}/career/adopters_search/search`;
    results.push(searchSurfaceResult(surface, result, definitionUrl));
  }
  if (request.surfaces.includes("counseling")) {
    results.push(await readCounseling(request));
  }
  const needsCompanyDetails =
    request.surfaces.includes("hiring_record") ||
    request.surfaces.includes("selection_report") ||
    request.surfaces.includes("company");
  if (needsCompanyDetails) {
    let companyResult = results.find((result) => result.surface === "company");
    let companyDocument = directDocuments.get("company") ?? null;
    if (!companyDocument) {
      const result = await runCastSearch(
        {
          kind: "company",
          filters: {
            ...safeSearchFilters(request.filters),
            relation: request.surfaces.includes("selection_report")
              ? "entrance_exam"
              : "hiring_record",
          },
          exhaustive: false,
        },
        {
          maxPages: request.exhaustive === true ? 100 : 3,
          onDocument: (document) => {
            companyDocument = document;
          },
        },
      );
      if (result.status !== "known") {
        for (const surface of ["hiring_record", "selection_report"] as const) {
          if (request.surfaces.includes(surface)) {
            results.push({
              surface,
              status: statusFromSearch(result),
              total_count: null,
              returned_count: 0,
              coverage: null,
              items: [],
              reason_code: result.reason_code,
              evidence_ids: [],
            });
          }
        }
      } else if (companyDocument) {
        companyResult = searchSurfaceResult(
          "company",
          result,
          `${CAST_ORIGIN}/career/company_search/search`,
        );
      }
    }
    const references = companyDocument
      ? companyReferences(companyDocument)
      : [];
    if (
      references.length === 0 &&
      request.surfaces.some(
        (surface) =>
          surface === "hiring_record" || surface === "selection_report",
      )
    ) {
      for (const surface of ["hiring_record", "selection_report"] as const) {
        if (
          request.surfaces.includes(surface) &&
          !results.some((result) => result.surface === surface)
        ) {
          results.push({
            surface,
            status: "form_changed",
            total_count: null,
            returned_count: 0,
            coverage: null,
            items: [],
            reason_code: "company_relation_link_missing",
            evidence_ids: [],
          });
        }
      }
    }
    if (
      companyResult &&
      request.surfaces.includes("company") &&
      companyDocument
    ) {
      const relationByName = new Map(
        references.map((reference) => [
          reference.name,
          reference.relationFlags,
        ]),
      );
      companyResult.items = companyResult.items.map((item) => ({
        ...item,
        relation_flags: unique([
          ...item.relation_flags,
          ...(relationByName.get(item.company_name ?? item.title) ?? []),
        ]),
      }));
    }
    for (const surface of ["hiring_record", "selection_report"] as const) {
      if (!request.surfaces.includes(surface) || !companyDocument) continue;
      const detailItems: CastCareerSourceItem[] = [];
      let failure: {
        status: CastCareerSourceStatus;
        reason_code: string;
      } | null = null;
      for (const reference of references) {
        const history = await readCompanyHistory(reference, companyDocument);
        if (!("history" in history)) {
          failure = history;
          continue;
        }
        detailItems.push(
          ...historyItems(surface, history.history, reference.relationFlags),
        );
      }
      if (detailItems.length > 0) {
        replaceSurfaceResult(results, {
          surface,
          status: failure ? "partial" : "known",
          total_count: detailItems.length,
          returned_count: detailItems.length,
          coverage: {
            mode: failure ? "partial" : "page",
            fetched_pages: references.length,
            page_size: COMPANY_DETAIL_LIMIT,
          },
          items: detailItems.slice(0, request.limit),
          reason_code: failure?.reason_code ?? null,
          evidence_ids: [randomRef("evidence")],
        });
      } else if (!results.some((result) => result.surface === surface)) {
        results.push({
          surface,
          status: failure?.status ?? "unavailable",
          total_count: null,
          returned_count: 0,
          coverage: null,
          items: [],
          reason_code: failure?.reason_code ?? "company_detail_unavailable",
          evidence_ids: [],
        });
      }
    }
  }
  const needsSupport =
    request.surfaces.includes("recording") ||
    request.surfaces.includes("career_event");
  let links: CastCareerSupportLink[] = [];
  if (needsSupport) {
    const top = await fetchCastDocument(CAST_TOP_URL, { method: "GET" });
    if ("error" in top) {
      for (const surface of ["recording", "career_event"] as const) {
        if (!request.surfaces.includes(surface)) continue;
        results.push({
          surface,
          status: top.error.status,
          total_count: null,
          returned_count: 0,
          coverage: null,
          items: [],
          reason_code: top.error.reason_code,
          evidence_ids: [],
        });
      }
    } else {
      links = supportLinks(top.document, request.surfaces);
    }
    if (!("error" in top)) {
      for (const surface of ["recording", "career_event"] as const) {
        if (!request.surfaces.includes(surface)) continue;
        results.push(
          links.some((link) => link.kind === surface)
            ? pendingSupportResult(surface)
            : {
                surface,
                status: "unavailable",
                total_count: null,
                returned_count: 0,
                coverage: null,
                items: [],
                reason_code: "support_link_not_found",
                evidence_ids: [],
              },
        );
      }
    }
  }
  return makeLocalResult(request, results, links);
}

/** Merge support-page data read by the service worker's inactive tab. */
export function mergeCastCareerSupportLocalResult(
  local: CastCareerLocalResult,
  supportResults: readonly CastCareerSupportRuntimeResult[],
  limit = 20,
): CastCareerLocalResult {
  const nextResults = local.surface_results.map((result) => ({
    ...result,
    items: [...result.items],
  }));
  for (const support of supportResults) {
    const surface = support.kind;
    const index = nextResults.findIndex((result) => result.surface === surface);
    const page = support.result;
    if (page.status !== "known") {
      if (index >= 0) {
        const current = nextResults[index];
        if (current) {
          current.status =
            page.status === "reauth_required"
              ? "reauth_required"
              : "unavailable";
          current.reason_code = page.reason_code;
        }
      }
      continue;
    }
    const items = supportItems(surface, page, limit);
    const replacement: CastCareerSurfaceResult = {
      surface,
      status: "known",
      total_count: page.items.length,
      returned_count: items.length,
      coverage: { mode: "page", fetched_pages: 1, page_size: PAGE_SIZE },
      items,
      reason_code: null,
      evidence_ids: [randomRef("evidence")],
    };
    if (index >= 0) nextResults[index] = replacement;
    else nextResults.push(replacement);
  }
  const final = makeLocalResult(
    { query: local.query, surfaces: local.surfaces, filters: {}, limit },
    nextResults,
    local.discovered_support_links,
  );
  return final;
}

/** Content-script-only entry point used by the service worker. */
export function handleCastCareerInternalMessage(
  request: CastCareerSearchRequest,
): Promise<CastCareerLocalResult> {
  return runCastCareerSourceSearch(request);
}

/** Narrow helper used by the service worker tests for Notion fixture pages. */
export function readCastSupportFixture(
  document: Document,
  url: string,
  kind: CastSupportPageKind,
): CastSupportPageReadResult {
  return extractCastSupportPage(document, url, kind);
}
