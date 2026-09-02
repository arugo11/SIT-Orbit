import MiniSearch from "minisearch";
import { runLocalPrompt } from "../privacy/career-prompt";
import type {
  CastCareerSourceItem,
  CastCareerSurface,
} from "./cast-career-source-runtime";
import type {
  CastHistoryLocalSnapshot,
  CastHistoryPerson,
} from "./cast-history-reports-reader";
import type {
  CastOpportunity,
  CastOpportunityLocalSnapshot,
} from "./cast-opportunities-reader";
import type {
  CastSupportLocalSnapshot,
  CastSupportResource,
} from "./cast-support-resources-reader";

export type CastCareerDocumentKind =
  | "job"
  | "internship"
  | "company_session"
  | "company"
  | "hiring_record"
  | "selection_report"
  | "recording"
  | "career_event"
  | "counseling"
  | "support_resource"
  | "notice";

/**
 * A local-only search document. It intentionally contains the fields needed
 * for a useful result card, but it is never passed to a Prompt API request.
 */
export interface CastCareerSearchDocument {
  id: string;
  kind: CastCareerDocumentKind;
  title: string;
  text: string;
  company: string | null;
  locations: string[];
  technical_domains: string[];
  occupations: string[];
  years: number[];
  deadline: string | null;
  source_url: string | null;
  local_payload: unknown;
}

export interface CastCareerCorpus {
  opportunities?: CastOpportunityLocalSnapshot[];
  histories?: CastHistoryLocalSnapshot[];
  support?: CastSupportLocalSnapshot;
}

export interface CastSearchQuery {
  original: string;
  terms: string[];
  required_terms: string[];
  locations: string[];
  technical_domains: string[];
  occupations: string[];
  kinds: CastCareerDocumentKind[];
  year_from: number | null;
  year_to: number | null;
  obog_required: boolean;
}

export interface CastSearchResult {
  document: CastCareerSearchDocument;
  score: number;
  matched_terms: string[];
}

export interface CastSearchResponse {
  query: CastSearchQuery;
  results: CastSearchResult[];
  total_matching: number;
  searched_document_count: number;
}

export interface LocalCareerPromptRequest {
  prompt: string;
  response_constraint: Record<string, unknown>;
}

const MAX_QUERY_LENGTH = 1000;
const MAX_TERMS = 24;
const MAX_RESULTS = 50;
const MAX_DOCUMENTS = 5000;

const QUERY_RESPONSE_CONSTRAINT: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    terms: { type: "array", items: { type: "string" }, maxItems: 24 },
    required_terms: {
      type: "array",
      items: { type: "string" },
      maxItems: 12,
    },
    locations: { type: "array", items: { type: "string" }, maxItems: 8 },
    technical_domains: {
      type: "array",
      items: { type: "string" },
      maxItems: 12,
    },
    occupations: { type: "array", items: { type: "string" }, maxItems: 12 },
    kinds: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "job",
          "internship",
          "company_session",
          "company",
          "hiring_record",
          "selection_report",
          "recording",
          "career_event",
          "counseling",
          "support_resource",
          "notice",
        ],
      },
      maxItems: 6,
    },
    year_from: { type: ["integer", "null"] },
    year_to: { type: ["integer", "null"] },
    obog_required: { type: "boolean" },
  },
  required: [
    "terms",
    "required_terms",
    "locations",
    "technical_domains",
    "occupations",
    "kinds",
    "year_from",
    "year_to",
    "obog_required",
  ],
};

function compact(value: string | null | undefined, max = 4000): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function uniqueStrings(values: unknown, max: number): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => compact(value, 160).toLocaleLowerCase("ja-JP"))
        .filter(Boolean),
    ),
  ).slice(0, max);
}

function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

const DOCUMENT_KINDS: CastCareerDocumentKind[] = [
  "job",
  "internship",
  "company_session",
  "company",
  "hiring_record",
  "selection_report",
  "recording",
  "career_event",
  "counseling",
  "support_resource",
  "notice",
];

function kinds(value: unknown): CastCareerDocumentKind[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is CastCareerDocumentKind =>
      typeof item === "string" &&
      DOCUMENT_KINDS.includes(item as CastCareerDocumentKind),
  );
}

