import {
  type CastOpportunity,
  type CastOpportunityKind,
  extractCastOpportunities,
} from "./cast-opportunities-reader";

/** The only CAST search paths observed in the authenticated UI. */
export const CAST_SEARCH_ORIGIN = "https://shibaura.pita.services";

export type CastSearchKind =
  | "job"
  | "internship"
  | "company_session"
  | "company"
  | "hiring_record";

export type CastSearchStatus =
  | "known"
  | "reauth_required"
  | "form_changed"
  | "rate_limited"
  | "unavailable";

export interface CastSearchFilters {
  company_name?: string;
  new_only?: boolean;
  year?: number;
  graduation_years?: number[];
  academic_programs?: string[];
  industries?: string[];
  relation?:
    | "hiring_record"
    | "obog"
    | "career_supporter"
    | "company_session"
    | "internship"
    | "entrance_exam";
  occupations?: string[];
  locations?: string[];
  deadline_before?: string;
  include_closed?: boolean;
  application_method?: "free" | "recommendation";
  target_grades?: string[];
  duration?: string[];
  event_start?: string;
  event_end?: string;
  advisor?: string;
  faculty?: string;
}

export type CastSearchSortKey =
  | "company_name"
  | "hiring_count"
  | "graduation_year"
  | "deadline";

export interface CastSearchSort {
  key: CastSearchSortKey;
  direction: "asc" | "desc";
}

export interface CastSearchRequest {
  kind: CastSearchKind;
  filters: CastSearchFilters;
  sort?: CastSearchSort;
  /** The cursor is opaque and only valid while the CAST content script lives. */
  cursor?: string | null;
  exhaustive?: boolean;
}

export interface CastSearchAppliedFilters {
  kind: CastSearchKind;
  filters: CastSearchFilters;
  sort: CastSearchSort | null;
  graduation_years_defaulted: boolean;
}

export interface CastSearchItem {
  /** Deliberately opaque; never derived from a CAST company code. */
  item_ref: string;
  kind: CastSearchKind;
  title: string;
  company_name: string | null;
  industry: string[];
  locations: string[];
  occupations: string[];
  academic_programs: string[];
  /** Present on opportunity results when the CAST form exposes eligibility. */
  target_grades?: string[];
  deadline: string | null;
  graduation_year: number | null;
  hiring_count: number | null;
  relation_flags: string[];
  /** Local-only supporting text. It is not part of the agent projection. */
  local_summary: string | null;
}

export interface CastSearchLocalEvidence {
  evidence_id: string;
  title: string;
  locator: string;
}

export interface CastSearchCoverage {
  mode: "page" | "complete" | "partial";
  page_size: number;
  fetched_pages: number;
  total_pages: number | null;
}

export interface CastSearchLocalKnownResult {
  status: "known";
  applied_filters: CastSearchAppliedFilters;
  total_count: number;
  coverage: CastSearchCoverage;
  page: number;
  next_cursor: string | null;
  typed_items: CastSearchItem[];
  local_evidence: CastSearchLocalEvidence[];
}

export interface CastSearchErrorResult {
  status: Exclude<CastSearchStatus, "known">;
  reason_code: string;
}

export type CastSearchLocalResult =
  | CastSearchLocalKnownResult
  | CastSearchErrorResult;

export interface CastSearchAgentProjection {
  schema_version: "v1";
  status: CastSearchStatus;
  applied_filters: CastSearchAppliedFilters | null;
  total_count: number;
  returned_count: number;
  coverage: CastSearchCoverage | null;
  /** Only aggregate cells with at least five records cross the model boundary. */
  anonymous_aggregates: Array<{
    dimension: "industry" | "location" | "graduation_year";
    value: string;
    count: number;
  }>;
  evidence_ids: string[];
  reason_code: string | null;
}

interface SearchDefinition {
  kind: CastSearchKind;
  entryPath: string;
  entryQuery: string;
  actionPath: string;
  /** HTML form action(s) observed before the JavaScript submit endpoint. */
  formPaths?: readonly string[];
  resultPath: string;
  markers: RegExp[];
}

export const CAST_SEARCH_DEFINITIONS: Readonly<
  Record<CastSearchKind, SearchDefinition>
> = {
  job: {
    kind: "job",
    entryPath: "/career/job_offer_search",
    entryQuery: "",
    actionPath: "/career/job_offer_search",
    resultPath: "/career/job_offer_search/search",
    markers: [/求人/u, /応募/u],
  },
  internship: {
    kind: "internship",
    entryPath: "/career/internship_search",
    entryQuery: "",
    actionPath: "/career/internship_search",
    resultPath: "/career/internship_search",
    markers: [/インターンシップ/u, /実施/u],
  },
  company_session: {
    kind: "company_session",
    entryPath: "/career/company_session_search",
    entryQuery: "",
    actionPath: "/career/company_session_search",
    resultPath: "/career/company_session_search",
    markers: [/会社説明会/u, /開催/u],
  },
  company: {
    kind: "company",
    entryPath: "/career/company_search",
    entryQuery: "common_header=on",
    // The live CAST form is populated without an HTML action. Its verified
    // submit handler posts to the `/search` endpoint; posting to the entry
    // page returns the form again and makes history joins look empty.
    actionPath: "/career/company_search/search",
    formPaths: ["/career/company_search", "/career/company_search/search"],
    resultPath: "/career/company_search/search",
    markers: [/企業検索/u, /OB.?OG/u, /就活サポーター/u],
  },
  hiring_record: {
    kind: "hiring_record",
    entryPath: "/career/adopters_search",
    entryQuery: "common_header=on",
    actionPath: "/career/adopters_search",
    resultPath: "/career/adopters_search/search",
    markers: [/採用実績/u, /卒業年月/u, /卒業年度/u],
  },
};

