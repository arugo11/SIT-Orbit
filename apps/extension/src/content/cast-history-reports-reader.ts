import type {
  CastPersonInput,
  CastPersonRole,
  PseudonymizationMission,
  PseudonymizedPerson,
} from "../privacy/pseudonymization";

export const CAST_ORIGIN = "https://shibaura.pita.services";
export const CAST_COMPANY_DETAIL_URL = `${CAST_ORIGIN}/career/company_detail_view`;
export const CAST_COMPANY_EXAM_REPORT_URL = `${CAST_ORIGIN}/career/published_company_exam_view`;

export interface CastHiringRecord {
  local_id: string;
  graduation_date: string | null;
  academic_field: string | null;
  department: string | null;
  advisor_or_person: string | null;
  employment_type: string | null;
  job_type: string | null;
  person_index: number | null;
}

export interface CastSelectionReport {
  local_id: string;
  graduation_date: string | null;
  academic_field: string | null;
  department: string | null;
  gender: string | null;
  application_method: string | null;
  job_type: string | null;
  has_reference_es: boolean;
  report_href: string | null;
  person_index: number | null;
}

export interface CastHistoryPerson {
  name: string;
  source_identifier: string | null;
  role: CastPersonRole;
  graduation_year: number | null;
  company: string;
  technical_domains: string[];
  job_types: string[];
}

export interface CastHistoryLocalSnapshot {
  schema_version: "v1";
  company_name: string;
  company_code: string | null;
  hiring_records: CastHiringRecord[];
  selection_reports: CastSelectionReport[];
  people: CastHistoryPerson[];
  obog_available: boolean;
}

export interface CastHistoryPromptHiringRecord
  extends Omit<
    CastHiringRecord,
    "local_id" | "person_index" | "advisor_or_person"
  > {
  person_alias: string | null;
}

export interface CastHistoryPromptSelectionReport
  extends Omit<
    CastSelectionReport,
    "local_id" | "person_index" | "report_href"
  > {
  person_alias: string | null;
}