function safeOriginalQuery(value: string): string {
  const original = compact(value, MAX_QUERY_LENGTH);
  if (!original) throw new Error("Career search query must not be empty.");
  return original;
}

/** Validate the strict, local Prompt API response before indexing anything. */
export function parseCareerQueryResponse(
  original: string,
  value: unknown,
): CastSearchQuery {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Career query response must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  return {
    original: safeOriginalQuery(original),
    terms: uniqueStrings(candidate.terms, MAX_TERMS),
    required_terms: uniqueStrings(candidate.required_terms, 12),
    locations: uniqueStrings(candidate.locations, 8),
    technical_domains: uniqueStrings(candidate.technical_domains, 12),
    occupations: uniqueStrings(candidate.occupations, 12),
    kinds: kinds(candidate.kinds),
    year_from: integerOrNull(candidate.year_from),
    year_to: integerOrNull(candidate.year_to),
    obog_required: candidate.obog_required === true,
  };
}

/**
 * Build the only prompt sent to Chrome's local model. Documents are deliberately
 * not accepted so a caller cannot accidentally send CAST content to the model.
 */
export function createCareerQueryPromptRequest(
  message: string,
): LocalCareerPromptRequest {
  const original = safeOriginalQuery(message);
  return {
    prompt: [
      "あなたはSIT ORBITの端末内CAST検索用クエリ構造化器です。",
      "入力文だけを読み、検索語と厳密フィルタへ変換してください。",
      "企業名、人物名、メール、学籍番号、URL、IDを新しく作らないでください。",
      "該当しない配列は空、年が不明ならnull、OB・OG訪問の明示条件だけobog_required=trueにしてください。",
      `入力文: ${original}`,
      "JSON以外を返さないでください。",
    ].join("\n"),
    response_constraint: QUERY_RESPONSE_CONSTRAINT,
  };
}

export async function structureCareerQuery(
  message: string,
): Promise<CastSearchQuery> {
  const request = createCareerQueryPromptRequest(message);
  return runLocalPrompt({
    prompt: request.prompt,
    responseConstraint: request.response_constraint,
    parse: (value) => parseCareerQueryResponse(message, value),
  });
}

function dateYear(value: string | null): number | null {
  const match = value?.match(/^(20\d{2})-/u);
  return match ? Number(match[1]) : null;
}

function join(values: readonly (string | null | undefined)[]): string {
  return values.filter((value): value is string => Boolean(value)).join(" ");
}

function localDocumentId(kind: CastCareerDocumentKind): string {
  const entropy =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replaceAll("-", "").slice(0, 20)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `orbit-cast-document-${kind}-${entropy}`;
}

function opportunityDocument(
  opportunity: CastOpportunity,
): CastCareerSearchDocument {
  return {
    id: localDocumentId(opportunity.kind),
    kind: opportunity.kind,
    title: opportunity.company_name,
    text: join([
      opportunity.company_name,
      opportunity.description,
      ...opportunity.industry,
      ...opportunity.occupations,
      ...opportunity.locations,
      ...opportunity.eligible_programs,
      ...opportunity.target_grades,
      ...opportunity.duration,
      ...opportunity.application_methods,
    ]),
    company: opportunity.company_name,
    locations: opportunity.locations,
    technical_domains: [
      ...opportunity.industry,
      ...opportunity.eligible_programs,
    ],
    occupations: opportunity.occupations,
    years: [
      dateYear(opportunity.received_date),
      dateYear(opportunity.application_deadline),
      dateYear(opportunity.period_start),
    ].filter((value): value is number => value !== null),
    deadline: opportunity.application_deadline,
    source_url: null,
    local_payload: opportunity,
  };
}

function historyPersonText(person: CastHistoryPerson): string {
  return join([
    person.company,
    ...person.technical_domains,
    ...person.job_types,
    person.role,
    person.graduation_year?.toString(),
  ]);
}