const SEARCH_KINDS = Object.keys(CAST_SEARCH_DEFINITIONS) as CastSearchKind[];
const PAGE_SIZE = 10;
const MAX_PAGE_COUNT = 100;
const MAX_ITEMS = 1000;
const MAX_TEXT = 1000;
const cursorPages = new Map<string, { kind: CastSearchKind; page: number }>();

const SORT_FIELD_VALUES: Readonly<Record<CastSearchSortKey, string>> = {
  company_name: "company_name",
  hiring_count: "all_men",
  graduation_year: "graduation_year",
  deadline: "deadline",
};

function compact(value: string | null | undefined, limit = MAX_TEXT): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

function normal(value: string): string {
  return compact(value, 300).toLocaleLowerCase("ja-JP");
}

function unique(values: readonly string[], limit = 30): string[] {
  return Array.from(
    new Set(values.map((value) => compact(value, 200)).filter(Boolean)),
  ).slice(0, limit);
}

function asSafeDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^20\d{2}-\d{2}-\d{2}$/u.exec(value);
  if (!match) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? undefined : value;
}

function isKind(value: unknown): value is CastSearchKind {
  return (
    typeof value === "string" && SEARCH_KINDS.includes(value as CastSearchKind)
  );
}

function isSafeString(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= limit
  );
}

function isStringArray(value: unknown, limit: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= limit &&
    value.every(
      (item) =>
        typeof item === "string" &&
        item.trim().length > 0 &&
        item.length <= 200,
    )
  );
}

/** Validate the public semantic request; field names and URLs are not accepted. */
export function isCastSearchRequest(
  value: unknown,
): value is CastSearchRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).some(
      (key) =>
        !["kind", "filters", "sort", "cursor", "exhaustive"].includes(key),
    )
  ) {
    return false;
  }
  if (!isKind(candidate.kind)) return false;
  if (
    !candidate.filters ||
    typeof candidate.filters !== "object" ||
    Array.isArray(candidate.filters)
  ) {
    return false;
  }
  if (
    candidate.cursor !== undefined &&
    candidate.cursor !== null &&
    !isSafeString(candidate.cursor, 200)
  ) {
    return false;
  }
  if (
    candidate.exhaustive !== undefined &&
    typeof candidate.exhaustive !== "boolean"
  )
    return false;
  if (candidate.sort !== undefined && candidate.sort !== null) {
    if (typeof candidate.sort !== "object" || Array.isArray(candidate.sort))
      return false;
    const sort = candidate.sort as Record<string, unknown>;
    if (
      Object.keys(sort).some((key) => !["key", "direction"].includes(key)) ||
      !["company_name", "hiring_count", "graduation_year", "deadline"].includes(
        sort.key as string,
      ) ||
      !["asc", "desc"].includes(sort.direction as string)
    ) {
      return false;
    }
  }
  const filters = candidate.filters as Record<string, unknown>;
  const allowed = new Set([
    "company_name",
    "new_only",
    "year",
    "graduation_years",
    "academic_programs",
    "industries",
    "relation",
    "occupations",
    "locations",
    "deadline_before",
    "include_closed",
    "application_method",
    "target_grades",
    "duration",
    "event_start",
    "event_end",
    "advisor",
    "faculty",
  ]);
  if (Object.keys(filters).some((key) => !allowed.has(key))) return false;
  const listFilterKeys = new Set([
    "graduation_years",
    "academic_programs",
    "industries",
    "occupations",
    "locations",
    "target_grades",
    "duration",
  ]);
  if (
    Object.entries(filters).some(
      ([key, value]) => listFilterKeys.has(key) && !Array.isArray(value),
    )
  ) {
    return false;
  }
  if (
    filters.company_name !== undefined &&
    !isSafeString(filters.company_name, 200)
  )
    return false;
  if (filters.new_only !== undefined && typeof filters.new_only !== "boolean")
    return false;
  if (
    filters.year !== undefined &&
    (typeof filters.year !== "number" ||
      !Number.isInteger(filters.year) ||
      filters.year < 1995 ||
      filters.year > 2100)
  ) {
    return false;
  }
  if (
    filters.graduation_years !== undefined &&
    (!Array.isArray(filters.graduation_years) ||
      filters.graduation_years.length === 0 ||
      filters.graduation_years.length > 20 ||
      !filters.graduation_years.every(
        (year) =>
          typeof year === "number" &&
          Number.isInteger(year) &&
          year >= 1995 &&
          year <= 2100,
      ))
  ) {
    return false;
  }
  for (const key of [
    "academic_programs",
    "industries",
    "occupations",
    "locations",
    "target_grades",
    "duration",
  ]) {
    if (filters[key] !== undefined && !isStringArray(filters[key], 20))
      return false;
  }
  if (
    filters.relation !== undefined &&
    ![
      "hiring_record",
      "obog",
      "career_supporter",
      "company_session",
      "internship",
      "entrance_exam",
    ].includes(filters.relation as string)
  ) {
    return false;
  }
  for (const key of ["deadline_before", "event_start", "event_end"]) {
    if (
      filters[key] !== undefined &&
      (typeof filters[key] !== "string" ||
        asSafeDate(filters[key]) === undefined)
    )
      return false;
  }
  if (
    filters.include_closed !== undefined &&
    typeof filters.include_closed !== "boolean"
  )
    return false;
  if (
    filters.application_method !== undefined &&
    !["free", "recommendation"].includes(filters.application_method as string)
  )
    return false;
  if (filters.advisor !== undefined && !isSafeString(filters.advisor, 200))
    return false;
  if (filters.faculty !== undefined && !isSafeString(filters.faculty, 200))
    return false;
  return true;
}