export interface CastHistoryPromptProjection {
  schema_version: "v1";
  company_name: string;
  hiring_records: CastHistoryPromptHiringRecord[];
  selection_reports: CastHistoryPromptSelectionReport[];
  obog_available: boolean;
  replaced_person_count: number;
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

export function isCastCompanyDetailUrl(
  value: string | null | undefined,
): boolean {
  return strictPath(value, "/career/company_detail_view");
}

export function isCastCompanyExamReportUrl(
  value: string | null | undefined,
): boolean {
  return strictPath(value, "/career/published_company_exam_view");
}

function normalizeDate(value: string | null | undefined): string | null {
  const match = compactText(value, 120).match(
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

function graduationYear(value: string | null): number | null {
  const normalized = normalizeDate(value);
  if (!normalized) return null;
  const year = Number(normalized.slice(0, 4));
  return Number.isInteger(year) ? year : null;
}

function tableRows(section: Element): Array<Map<string, string>> {
  const rows = Array.from(section.querySelectorAll("table tr"));
  const headerIndex = rows.findIndex((row) => row.querySelector("th"));
  if (headerIndex < 0) return [];
  const headerRow = rows[headerIndex];
  if (!headerRow) return [];
  const headers = Array.from(headerRow.querySelectorAll("th,td"))
    .map((cell) => compactText(cell.textContent, 120))
    .filter(Boolean);
  return rows.slice(headerIndex + 1).flatMap((row) => {
    const cells = Array.from(row.querySelectorAll("th,td"));
    const values = cells.map((cell) => compactText(cell.textContent, 1800));
    if (!values.some(Boolean) || values.length < 2) return [];
    return [
      new Map(headers.map((header, index) => [header, values[index] ?? ""])),
    ];
  });
}

function value(row: Map<string, string>, ...labels: string[]): string | null {
  for (const label of labels) {
    const found = compactText(row.get(label), 1800);
    if (found) return found;
  }
  return null;
}

function adjacentLabelValue(
  document: Document,
  labels: string[],
): string | null {
  const expected = new Set(labels);
  const elements = Array.from(
    document.querySelectorAll("dt,dd,th,td,label,div,span,p"),
  );
  for (const element of elements) {
    if (!expected.has(compactText(element.textContent, 120))) continue;
    const sibling = element.nextElementSibling;
    const siblingText = compactText(sibling?.textContent, 240);
    if (siblingText && !expected.has(siblingText)) return siblingText;
    const children = element.parentElement
      ? Array.from(element.parentElement.children)
      : [];
    const index = children.indexOf(element);
    for (const candidate of children.slice(index + 1)) {
      const candidateText = compactText(candidate.textContent, 240);
      if (candidateText && !expected.has(candidateText)) return candidateText;
    }
  }
  return null;
}

function extractCompanyName(document: Document): string | null {
  return adjacentLabelValue(document, ["企業名(カナ名)", "企業名"]);
}

function extractCompanyCode(document: Document): string | null {
  return (
    adjacentLabelValue(document, ["企業コード"])?.match(/\d{4,20}/u)?.[0] ??
    null
  );
}

function personName(valueText: string | null): string | null {
  if (!valueText) return null;
  const normalized = compactText(valueText, 240)
    .replace(/^離籍時\s*/u, "")
    .replace(/^氏名\s*[:：]?\s*/u, "")
    .trim();
  if (!normalized || /^(なし|不明|未登録)$/u.test(normalized)) return null;
  return normalized;
}

function sourceIdentifier(
  companyCode: string | null,
  section: string,
  index: number,
): string | null {
  if (!companyCode) return null;
  return `cast-${section}-${companyCode}-${index}`;
}

function uniquePerson(
  people: CastHistoryPerson[],
  candidate: CastHistoryPerson | null,
): number | null {
  if (!candidate) return null;
  const existing = people.findIndex(
    (person) =>
      person.name.normalize("NFKC") === candidate.name.normalize("NFKC") &&
      person.role === candidate.role,
  );
  if (existing >= 0) return existing;
  people.push(candidate);
  return people.length - 1;
}

function personForRecord(
  row: Map<string, string>,
  companyName: string,
  companyCode: string | null,
  section: string,
  index: number,
): CastHistoryPerson | null {
  const personLabel = ["氏名", "卒業生", "先輩", "指導教員"].find((label) =>
    row.has(label),
  );
  const name = personName(personLabel ? (row.get(personLabel) ?? null) : null);
  if (!name) return null;
  return {
    name,
    source_identifier: sourceIdentifier(companyCode, section, index),
    role:
      personLabel === "氏名" ||
      personLabel === "卒業生" ||
      personLabel === "先輩"
        ? "alumni"
        : "unknown",
    graduation_year: graduationYear(value(row, "卒業年月")),
    company: companyName,
    technical_domains: [],
    job_types: [value(row, "職種", "採用職種")].filter(
      (item): item is string => item !== null,
    ),
  };
}

function reportHref(section: Element, index: number): string | null {
  const dataRows = Array.from(section.querySelectorAll("table tr")).filter(
    (row) => !row.querySelector("th"),
  );
  const href = dataRows[index]?.querySelector("a")?.getAttribute("href");
  if (!href || href.startsWith("javascript:")) return null;
  try {
    const url = new URL(href, CAST_ORIGIN);
    if (url.origin !== CAST_ORIGIN || url.search || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function extractCastHistory(
  document: Document,
  pageUrl: string,
): CastHistoryLocalSnapshot | null {
  if (
    !isCastCompanyDetailUrl(pageUrl) ||
    document.querySelector('input[type="password"]')
  ) {
    return null;
  }
  const companyName = extractCompanyName(document);
  if (!companyName) return null;
  const companyCode = extractCompanyCode(document);
  const employmentSection = document.querySelector("#employment");
  const examSection = document.querySelector("#company_exam_entry");
  if (!employmentSection || !examSection) return null;

  const people: CastHistoryPerson[] = [];
  const hiringRecords = tableRows(employmentSection)
    .slice(0, 1000)
    .map((row, index): CastHiringRecord => {
      const personIndex = uniquePerson(
        people,
        personForRecord(row, companyName, companyCode, "employment", index),
      );
      return {
        local_id: `employment:${companyCode ?? "unknown"}:${index}`,
        graduation_date: normalizeDate(value(row, "卒業年月")),
        academic_field: value(row, "学問系統"),
        department: value(row, "学部学科"),
        advisor_or_person: value(row, "指導教員", "氏名", "卒業生"),
        employment_type: value(row, "雇用形態"),
        job_type: value(row, "職種", "採用職種"),
        person_index: personIndex,
      };
    });

  const selectionReports = tableRows(examSection)
    .slice(0, 1000)
    .map((row, index): CastSelectionReport => {
      const personIndex = uniquePerson(
        people,
        personForRecord(row, companyName, companyCode, "exam", index),
      );
      const reference = value(row, "参考ES", "参照");
      return {
        local_id: `exam:${companyCode ?? "unknown"}:${index}`,
        graduation_date: normalizeDate(value(row, "卒業年月")),
        academic_field: value(row, "学問系統"),
        department: value(row, "学部学科"),
        gender: value(row, "性別"),
        application_method: value(row, "応募方法"),
        job_type: value(row, "採用職種", "職種"),
        has_reference_es: Boolean(reference && !/^なし$/u.test(reference)),
        report_href: reportHref(examSection, index),
        person_index: personIndex,
      };
    });

  const obogAvailable = /OB・OG名簿[\s\S]{0,400}有/u.test(
    compactText(document.querySelector("#company_obog")?.textContent, 4000),
  );
  return {
    schema_version: "v1",
    company_name: companyName,
    company_code: companyCode,
    hiring_records: hiringRecords,
    selection_reports: selectionReports,
    people,
    obog_available: obogAvailable,
  };
}

function personInput(
  person: CastHistoryPerson,
  index: number,
): CastPersonInput {
  return {
    name: person.name,
    source_identifier: person.source_identifier ?? `cast-person-${index}`,
    role: person.role,
    company: person.company,
    technical_domains: person.technical_domains,
    job_types: person.job_types,
    graduation_year: person.graduation_year ?? undefined,
  };
}

export async function pseudonymizeCastHistoryForPrompt(
  snapshot: CastHistoryLocalSnapshot,
  mission: PseudonymizationMission,
): Promise<CastHistoryPromptProjection> {
  const gateway = await mission.transform(
    {
      schema_version: "v1",
      records: snapshot.people.map(personInput),
    },
    "local",
  );
  const aliases = gateway.payload.people.map(
    (person: PseudonymizedPerson) => person.alias,
  );
  const aliasFor = (personIndex: number | null): string | null =>
    personIndex === null ? null : (aliases[personIndex] ?? null);
  return {
    schema_version: "v1",
    company_name: snapshot.company_name,
    hiring_records: snapshot.hiring_records.map(
      ({
        local_id: _localId,
        person_index: _personIndex,
        advisor_or_person: _person,
        ...record
      }) => ({
        ...record,
        person_alias: aliasFor(_personIndex),
      }),
    ),
    selection_reports: snapshot.selection_reports.map(
      ({
        local_id: _localId,
        person_index: _personIndex,
        report_href: _href,
        ...record
      }) => ({
        ...record,
        person_alias: aliasFor(_personIndex),
      }),
    ),
    obog_available: snapshot.obog_available,
    replaced_person_count: gateway.manifest.replaced_person_count,
  };
}