function historyDocuments(
  snapshot: CastHistoryLocalSnapshot,
): CastCareerSearchDocument[] {
  const years = snapshot.hiring_records
    .map((record) => dateYear(record.graduation_date))
    .filter((value): value is number => value !== null);
  const peopleText = snapshot.people.map(historyPersonText);
  const records = snapshot.hiring_records.map(
    (record): CastCareerSearchDocument => ({
      id: localDocumentId("hiring_record"),
      kind: "hiring_record",
      title: `${snapshot.company_name} 採用実績`,
      text: join([
        snapshot.company_name,
        record.academic_field,
        record.department,
        record.employment_type,
        record.job_type,
        ...peopleText,
      ]),
      company: snapshot.company_name,
      locations: [],
      technical_domains: [record.academic_field, record.department].filter(
        (value): value is string => Boolean(value),
      ),
      occupations: record.job_type ? [record.job_type] : [],
      years: [dateYear(record.graduation_date)].filter(
        (value): value is number => value !== null,
      ),
      deadline: null,
      source_url: null,
      local_payload: record,
    }),
  );
  const reports = snapshot.selection_reports.map(
    (report): CastCareerSearchDocument => ({
      id: localDocumentId("selection_report"),
      kind: "selection_report",
      title: `${snapshot.company_name} 選考記録`,
      text: join([
        snapshot.company_name,
        report.academic_field,
        report.department,
        report.application_method,
        report.job_type,
        report.gender,
        ...peopleText,
      ]),
      company: snapshot.company_name,
      locations: [],
      technical_domains: [report.academic_field, report.department].filter(
        (value): value is string => Boolean(value),
      ),
      occupations: report.job_type ? [report.job_type] : [],
      years: [dateYear(report.graduation_date)].filter(
        (value): value is number => value !== null,
      ),
      deadline: null,
      source_url: null,
      local_payload: report,
    }),
  );
  return [...records, ...reports].map((document) => ({
    ...document,
    years: document.years.length > 0 ? document.years : years,
  }));
}

function supportDocument(
  resource: CastSupportResource,
): CastCareerSearchDocument {
  return {
    id: localDocumentId("support_resource"),
    kind: "support_resource",
    title: resource.title,
    text: `${resource.title} ${resource.kind}`,
    company: null,
    locations: [],
    technical_domains: [],
    occupations: [],
    years: [dateYear(resource.published_date)].filter(
      (value): value is number => value !== null,
    ),
    deadline: null,
    source_url: resource.url,
    local_payload: resource,
  };
}

export function buildCastCareerDocuments(
  corpus: CastCareerCorpus,
): CastCareerSearchDocument[] {
  const documents: CastCareerSearchDocument[] = [];
  for (const snapshot of corpus.opportunities ?? []) {
    documents.push(...snapshot.opportunities.map(opportunityDocument));
  }
  for (const snapshot of corpus.histories ?? []) {
    documents.push(...historyDocuments(snapshot));
  }
  for (const notice of corpus.support?.notices ?? []) {
    documents.push({
      id: `notice:${notice.title}:${notice.published_date ?? "unknown"}`,
      kind: "notice",
      title: notice.title,
      text: notice.title,
      company: null,
      locations: [],
      technical_domains: [],
      occupations: [],
      years: [dateYear(notice.published_date)].filter(
        (value): value is number => value !== null,
      ),
      deadline: null,
      source_url: null,
      local_payload: notice,
    });
  }
  documents.push(...(corpus.support?.resources ?? []).map(supportDocument));
  return documents.slice(0, MAX_DOCUMENTS);
}

function normalizeForSearch(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ja-JP")
    .replace(/[\u3000\s]+/gu, " ")
    .trim();
}

/**
 * Tokenizer tuned for Japanese UI labels as well as whitespace-delimited
 * English. It keeps words and short character n-grams so MiniSearch prefix and
 * fuzzy matching remain useful without a heavyweight language model.
 */