function resultUrl(kind: CastSearchKind, value: string): boolean {
  const definition = CAST_SEARCH_DEFINITIONS[kind];
  try {
    const url = new URL(value);
    return (
      url.origin === CAST_SEARCH_ORIGIN &&
      url.pathname === definition.resultPath
    );
  } catch {
    return false;
  }
}

function entryUrl(kind: CastSearchKind): string {
  const definition = CAST_SEARCH_DEFINITIONS[kind];
  return `${CAST_SEARCH_ORIGIN}${definition.entryPath}${definition.entryQuery ? `?${definition.entryQuery}` : ""}`;
}

function isLoginPage(document: Document, url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== CAST_SEARCH_ORIGIN) return false;
    if (
      parsed.pathname === "/career/login" ||
      parsed.pathname === "/career/session_timeout"
    )
      return true;
  } catch {
    return false;
  }
  return Boolean(
    document.querySelector('input[type="password"]') ||
      /ログイン|セッション.*(切れ|期限)|再認証/u.test(
        compact(document.title, 200),
      ),
  );
}

interface FormControl {
  name: string;
  type: string;
  label: string;
  value: string;
  optionLabels: string[];
}

interface FormCatalog {
  form: HTMLFormElement;
  controls: FormControl[];
}

function isInputElement(element: Element): element is HTMLInputElement {
  return element.tagName.toLowerCase() === "input";
}

function isSelectElement(element: Element): element is HTMLSelectElement {
  return element.tagName.toLowerCase() === "select";
}

function isTextAreaElement(element: Element): element is HTMLTextAreaElement {
  return element.tagName.toLowerCase() === "textarea";
}

function labelForControl(control: Element): string {
  const id = control.getAttribute("id");
  if (id) {
    const label = Array.from(
      control.ownerDocument?.querySelectorAll("label") ?? [],
    ).find((candidate) => candidate.getAttribute("for") === id);
    if (label) return compact(label.textContent, 200);
  }
  const parent = control.closest(
    "label, .form-group, .form-row, .row, td, th, dt, dd",
  );
  return compact(parent?.textContent, 300);
}

function formAction(form: HTMLFormElement, base: string): URL | null {
  try {
    return new URL(form.getAttribute("action") || base, base);
  } catch {
    return null;
  }
}

