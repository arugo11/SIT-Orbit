import type { SitrusGradeResult } from "../api/client";
import { SITRUS_ORIGIN } from "../content/page-context";

export const SITRUS_API_PATHS = {
  // These APIs are mounted at the origin root. The grade page itself lives
  // below /SITRUS/login and reaches them through ../../top and ../../app.
  token: "/top/app/Token",
  student: "/app/SITRUS/gakuseiInfoUser",
  courses: "/app/SITRUS/risyu",
  credits: "/app/SITRUS/JissekiSyukei",
} as const;

const MAX_RESPONSE_CHARS = 1_000_000;
const MAX_COURSES = 200;
const MAX_CREDIT_SUMMARIES = 200;
const STUDENT_HANDLE = /^[A-Za-z0-9._@-]{3,128}$/u;
const STUDENT_NUMBER = /^[A-Za-z0-9_-]{3,32}$/u;
const ALLOWED_GRADES = new Set([
  "S",
  "A",
  "B",
  "C",
  "D",
  "F",
  "G",
  "N",
  "X",
  "#",
]);

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type GradeItem = NonNullable<SitrusGradeResult["grades"]>[number];
type CreditSummary = NonNullable<SitrusGradeResult["credit_summaries"]>[number];

export class SitrusApiError extends Error {
  readonly reasonCode: string;
  readonly reauthRequired: boolean;

  constructor(reasonCode: string, reauthRequired = false) {
    super(reasonCode);
    this.name = "SitrusApiError";
    this.reasonCode = reasonCode;
    this.reauthRequired = reauthRequired;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/<[^>]*>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned ? cleaned.slice(0, maximum) : null;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(?:\.0+)?$/u.test(value.trim())
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function parseEmbeddedJson(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current === "string") {
      try {
        current = JSON.parse(current) as unknown;
        continue;
      } catch {
        return current;
      }
    }
    if (isRecord(current) && Array.isArray(current.d)) {
      current = current.d;
      continue;
    }
    if (
      isRecord(current) &&
      (current.Result === "true" || current.Result === true) &&
      current.Message !== undefined
    ) {
      current = current.Message;
      continue;
    }
    break;
  }
  return current;
}

async function fetchJson(
  fetcher: FetchLike,
  path: string,
  query?: URLSearchParams,
): Promise<unknown> {
  const url = new URL(path, SITRUS_ORIGIN);
  if (query) url.search = query.toString();
  const response = await fetcher(url.toString(), {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (response.status === 401 || response.status === 403) {
    throw new SitrusApiError("login_required", true);
  }
  if (!response.ok) throw new SitrusApiError("sitrus_endpoint_failed");
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_CHARS) {
    throw new SitrusApiError("response_too_large");
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new SitrusApiError("response_too_large");
  }
  if (/^\s*</u.test(text)) {
    throw new SitrusApiError("login_required", true);
  }
  try {
    return parseEmbeddedJson(JSON.parse(text) as unknown);
  } catch {
    throw new SitrusApiError("invalid_json_response");
  }
}

function findStringField(
  value: unknown,
  keys: readonly string[],
): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const found = cleanString(value[key], 128);
    if (found) return found;
  }
  for (const key of ["id_data", "data", "user"] as const) {
    const nested = value[key];
    if (isRecord(nested)) {
      const found = findStringField(nested, keys);
      if (found) return found;
    }
  }
  return null;
}