function tokenize(value: string): string[] {
  const chunks = normalizeForSearch(value)
    .split(/[^\p{L}\p{N}\u3040-\u30ff\u3400-\u9fff+#.-]+/u)
    .filter(Boolean);
  const tokens = new Set<string>();
  for (const chunk of chunks) {
    tokens.add(chunk);
    if (chunk.length >= 2 && chunk.length <= 80) {
      for (let index = 0; index < chunk.length - 1; index += 1) {
        tokens.add(chunk.slice(index, index + 2));
      }
    }
  }
  return Array.from(tokens).slice(0, 300);
}

function exactFilter(
  document: CastCareerSearchDocument,
  query: CastSearchQuery,
): boolean {
  if (query.kinds.length > 0 && !query.kinds.includes(document.kind)) {
    return false;
  }
  const yearFrom = query.year_from;
  const yearTo = query.year_to;
  if (
    (yearFrom !== null || yearTo !== null) &&
    !document.years.some(
      (year) =>
        (yearFrom === null || year >= yearFrom) &&
        (yearTo === null || year <= yearTo),
    )
  ) {
    return false;
  }
  if (
    query.locations.length > 0 &&
    !query.locations.some((location) =>
      document.locations.some((candidate) =>
        normalizeForSearch(candidate).includes(normalizeForSearch(location)),
      ),
    )
  ) {
    return false;
  }
  if (
    query.technical_domains.length > 0 &&
    !query.technical_domains.some((domain) =>
      document.technical_domains.some((candidate) =>
        normalizeForSearch(candidate).includes(normalizeForSearch(domain)),
      ),
    )
  ) {
    return false;
  }
  if (
    query.occupations.length > 0 &&
    !query.occupations.some((occupation) =>
      document.occupations.some((candidate) =>
        normalizeForSearch(candidate).includes(normalizeForSearch(occupation)),
      ),
    )
  ) {
    return false;
  }
  if (
    query.obog_required &&
    !(
      document.kind === "hiring_record" ||
      document.kind === "selection_report" ||
      /ob[・･]og|先輩|卒業生/u.test(document.text)
    )
  ) {
    return false;
  }
  return true;
}

function matchesRequiredTerms(
  document: CastCareerSearchDocument,
  requiredTerms: string[],
): boolean {
  const haystack = normalizeForSearch(
    `${document.title} ${document.text} ${document.company ?? ""}`,
  );
  return requiredTerms.every((term) =>
    haystack.includes(normalizeForSearch(term)),
  );
}

export function searchCastCareer(
  documents: CastCareerSearchDocument[],
  query: CastSearchQuery,
  limit = 20,
): CastSearchResponse {
  const boundedLimit = Math.max(1, Math.min(limit, MAX_RESULTS));
  const eligible = documents.filter((document) => exactFilter(document, query));
  const search = new MiniSearch<CastCareerSearchDocument>({
    fields: [
      "title",
      "text",
      "company",
      "locations",
      "technical_domains",
      "occupations",
    ],
    storeFields: ["id"],
    tokenize,
    processTerm: (term) => normalizeForSearch(term),
  });
  search.addAll(eligible);
  const queryText = [...query.terms, ...query.required_terms].join(" ");
  const ranked = queryText
    ? search.search(queryText, {
        prefix: true,
        fuzzy: 0.2,
        combineWith: "OR",
        boost: { title: 3, company: 2, technical_domains: 2 },
        weights: { fuzzy: 0.25, prefix: 0.65 },
      })
    : eligible.map((document) => ({ id: document.id, score: 0, terms: [] }));
  const byId = new Map(eligible.map((document) => [document.id, document]));
  const matchingResults = ranked
    .map((match) => {
      const document = byId.get(String(match.id));
      if (!document || !matchesRequiredTerms(document, query.required_terms)) {
        return null;
      }
      return {
        document,
        score: Number(match.score.toFixed(4)),
        matched_terms: match.terms.slice(0, MAX_TERMS),
      };
    })
    .filter((result): result is CastSearchResult => result !== null)
    .sort((left, right) => right.score - left.score);
  return {
    query,
    results: matchingResults.slice(0, boundedLimit),
    total_matching: matchingResults.length,
    searched_document_count: eligible.length,
  };
}

export function emptyCareerQuery(message: string): CastSearchQuery {
  return {
    original: safeOriginalQuery(message),
    terms: [],
    required_terms: [],
    locations: [],
    technical_domains: [],
    occupations: [],
    kinds: [],
    year_from: null,
    year_to: null,
    obog_required: false,
  };
}

export interface CastCareerRankedItem {
  item: CastCareerSourceItem;
  score: number;
  matched_terms: string[];
}

export interface CastCareerMatchReason {
  label: string;
  detail: string;
}

/** Local-only company/content group used by the cross-surface result cards. */
export interface CastCareerResultGroup {
  group_ref: string;
  company_name: string | null;
  items: CastCareerRankedItem[];
  score: number;
  matched_surfaces: CastCareerSurface[];
  match_reasons: CastCareerMatchReason[];
  missing_requirements: string[];
}

export interface CastCareerLocalFilters {
  company_name?: string;
  locations?: string[];
  industries?: string[];
  technical_domains?: string[];
  occupations?: string[];
  academic_programs?: string[];
  target_grades?: string[];
  graduation_years?: number[];
  deadline_before?: string;
  obog_required?: boolean;
  career_supporter_required?: boolean;
  recording_required?: boolean;
}

function containsAny(
  values: readonly string[],
  needles: readonly string[],
): boolean {
  return needles.some((needle) =>
    values.some((value) =>
      normalizeForSearch(value).includes(normalizeForSearch(needle)),
    ),
  );
}

function passesLocalFilters(
  item: CastCareerSourceItem,
  filters: CastCareerLocalFilters,
): boolean {
  if (
    filters.company_name &&
    !normalizeForSearch(item.company_name ?? item.title).includes(
      normalizeForSearch(filters.company_name),
    )
  ) {
    return false;
  }
  // Cross-surface filters are evaluated on the complete company group below.
  // Keeping a row without (for example) a location lets a hiring record join
  // a job row that carries the location condition.
  // Relation requirements are evaluated after grouping. A job row can be
  // related to a history/report row for the same company, so filtering each
  // row independently would discard valid cross-surface hits.
  return true;
}

function normalizedCompany(item: CastCareerSourceItem): string | null {
  const value =
    item.company_name ?? (item.surface === "company" ? item.title : "");
  const normalized = normalizeForSearch(value);
  return normalized || null;
}

function groupKey(item: CastCareerSourceItem): string {
  const company = normalizedCompany(item);
  return company
    ? `company:${company}`
    : `surface:${item.surface}:${normalizeForSearch(item.title)}`;
}

function hasRelation(
  group: readonly CastCareerRankedItem[],
  relation: string,
): boolean {
  return group.some((entry) => entry.item.relation_flags.includes(relation));
}

function uniqueSurfaceValues(
  values: readonly CastCareerSurface[],
): CastCareerSurface[] {
  return Array.from(new Set(values));
}

function matchingValues(
  values: readonly string[],
  needles: readonly string[] | undefined,
): string[] {
  if (!needles?.length) return [];
  return values.filter((value) =>
    needles.some((needle) =>
      normalizeForSearch(value).includes(normalizeForSearch(needle)),
    ),
  );
}

function buildMatchReasons(
  group: readonly CastCareerRankedItem[],
  filters: CastCareerLocalFilters,
): CastCareerMatchReason[] {
  const reasons: CastCareerMatchReason[] = [];
  const allItems = group.map((entry) => entry.item);
  const locations = matchingValues(
    allItems.flatMap((item) => item.locations),
    filters.locations,
  );
  const domains = matchingValues(
    allItems.flatMap((item) => [...item.academic_programs, ...item.industries]),
    filters.technical_domains,
  );
  const occupations = matchingValues(
    allItems.flatMap((item) => item.occupations),
    filters.occupations,
  );
  const targetGrades = matchingValues(
    allItems.flatMap((item) => item.target_grades ?? []),
    filters.target_grades,
  );
  const years = (filters.graduation_years ?? []).filter((year) =>
    allItems.some((item) => item.graduation_years.includes(year)),
  );
  const deadlines = allItems
    .map((item) => item.deadline)
    .filter((value): value is string => value !== null)
    .filter(
      (value) => !filters.deadline_before || value <= filters.deadline_before,
    )
    .sort();
  if (locations.length) {
    reasons.push({
      label: "勤務地",
      detail: Array.from(new Set(locations)).join("、"),
    });
  }
  if (domains.length) {
    reasons.push({
      label: "技術領域・業種",
      detail: Array.from(new Set(domains)).join("、"),
    });
  }
  if (occupations.length) {
    reasons.push({
      label: "職種",
      detail: Array.from(new Set(occupations)).join("、"),
    });
  }
  if (targetGrades.length) {
    reasons.push({
      label: "対象学年",
      detail: Array.from(new Set(targetGrades)).join("、"),
    });
  }
  if (years.length) {
    reasons.push({ label: "採用実績年度", detail: years.join("、") });
  }
  if (deadlines.length && filters.deadline_before) {
    reasons.push({ label: "締切", detail: `${deadlines[0]}以前` });
  }
  if (filters.obog_required && hasRelation(group, "obog")) {
    reasons.push({ label: "OB・OG", detail: "CAST上で関連情報あり" });
  }
  if (
    filters.career_supporter_required &&
    hasRelation(group, "career_supporter")
  ) {
    reasons.push({ label: "就活サポーター", detail: "CAST上で関連情報あり" });
  }
  if (
    filters.recording_required &&
    (group.some((entry) => entry.item.surface === "recording") ||
      hasRelation(group, "recording"))
  ) {
    reasons.push({ label: "録画", detail: "関連する公式録画あり" });
  }
  return reasons.slice(0, 12);
}

function missingRequirements(
  group: readonly CastCareerRankedItem[],
  filters: CastCareerLocalFilters,
): string[] {
  const missing: string[] = [];
  const allItems = group.map((entry) => entry.item);
  if (
    filters.locations?.length &&
    !containsAny(
      allItems.flatMap((item) => item.locations),
      filters.locations,
    )
  ) {
    missing.push("勤務地");
  }
  if (
    filters.industries?.length &&
    !containsAny(
      allItems.flatMap((item) => item.industries),
      filters.industries,
    )
  ) {
    missing.push("業種");
  }
  if (
    filters.technical_domains?.length &&
    !containsAny(
      allItems.flatMap((item) => [
        ...item.academic_programs,
        ...item.industries,
      ]),
      filters.technical_domains,
    )
  ) {
    missing.push("技術領域");
  }
  if (
    filters.academic_programs?.length &&
    !containsAny(
      allItems.flatMap((item) => item.academic_programs),
      filters.academic_programs,
    )
  ) {
    missing.push("学部・学科");
  }
  if (
    filters.occupations?.length &&
    !containsAny(
      allItems.flatMap((item) => item.occupations),
      filters.occupations,
    )
  ) {
    missing.push("職種");
  }
  if (
    filters.target_grades?.length &&
    !containsAny(
      allItems.flatMap((item) => item.target_grades ?? []),
      filters.target_grades,
    )
  ) {
    missing.push("対象学年");
  }
  if (
    filters.graduation_years?.length &&
    !filters.graduation_years.some((year) =>
      allItems.some((item) => item.graduation_years.includes(year)),
    )
  ) {
    missing.push("採用実績年度");
  }
  if (
    filters.deadline_before &&
    !allItems.some(
      (item) =>
        item.deadline !== null &&
        item.deadline <= (filters.deadline_before ?? "9999-12-31"),
    )
  ) {
    missing.push("締切");
  }
  if (filters.obog_required && !hasRelation(group, "obog")) {
    missing.push("OB・OG情報");
  }
  if (
    filters.career_supporter_required &&
    !hasRelation(group, "career_supporter")
  ) {
    missing.push("就活サポーター情報");
  }
  if (
    filters.recording_required &&
    !group.some(
      (entry) =>
        entry.item.surface === "recording" ||
        entry.item.relation_flags.includes("recording"),
    )
  ) {
    missing.push("関連録画");
  }
  return missing;
}

/** Group and explain ranked local results without persisting an index. */
export function groupCastCareerItems(
  rankedItems: readonly CastCareerRankedItem[],
  filters: CastCareerLocalFilters = {},
): CastCareerResultGroup[] {
  const groups = new Map<string, CastCareerRankedItem[]>();
  for (const item of rankedItems) {
    const key = groupKey(item.item);
    const current = groups.get(key) ?? [];
    current.push(item);
    groups.set(key, current);
  }
  return (
    Array.from(groups.entries())
      .map(([, items], groupIndex) => {
        const surfaces = uniqueSurfaceValues(
          items.map((entry) => entry.item.surface),
        );
        const score = Number(
          (
            Math.max(...items.map((entry) => entry.score), 0) +
            Math.min(0.5, Math.max(0, surfaces.length - 1) * 0.08)
          ).toFixed(4),
        );
        return {
          // The group key is used only for the in-memory map. Keep the UI ref
          // run-local and opaque so a company name can never become an ID.
          group_ref: `orbit-cast-group-${groupIndex}-${randomLocalRef()}`,
          company_name:
            items.find((entry) => entry.item.company_name)?.item.company_name ??
            (items[0]?.item.surface === "company" ? items[0].item.title : null),
          items: [...items].sort((left, right) => right.score - left.score),
          score,
          matched_surfaces: surfaces,
          match_reasons: buildMatchReasons(items, filters),
          missing_requirements: missingRequirements(items, filters),
        };
      })
      // A recording is a separate support surface, not a company relation. Keep
      // the job/company cards visible when the recording card is separate or
      // unavailable, and expose that gap through `missing_requirements`.
      .filter(
        (group) =>
          group.missing_requirements.length === 0 ||
          group.missing_requirements.every((item) => item === "関連録画"),
      )
      .sort((left, right) => right.score - left.score)
  );
}

function randomLocalRef(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Rank live nine-surface results locally; no document is sent to a model. */
export function rankCastCareerItems(
  items: readonly CastCareerSourceItem[],
  query: string,
  limit = 20,
  filters: CastCareerLocalFilters = {},
): CastCareerRankedItem[] {
  const boundedLimit = Math.max(1, Math.min(limit, MAX_RESULTS));
  const documents: CastCareerSearchDocument[] = items
    .filter((item) => passesLocalFilters(item, filters))
    .map((item) => ({
      id: item.result_ref,
      kind: item.surface,
      title: item.title,
      text: join([
        item.title,
        item.company_name,
        item.local_summary,
        ...item.locations,
        ...item.industries,
        ...item.occupations,
        ...item.academic_programs,
        ...(item.target_grades ?? []),
        ...item.relation_flags,
      ]),
      company: item.company_name,
      locations: item.locations,
      technical_domains: item.academic_programs,
      occupations: item.occupations,
      years: item.graduation_years,
      deadline: item.deadline,
      source_url: item.source_url,
      local_payload: item,
    }));
  const search = new MiniSearch<CastCareerSearchDocument>({
    fields: [
      "title",
      "text",
      "company",
      "locations",
      "technical_domains",
      "occupations",
    ],
    storeFields: ["id"],
    tokenize,
    processTerm: (term) => normalizeForSearch(term),
  });
  search.addAll(documents);
  const byId = new Map(documents.map((document) => [document.id, document]));
  const queryText = compact(query, MAX_QUERY_LENGTH);
  const ranked = queryText
    ? search.search(queryText, {
        prefix: true,
        fuzzy: 0.2,
        combineWith: "OR",
        boost: { title: 3, company: 2, technical_domains: 2 },
        weights: { fuzzy: 0.25, prefix: 0.65 },
      })
    : documents.map((document) => ({ id: document.id, score: 0, terms: [] }));
  const rankedItems = ranked
    .map((match) => {
      const document = byId.get(String(match.id));
      if (!document?.local_payload) return null;
      return {
        item: document.local_payload as CastCareerSourceItem,
        score: Number(match.score.toFixed(4)),
        matched_terms: match.terms.slice(0, MAX_TERMS),
      };
    })
    .filter((item): item is CastCareerRankedItem => item !== null)
    .slice(0, MAX_RESULTS);
  const rankedIds = new Set(rankedItems.map((entry) => entry.item.result_ref));
  // Semantic filters are authoritative for the selected CAST surfaces. Keep
  // eligible zero-score cards so a query can return a related recording or
  // counseling slot even when its title does not repeat the user's wording.
  for (const document of documents) {
    const item = document.local_payload as CastCareerSourceItem;
    if (!rankedIds.has(item.result_ref)) {
      rankedItems.push({ item, score: 0, matched_terms: [] });
    }
  }
  const eligibleRefs = new Set(
    groupCastCareerItems(rankedItems, filters).flatMap((group) =>
      group.items.map((entry) => entry.item.result_ref),
    ),
  );
  return rankedItems
    .filter((entry) => eligibleRefs.has(entry.item.result_ref))
    .slice(0, boundedLimit);
}