/** Build a catalog from a real form without returning hidden values. */
export function collectCastSearchFormCatalog(
  document: Document,
  kind: CastSearchKind,
  pageUrl: string,
): FormCatalog | null {
  const definition = CAST_SEARCH_DEFINITIONS[kind];
  try {
    const page = new URL(pageUrl);
    if (
      page.origin !== CAST_SEARCH_ORIGIN ||
      page.pathname !== definition.entryPath
    )
      return null;
  } catch {
    return null;
  }
  const forms = Array.from(
    document.querySelectorAll<HTMLFormElement>("form"),
  ).filter((form) => {
    const action = formAction(form, pageUrl);
    const formPaths = definition.formPaths ?? [definition.actionPath];
    return (
      action?.origin === CAST_SEARCH_ORIGIN &&
      formPaths.includes(action.pathname)
    );
  });
  if (forms.length !== 1) return null;
  const form = forms[0];
  if (!form) return null;
  if (
    !definition.markers.some((marker) =>
      marker.test(compact(form.textContent, 5000)),
    )
  )
    return null;
  const controls = Array.from(
    form.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >("input,select,textarea"),
  ).flatMap((element): FormControl[] => {
    if (
      !(
        isInputElement(element) ||
        isSelectElement(element) ||
        isTextAreaElement(element)
      )
    ) {
      return [];
    }
    const name = element.getAttribute("name")?.trim() ?? "";
    if (
      !name ||
      element.type === "hidden" ||
      element.type === "password" ||
      element.disabled
    )
      return [];
    if (
      element.type === "submit" ||
      element.type === "button" ||
      element.type === "file"
    )
      return [];
    const optionLabels = isSelectElement(element)
      ? Array.from(element.options).map((option) =>
          compact(option.textContent, 200),
        )
      : [];
    return [
      {
        name,
        type: element.type,
        label: labelForControl(element),
        value: element.value,
        optionLabels,
      },
    ];
  });
  const catalog = { controls } as FormCatalog;
  Object.defineProperty(catalog, "form", {
    value: form,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return catalog;
}

function filterControls(catalog: FormCatalog, pattern: RegExp): FormControl[] {
  return catalog.controls.filter((control) =>
    pattern.test(normal(control.label)),
  );
}

function firstControl(
  catalog: FormCatalog,
  pattern: RegExp,
): FormControl | null {
  return filterControls(catalog, pattern)[0] ?? null;
}

function matchingOption(control: FormControl, query: string): string | null {
  const needle = normal(query);
  const index = control.optionLabels.findIndex((label) => {
    const value = normal(label);
    return value === needle || value.includes(needle) || needle.includes(value);
  });
  return index >= 0 ? (control.optionLabels[index] ?? null) : null;
}

function optionValue(
  form: HTMLFormElement,
  control: FormControl,
  label: string,
): string | null {
  const element = Array.from(form.querySelectorAll("select")).find(
    (candidate) =>
      isSelectElement(candidate) && candidate.name === control.name,
  );
  if (!element || !isSelectElement(element)) return null;
  const option = Array.from(element.options).find(
    (candidate) => compact(candidate.textContent, 200) === label,
  );
  return option?.value ?? null;
}

function formDataFromForm(form: HTMLFormElement): FormData {
  const data = new FormData();
  const controls = form.querySelectorAll<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >("input,select,textarea");
  controls.forEach((element) => {
    const name = element.getAttribute("name")?.trim() ?? "";
    if (!name || element.disabled) return;
    if (isInputElement(element)) {
      if (
        (element.type === "checkbox" || element.type === "radio") &&
        !element.checked
      )
        return;
      if (["submit", "button", "file", "reset"].includes(element.type)) return;
      data.append(name, element.value);
      return;
    }
    if (isSelectElement(element)) {
      Array.from(element.options)
        .filter((option) => option.selected)
        .forEach((option) => {
          data.append(name, option.value);
        });
      return;
    }
    data.append(name, element.value);
  });
  return data;
}

function appendText(
  data: FormData,
  catalog: FormCatalog,
  pattern: RegExp,
  value: string | undefined,
): boolean {
  if (!value) return true;
  const control = firstControl(catalog, pattern);
  if (!control) return false;
  if (control.optionLabels.length > 0) {
    const label = matchingOption(control, value);
    if (!label) return false;
    const option = optionValue(catalog.form, control, label);
    if (option === null) return false;
    data.set(control.name, option);
    return true;
  }
  data.set(control.name, compact(value, 200));
  return true;
}

function appendOptions(
  data: FormData,
  catalog: FormCatalog,
  pattern: RegExp,
  values: readonly string[] | undefined,
): boolean {
  if (!values || values.length === 0) return true;
  const controls = filterControls(catalog, pattern);
  if (controls.length === 0) return false;
  const selectControl = controls.find(
    (control) => control.optionLabels.length > 0,
  );
  if (selectControl) {
    const labels = values.map((value) => matchingOption(selectControl, value));
    if (labels.some((label) => label === null)) return false;
    data.delete(selectControl.name);
    for (const label of labels) {
      const option = label
        ? optionValue(catalog.form, selectControl, label)
        : null;
      if (option === null) return false;
      data.append(selectControl.name, option);
    }
    return true;
  }

  // CAST has also used groups of labelled checkboxes/radios. In that shape
  // each control is its own option and its value can be copied only after the
  // label has been matched; arbitrary field names are never accepted.
  const matchingControls = values.map((value) => {
    const needle = normal(value);
    return controls.find((control) => {
      const label = normal(control.label);
      return (
        label === needle || label.includes(needle) || needle.includes(label)
      );
    });
  });
  if (matchingControls.some((control) => control === undefined)) return false;
  const names = new Set(matchingControls.map((control) => control?.name));
  names.forEach((name) => {
    if (name) data.delete(name);
  });
  matchingControls.forEach((control) => {
    if (control) data.append(control.name, control.value);
  });
  return true;
}

function applySemanticFilters(
  data: FormData,
  catalog: FormCatalog,
  request: CastSearchRequest,
  page: number,
): { applied: CastSearchAppliedFilters; ok: boolean } {
  const filters = request.filters;
  const graduationYearsDefaulted =
    request.kind === "hiring_record" &&
    filters.graduation_years === undefined &&
    filters.year === undefined;
  const normalizedFilters: CastSearchFilters = {
    ...filters,
    graduation_years: graduationYearsDefaulted
      ? [2026, 2025, 2024, 2023, 2022]
      : filters.graduation_years,
  };
  const applied = {
    kind: request.kind,
    filters: normalizedFilters,
    sort: request.sort ?? null,
    graduation_years_defaulted: graduationYearsDefaulted,
  } satisfies CastSearchAppliedFilters;
  if (
    !appendText(
      data,
      catalog,
      /企業名|会社名|キーワード/u,
      filters.company_name,
    ) ||
    !appendText(data, catalog, /指導教員|教員/u, filters.advisor) ||
    !appendText(data, catalog, /学部|学科|学問系統/u, filters.faculty) ||
    !appendText(
      data,
      catalog,
      /年度|卒業年|対象年/u,
      filters.year === undefined ? undefined : String(filters.year),
    )
  ) {
    return { applied, ok: false };
  }
  if (normalizedFilters.graduation_years) {
    if (
      !appendOptions(
        data,
        catalog,
        /卒業年|卒業年度|年度/u,
        normalizedFilters.graduation_years.map(String),
      )
    ) {
      return {
        applied: {
          ...applied,
        },
        ok: false,
      };
    }
  }
  if (
    !appendOptions(
      data,
      catalog,
      /学部|学科|学問系統|募集学部/u,
      normalizedFilters.academic_programs,
    )
  )
    return {
      applied,
      ok: false,
    };
  if (!appendOptions(data, catalog, /業種|業界/u, normalizedFilters.industries))
    return {
      applied,
      ok: false,
    };
  if (
    !appendOptions(
      data,
      catalog,
      /職種|募集職種|採用職種/u,
      normalizedFilters.occupations,
    )
  )
    return {
      applied,
      ok: false,
    };
  if (
    !appendOptions(
      data,
      catalog,
      /勤務地|実施地|開催地/u,
      normalizedFilters.locations,
    )
  )
    return {
      applied,
      ok: false,
    };
  if (
    !appendOptions(
      data,
      catalog,
      /対象学年|学年/u,
      normalizedFilters.target_grades,
    )
  )
    return {
      applied,
      ok: false,
    };
  if (
    !appendOptions(
      data,
      catalog,
      /実施日数|期間|日数/u,
      normalizedFilters.duration,
    )
  )
    return {
      applied,
      ok: false,
    };
  if (filters.relation) {
    const labels: Record<NonNullable<CastSearchFilters["relation"]>, string> = {
      hiring_record: "採用実績",
      obog: "OB・OG",
      career_supporter: "就活サポーター",
      company_session: "会社説明会",
      internship: "インターンシップ",
      entrance_exam: "入社試験情報",
    };
    if (
      !appendOptions(data, catalog, /本学との関連|関連|情報/u, [
        labels[filters.relation],
      ])
    )
      return {
        applied,
        ok: false,
      };
  }
  if (filters.application_method) {
    const label = filters.application_method === "free" ? "自由応募" : "推薦";
    if (!appendOptions(data, catalog, /応募方法|応募区分/u, [label]))
      return {
        applied,
        ok: false,
      };
  }
  if (
    !appendText(
      data,
      catalog,
      /締切|応募締切|期限/u,
      asSafeDate(filters.deadline_before),
    ) ||
    !appendText(
      data,
      catalog,
      /開催.*(開始|from)|開催日.*開始/u,
      asSafeDate(filters.event_start),
    ) ||
    !appendText(
      data,
      catalog,
      /開催.*(終了|to)|開催日.*終了/u,
      asSafeDate(filters.event_end),
    )
  ) {
    return { applied, ok: false };
  }
  if (filters.new_only) {
    const control = firstControl(catalog, /新着|新着のみ/u);
    if (!control) return { applied, ok: false };
    data.set(control.name, control.value || "1");
  }
  if (filters.include_closed === false) {
    const control = firstControl(catalog, /受付状態|掲載状態|終了求人|終了/u);
    if (control?.type !== "checkbox") {
      return { applied, ok: false };
    }
    data.set(control.name, control.value || "0");
  }
  const pageControl = firstControl(
    catalog,
    /^ページ|currentPageNumber|ページ番号/u,
  );
  if (page > 1 && !pageControl) return { applied, ok: false };
  if (pageControl) data.set(pageControl.name, String(page));
  if (request.sort) {
    const sortControl = catalog.controls.find(
      (control) => control.name === "sortColumn",
    );
    const directionControl = catalog.controls.find(
      (control) => control.name === "displaySortDirection",
    );
    if (!sortControl || !directionControl) return { applied, ok: false };
    data.set(sortControl.name, SORT_FIELD_VALUES[request.sort.key]);
    data.set(
      directionControl.name,
      request.sort.direction === "asc" ? "1" : "2",
    );
  }
  return {
    applied,
    ok: true,
  };
}

function textFromElement(element: Element | null | undefined): string {
  if (!element) return "";
  const clone = element.cloneNode(true) as Element;
  clone
    .querySelectorAll(
      "script,style,noscript,template,[hidden],[aria-hidden='true'],input,textarea,select,button",
    )
    .forEach((node) => {
      node.remove();
    });
  return compact(clone.textContent, MAX_TEXT);
}

function dateFromText(value: string): string | null {
  const match = /(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/u.exec(value);
  if (!match) return null;
  const year = match[1];
  const month = match[2];
  const day = match[3];
  if (!year || !month || !day) return null;
  const normalized = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return asSafeDate(normalized) ?? null;
}

function numbers(value: string): number[] {
  return Array.from(value.matchAll(/\d{1,6}/gu)).map((match) =>
    Number(match[0]),
  );
}

function totalCount(document: Document): number | null {
  const text =
    textFromElement(document.body) ||
    compact(document.documentElement?.textContent, MAX_TEXT);
  const match = /該当(?:数|件数)|検索結果[^\d]{0,20}/u.exec(text);
  if (!match) return text.includes("該当なし") ? 0 : null;
  const after = text.slice(match.index + match[0].length);
  const value = numbers(after)[0];
  return value !== undefined && value <= 100_000 ? value : null;
}

function rowMap(row: Element): Map<string, string> {
  const cells = Array.from(row.querySelectorAll("th,td"));
  const values = cells.map((cell) => textFromElement(cell));
  const headers = Array.from(
    row
      .closest("table")
      ?.querySelector("thead tr")
      ?.querySelectorAll("th,td") ?? [],
  ).map((cell) => textFromElement(cell));
  return new Map(headers.map((header, index) => [header, values[index] ?? ""]));
}

function firstField(
  map: Map<string, string>,
  patterns: readonly RegExp[],
): string {
  for (const [key, value] of map.entries()) {
    if (patterns.some((pattern) => pattern.test(key)))
      return compact(value, 500);
  }
  return "";
}

function splitValues(value: string): string[] {
  return unique(value.split(/[、,／/]\s*/u).map((item) => compact(item, 120)));
}

function itemFromOpportunity(
  opportunity: CastOpportunity,
  kind: CastSearchKind,
  index: number,
): CastSearchItem {
  return {
    item_ref: `local-${kind}-${index + 1}`,
    kind,
    title: opportunity.company_name,
    company_name: opportunity.company_name,
    industry: unique(opportunity.industry),
    locations: unique(opportunity.locations),
    occupations: unique(opportunity.occupations),
    academic_programs: unique(opportunity.eligible_programs),
    target_grades: unique(opportunity.target_grades),
    deadline: opportunity.application_deadline,
    graduation_year: null,
    hiring_count: null,
    relation_flags: Object.entries(opportunity.relations)
      .filter(([, enabled]) => enabled)
      .map(([key]) => key),
    local_summary: compact(opportunity.description, 600) || null,
  };
}

function genericItems(
  document: Document,
  kind: CastSearchKind,
): CastSearchItem[] {
  const rows = Array.from(document.querySelectorAll("table tbody tr")).filter(
    (row) => textFromElement(row),
  );
  if (rows.length > 0) {
    return rows.slice(0, PAGE_SIZE).map((row, index) => {
      const values = rowMap(row);
      const company = firstField(values, [/企業名/u, /会社名/u, /企業/u]);
      const title = company || textFromElement(row).slice(0, 160);
      const yearValue = firstField(values, [/卒業年/u, /卒業年月/u, /年度/u]);
      const year = yearValue.match(/20\d{2}/u)?.[0];
      const counts = firstField(values, [/人数/u, /採用/u, /計/u]);
      return {
        item_ref: `local-${kind}-${index + 1}`,
        kind,
        title,
        company_name: company || null,
        industry: splitValues(firstField(values, [/業種/u, /業界/u])),
        locations: splitValues(
          firstField(values, [/勤務地/u, /実施地/u, /開催地/u]),
        ),
        occupations: splitValues(firstField(values, [/職種/u, /採用職種/u])),
        academic_programs: splitValues(
          firstField(values, [/学部/u, /学科/u, /学問系統/u]),
        ),
        target_grades: splitValues(firstField(values, [/対象学年|学年/u])),
        deadline: dateFromText(
          firstField(values, [/締切/u, /期限/u, /開催日/u]),
        ),
        graduation_year: year ? Number(year) : null,
        hiring_count: counts.match(/\d+/u)
          ? Number(counts.match(/\d+/u)?.[0])
          : null,
        relation_flags: [],
        local_summary: textFromElement(row),
      };
    });
  }
  const panels = Array.from(
    document.querySelectorAll(".panel.panel-default"),
  ).filter((panel) => textFromElement(panel));
  return panels.slice(0, PAGE_SIZE).map((panel, index) => {
    const company = compact(panel.querySelector(".linkTo")?.textContent, 200);
    const heading = textFromElement(panel.querySelector(".panel-heading"));
    const body = textFromElement(panel.querySelector(".panel-body") ?? panel);
    return {
      item_ref: `local-${kind}-${index + 1}`,
      kind,
      title: company || heading.slice(0, 160),
      company_name: company || null,
      industry: splitValues(body.match(/業種\s*([^\n]+)/u)?.[1] ?? ""),
      locations: splitValues(
        body.match(/(?:勤務地|実施地|開催地)\s*([^\n]+)/u)?.[1] ?? "",
      ),
      occupations: splitValues(
        body.match(/(?:募集職種|採用職種|職種)\s*([^\n]+)/u)?.[1] ?? "",
      ),
      academic_programs: splitValues(
        body.match(/(?:募集学部学科|学部学科)\s*([^\n]+)/u)?.[1] ?? "",
      ),
      target_grades: splitValues(
        body.match(/(?:対象学年|学年)\s*([^\n]+)/u)?.[1] ?? "",
      ),
      deadline: dateFromText(
        heading.match(
          /(?:締切|期限)[^0-9]*(20\d{2}[-/.]\d{1,2}[-/.]\d{1,2})/u,
        )?.[1] ?? "",
      ),
      graduation_year: null,
      hiring_count: null,
      relation_flags: [],
      local_summary: body.slice(0, 600) || null,
    };
  });
}

function parseItems(
  document: Document,
  kind: CastSearchKind,
  url: string,
): CastSearchItem[] | null {
  if (kind === "job" || kind === "internship") {
    const snapshot = extractCastOpportunities(document, url);
    if (!snapshot || snapshot.kind !== (kind as CastOpportunityKind))
      return null;
    return snapshot.opportunities.map((opportunity, index) =>
      itemFromOpportunity(opportunity, kind, index),
    );
  }
  const items = genericItems(document, kind);
  if (items.length === 0 && totalCount(document) !== 0) return null;
  return items;
}

function newOpaque(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replaceAll("-", "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random.slice(0, 24)}`;
}

function createCursor(kind: CastSearchKind, page: number): string {
  const token = newOpaque("cast-cursor");
  cursorPages.set(token, { kind, page });
  return token;
}

function pageFromCursor(request: CastSearchRequest): {
  page: number;
  error?: CastSearchErrorResult;
} {
  if (!request.cursor) return { page: 1 };
  const state = cursorPages.get(request.cursor);
  if (!state || state.kind !== request.kind) {
    return {
      page: 1,
      error: { status: "unavailable", reason_code: "unknown_cursor" },
    };
  }
  return { page: state.page };
}

function statusForFetch(response: Response): CastSearchErrorResult | null {
  if (response.status === 401 || response.status === 403)
    return { status: "reauth_required", reason_code: "session_expired" };
  if (response.status === 429)
    return { status: "rate_limited", reason_code: "cast_rate_limited" };
  if (response.status === 404)
    return { status: "unavailable", reason_code: "not_found" };
  if (response.status >= 500)
    return { status: "unavailable", reason_code: "cast_server_error" };
  if (!response.ok)
    return { status: "unavailable", reason_code: "cast_http_error" };
  return null;
}

export interface CastSearchTransportOptions {
  fetcher?: typeof fetch;
  parseHtml?: (html: string) => Document;
  /** Maximum number of pages for a bounded exhaustive read. */
  maxPages?: number;
  /**
   * Content-script-only observation hook.  The parsed document stays in the
   * CAST origin and is never returned through an extension message.
   */
  onDocument?: (document: Document, url: string) => void;
}

function defaultParseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

async function fetchDocument(
  url: string,
  init: RequestInit,
  options: CastSearchTransportOptions,
): Promise<{
  document?: Document;
  response?: Response;
  error?: CastSearchErrorResult;
}> {
  const fetcher = options.fetcher ?? fetch;
  try {
    const response = await fetcher(url, {
      ...init,
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
    });
    const failure = statusForFetch(response);
    if (failure) return { response, error: failure };
    const finalUrl = response.url || url;
    const html = await response.text();
    const document = (options.parseHtml ?? defaultParseHtml)(html);
    if (isLoginPage(document, finalUrl))
      return {
        response,
        error: { status: "reauth_required", reason_code: "login_required" },
      };
    options.onDocument?.(document, finalUrl);
    return { document, response };
  } catch {
    return {
      error: { status: "unavailable", reason_code: "cast_network_error" },
    };
  }
}

async function runOnePage(
  request: CastSearchRequest,
  catalog: FormCatalog,
  page: number,
  options: CastSearchTransportOptions,
): Promise<{
  result?: CastSearchLocalKnownResult;
  error?: CastSearchErrorResult;
}> {
  const data = formDataFromForm(catalog.form);
  const { applied, ok } = applySemanticFilters(data, catalog, request, page);
  if (!ok)
    return {
      error: { status: "form_changed", reason_code: "filter_not_available" },
    };
  const definition = CAST_SEARCH_DEFINITIONS[request.kind];
  const actionUrl = `${CAST_SEARCH_ORIGIN}${definition.actionPath}`;
  const fetched = await fetchDocument(
    actionUrl,
    { method: "POST", body: data },
    options,
  );
  if (fetched.error) return { error: fetched.error };
  if (
    !fetched.document ||
    !fetched.response ||
    !resultUrl(request.kind, fetched.response.url || actionUrl)
  ) {
    return {
      error: { status: "form_changed", reason_code: "unexpected_result_path" },
    };
  }
  const total = totalCount(fetched.document);
  const items = parseItems(
    fetched.document,
    request.kind,
    fetched.response.url || actionUrl,
  );
  if (total === null || items === null)
    return {
      error: {
        status: "form_changed",
        reason_code: "result_structure_changed",
      },
    };
  const evidence = [
    {
      evidence_id: newOpaque("cast-search-v1"),
      title: `CAST ${request.kind}検索結果`,
      locator: `orbit-cast://search/${newOpaque("evidence").slice(-24)}`,
    },
  ];
  const totalPages = total === 0 ? 0 : Math.ceil(total / PAGE_SIZE);
  return {
    result: {
      status: "known",
      applied_filters: applied,
      total_count: total,
      coverage: {
        mode: "page",
        page_size: PAGE_SIZE,
        fetched_pages: 1,
        total_pages: totalPages,
      },
      page,
      next_cursor:
        total > page * PAGE_SIZE ? createCursor(request.kind, page + 1) : null,
      typed_items: items.slice(0, PAGE_SIZE),
      local_evidence: evidence,
    },
  };
}

/**
 * Execute one CAST search from the authenticated CAST origin. This function is
 * intentionally only called by the CAST content script, so browser cookies
 * never cross an extension/runtime message boundary.
 */
export async function runCastSearch(
  request: CastSearchRequest,
  options: CastSearchTransportOptions = {},
): Promise<CastSearchLocalResult> {
  if (!isCastSearchRequest(request))
    return { status: "unavailable", reason_code: "request_rejected" };
  if (window.location.origin !== CAST_SEARCH_ORIGIN)
    return { status: "unavailable", reason_code: "unexpected_origin" };
  if (
    ["/career/login", "/career/session_timeout"].includes(
      window.location.pathname,
    )
  ) {
    return { status: "reauth_required", reason_code: "login_required" };
  }
  const cursor = pageFromCursor(request);
  if (cursor.error) return cursor.error;
  const initial = await fetchDocument(
    entryUrl(request.kind),
    { method: "GET" },
    options,
  );
  if (initial.error) return initial.error;
  if (!initial.document || !initial.response)
    return { status: "unavailable", reason_code: "form_load_failed" };
  const catalog = collectCastSearchFormCatalog(
    initial.document,
    request.kind,
    initial.response.url || entryUrl(request.kind),
  );
  if (!catalog)
    return { status: "form_changed", reason_code: "search_form_changed" };
  const first = await runOnePage(request, catalog, cursor.page, options);
  if (first.error || !first.result)
    return (
      first.error ?? { status: "unavailable", reason_code: "search_failed" }
    );
  if (
    !request.exhaustive ||
    first.result.total_count <= first.result.typed_items.length
  )
    return first.result;
  const allItems = [...first.result.typed_items];
  let currentPage = cursor.page + 1;
  let last = first.result;
  const maxPages = Math.max(
    1,
    Math.min(MAX_PAGE_COUNT, options.maxPages ?? MAX_PAGE_COUNT),
  );
  while (
    currentPage <= maxPages &&
    allItems.length < Math.min(first.result.total_count, MAX_ITEMS)
  ) {
    const next = await runOnePage(request, catalog, currentPage, options);
    if (next.error || !next.result) {
      return {
        status: "unavailable",
        reason_code: next.error?.reason_code ?? "exhaustive_page_failed",
      };
    }
    allItems.push(...next.result.typed_items);
    last = next.result;
    if (
      next.result.typed_items.length === 0 ||
      next.result.next_cursor === null
    )
      break;
    currentPage += 1;
  }
  const complete = allItems.length >= first.result.total_count;
  return {
    ...last,
    coverage: {
      mode: complete ? "complete" : "partial",
      page_size: PAGE_SIZE,
      fetched_pages: currentPage - cursor.page,
      total_pages: first.result.coverage.total_pages,
    },
    page: cursor.page,
    next_cursor: complete ? null : last.next_cursor,
    typed_items: allItems.slice(0, MAX_ITEMS),
  };
}

function aggregates(
  result: CastSearchLocalKnownResult,
): CastSearchAgentProjection["anonymous_aggregates"] {
  const values: Array<{
    dimension: "industry" | "location" | "graduation_year";
    value: string;
  }>[] = [
    result.typed_items.flatMap((item) =>
      item.industry.map((value) => ({ dimension: "industry" as const, value })),
    ),
    result.typed_items.flatMap((item) =>
      item.locations.map((value) => ({
        dimension: "location" as const,
        value,
      })),
    ),
    result.typed_items.flatMap((item) =>
      item.graduation_year === null
        ? []
        : [
            {
              dimension: "graduation_year" as const,
              value: String(item.graduation_year),
            },
          ],
    ),
  ];
  return values.flatMap((entries) => {
    const counts = new Map<string, number>();
    entries.forEach((entry) => {
      counts.set(entry.value, (counts.get(entry.value) ?? 0) + 1);
    });
    return Array.from(counts.entries())
      .filter(([, count]) => count >= 5)
      .map(([value, count]) => ({
        dimension: entries[0]?.dimension ?? "industry",
        value,
        count,
      }));
  });
}

export function projectCastSearchForAgent(
  result: CastSearchLocalResult,
): CastSearchAgentProjection {
  if (result.status !== "known") {
    return {
      schema_version: "v1",
      status: result.status,
      applied_filters: null,
      total_count: 0,
      returned_count: 0,
      coverage: null,
      anonymous_aggregates: [],
      evidence_ids: [],
      reason_code: result.reason_code,
    };
  }
  return {
    schema_version: "v1",
    status: "known",
    applied_filters: result.applied_filters,
    total_count: result.total_count,
    returned_count: result.typed_items.length,
    coverage: result.coverage,
    anonymous_aggregates: aggregates(result),
    evidence_ids: result.local_evidence.map((evidence) => evidence.evidence_id),
    reason_code: null,
  };
}

export function clearCastSearchCursors(): void {
  cursorPages.clear();
}