function recordArray(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown>[] {
  const parsed = parseEmbeddedJson(value);
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  if (!isRecord(parsed)) return [];
  for (const key of keys) {
    const candidate = parseEmbeddedJson(parsed[key]);
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [parsed];
}

function termNumber(value: unknown): number | null {
  const numeric = boundedInteger(value, 1, 3);
  if (numeric !== null) return numeric;
  const label = cleanString(value, 40);
  if (!label) return null;
  if (/前期|春|spring/iu.test(label)) return 1;
  if (/後期|秋|fall|autumn/iu.test(label)) return 2;
  if (/通年|year/iu.test(label)) return 3;
  return null;
}

function projectGrades(value: unknown): GradeItem[] {
  const rows = recordArray(value, ["risyu", "items", "data"]);
  const result: GradeItem[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, MAX_COURSES * 2)) {
    const subject = cleanString(row.kamoku_name, 200);
    const grade = cleanString(row.hyoka, 4)?.toUpperCase() ?? null;
    if (!subject || !grade || !ALLOWED_GRADES.has(grade)) continue;
    const year = boundedInteger(row.kaiko_nendo, 2000, 2100);
    const term = termNumber(row.ki_name);
    const key = `${subject}\u0000${grade}\u0000${year ?? ""}\u0000${term ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      subject,
      credits: boundedInteger(row.tani_su, 0, 20),
      grade: grade as GradeItem["grade"],
      outcome: cleanString(row.hantei_name, 40),
      year,
      term,
    });
    if (result.length >= MAX_COURSES) break;
  }
  return result;
}

function projectCreditSummaries(value: unknown): CreditSummary[] {
  const rows = recordArray(value, ["jissekiSyukei", "items", "data"]);
  const result: CreditSummary[] = [];
  for (const row of rows.slice(0, MAX_CREDIT_SUMMARIES * 2)) {
    const category = cleanString(row.keiretu_title, 100);
    const currentCourseCount = boundedInteger(
      row.kamoku_su_latest ?? row.toki_kamoku,
      0,
      10_000,
    );
    const currentCredits = boundedInteger(
      row.tani_su_latest ?? row.toki_tani,
      0,
      10_000,
    );
    const cumulativeCourseCount = boundedInteger(row.kamoku_su, 0, 10_000);
    const cumulativeCredits = boundedInteger(row.tani_su, 0, 10_000);
    if (
      !category ||
      currentCourseCount === null ||
      currentCredits === null ||
      cumulativeCourseCount === null ||
      cumulativeCredits === null
    ) {
      continue;
    }
    result.push({
      category,
      credit_type: cleanString(row.tani_title, 40),
      current_course_count: currentCourseCount,
      current_credits: currentCredits,
      cumulative_course_count: cumulativeCourseCount,
      cumulative_credits: cumulativeCredits,
    });
    if (result.length >= MAX_CREDIT_SUMMARIES) break;
  }
  return result;
}

export async function readAuthenticatedSitrusGrades(
  fetcher: FetchLike = fetch,
  now: () => Date = () => new Date(),
): Promise<SitrusGradeResult> {
  const token = await fetchJson(fetcher, SITRUS_API_PATHS.token);
  const handle = findStringField(token, ["preferred_username", "cardsubject"]);
  if (!handle || !STUDENT_HANDLE.test(handle)) {
    throw new SitrusApiError("login_required", true);
  }

  const student = await fetchJson(
    fetcher,
    SITRUS_API_PATHS.student,
    new URLSearchParams({ cardsubject: handle }),
  );
  const studentRows = recordArray(student, ["gakuseiInfo", "items", "data"]);
  const studentNumber = studentRows
    .map((row) => findStringField(row, ["gakuseki_no"]))
    .find((value): value is string =>
      Boolean(value && STUDENT_NUMBER.test(value)),
    );
  if (!studentNumber)
    throw new SitrusApiError("student_identity_unavailable", true);

  const studentQuery = new URLSearchParams({ gakusei_no: studentNumber });
  const [courses, credits] = await Promise.all([
    fetchJson(fetcher, SITRUS_API_PATHS.courses, studentQuery),
    fetchJson(fetcher, SITRUS_API_PATHS.credits, studentQuery),
  ]);
  const grades = projectGrades(courses);
  const creditSummaries = projectCreditSummaries(credits);
  if (grades.length === 0 && creditSummaries.length === 0) {
    throw new SitrusApiError("sitrus_structure_changed");
  }
  return {
    schema_version: "v1",
    status: "known",
    report_label: "取得済み科目・単位数",
    grades,
    credit_summaries: creditSummaries,
    observed_at: now().toISOString(),
    reason_code: null,
  };
}

/**
 * Auth-only preflight for Chat Tool advertisement.
 *
 * The token endpoint is queried and the opaque handle is discarded.  No
 * student identity, grades, response body, or error text leaves this module.
 */
export async function checkSitrusAuthentication(
  fetcher: FetchLike = fetch,
): Promise<boolean> {
  try {
    const token = await fetchJson(fetcher, SITRUS_API_PATHS.token);
    const handle = findStringField(token, [
      "preferred_username",
      "cardsubject",
    ]);
    return Boolean(handle && STUDENT_HANDLE.test(handle));
  } catch {
    return false;
  }
}
