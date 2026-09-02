import { SITRUS_ORIGIN } from "./page-context";

/** Local-only representation used while parsing the visible grade report. */
export interface SitrusLocalGradeItem {
  subject: string;
  course_code: string | null;
  credits: number | null;
  grade: "S" | "A" | "B" | "C" | "D" | "F" | "G" | "N" | "X" | "#";
  outcome: string | null;
  year: number | null;
  term: number | null;
  term_slot: number | null;
  repeated: boolean;
}

export interface SitrusLocalGradeResult {
  schema_version: "v1";
  status: "known" | "unavailable";
  report_label: string | null;
  grades: SitrusLocalGradeItem[];
  credit_summaries: never[];
  cumulative_gpa: number | null;
  observed_at: string;
  reason_code: string | null;
}

export interface SitrusTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const COURSE_CODE = /(?:[A-Z]\d{7}|\d{8})/u;
const GRADE = /\*?[SABCDFGNX#]/u;
const MAX_ITEMS = 10_000;
type SitrusGrade = SitrusLocalGradeItem;
type SitrusGrades = SitrusLocalGradeItem[];

export interface SitrusTableRow {
  result: string;
  grade: string;
  subject: string;
}

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

function unavailable(reason_code: string): SitrusLocalGradeResult {
  return {
    schema_version: "v1",
    status: "unavailable",
    report_label: null,
    grades: [],
    credit_summaries: [],
    cumulative_gpa: null,
    observed_at: new Date().toISOString(),
    reason_code,
  };
}

function isSitrusPath(url: string, path: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === SITRUS_ORIGIN &&
      parsed.pathname === path &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

function cleanSubject(value: string): string {
  return value
    .replace(/[【】<>＜＞]/gu, " ")
    .replace(/^[\s\d・]+/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
}

function rowForSegment(segment: string): SitrusGrade | null {
  const codeMatch = segment.match(COURSE_CODE);
  if (!codeMatch || codeMatch.index === undefined) return null;
  const courseCode = codeMatch[0];
  const subject = cleanSubject(segment.slice(0, codeMatch.index));
  if (!subject) return null;
  const afterCode = segment.slice(codeMatch.index + courseCode.length);
  const gradeMatch = afterCode.match(GRADE);
  if (!gradeMatch || gradeMatch.index === undefined) return null;
  const gradeToken = gradeMatch[0];
  const grade = gradeToken.replace("*", "") as SitrusGrade["grade"];
  const numbersBefore = [
    ...afterCode.slice(0, gradeMatch.index).matchAll(/\d+/gu),
  ].map((match) => Number(match[0]));
  const numbersAfter = [
    ...afterCode.slice(gradeMatch.index + gradeToken.length).matchAll(/\d+/gu),
  ].map((match) => Number(match[0]));
  const credits = numbersBefore.length >= 2 ? (numbersBefore[1] ?? null) : null;
  const yearIndex = numbersAfter.findIndex(
    (value) => value >= 20 && value <= 99,
  );
  const yearValue = yearIndex >= 0 ? numbersAfter[yearIndex] : undefined;
  const year = yearValue === undefined ? null : 2000 + yearValue;
  const term =
    (yearIndex >= 0
      ? numbersAfter
          .slice(0, yearIndex)
          .find((value) => value >= 1 && value <= 3)
      : numbersAfter.find((value) => value >= 1 && value <= 3)) ?? null;
  const termSlot =
    (yearIndex >= 0
      ? numbersAfter
          .slice(yearIndex + 1)
          .find((value) => value >= 1 && value <= 4)
      : undefined) ?? null;
  return {
    subject,
    course_code: courseCode,
    credits,
    grade,
    outcome: null,
    year,
    term,
    term_slot: termSlot,
    repeated: gradeToken.startsWith("*"),
  };
}

function lineGroups(items: SitrusTextItem[]): string[] {
  const sorted = [...items].sort((left, right) => {
    if (Math.abs(left.y - right.y) > 2) return right.y - left.y;
    return left.x - right.x;
  });
  const lines: string[] = [];
  let currentY: number | null = null;
  let current: SitrusTextItem[] = [];
  const flush = () => {
    if (current.length > 0) {
      lines.push(
        [...current]
          .sort((left, right) => left.x - right.x)
          .map((item) => item.str)
          .join(" "),
      );
    }
    current = [];
  };
  for (const item of sorted) {
    if (currentY === null || Math.abs(item.y - currentY) <= 2) {
      currentY ??= item.y;
      current.push(item);
    } else {
      flush();
      currentY = item.y;
      current.push(item);
    }
  }
  flush();
  return lines;
}

export function parseSitrusGradeProjection(
  rawItems: SitrusTextItem[],
  url: string,
): SitrusLocalGradeResult {
  if (!isSitrusPath(url, "/SITRUS/login/SeisekiTsutiSho.html")) {
    return unavailable("invalid_grade_url");
  }
  const items = rawItems
    .filter((item) => item && typeof item.str === "string" && item.str.trim())
    .slice(0, MAX_ITEMS);
  const lines = lineGroups(items);
  const allText = [...lines, ...items.map((item) => item.str)].join(" ");
  const grades: SitrusGrades = [];
  for (const line of lines) {
    const matches = [...line.matchAll(new RegExp(COURSE_CODE.source, "gu"))];
    for (let index = 0; index < matches.length; index += 1) {
      const previous = matches[index - 1];
      const next = matches[index + 1];
      const start =
        index === 0 ? 0 : (previous?.index ?? 0) + (previous?.[0]?.length ?? 0);
      const end = next?.index ?? line.length;
      const row = rowForSegment(line.slice(start, end));
      if (
        row &&
        !grades.some(
          (item) =>
            item.course_code === row.course_code &&
            item.subject === row.subject,
        )
      ) {
        grades.push(row);
      }
    }
  }
  const gpaMatch = allText.match(/累積\s*GPA\s*([0-4](?:\.\d+)?)/u);
  const reportMatch = allText.match(/(\d{4}\s*年度\s*.{0,30}?分まで)/u);
  if (grades.length === 0 && !gpaMatch && !reportMatch) {
    return unavailable("grade_text_unparsed");
  }
  return {
    schema_version: "v1",
    status: "known",
    report_label: reportMatch?.[1]?.replace(/\s+/gu, " ").trim() ?? null,
    grades: grades.slice(0, 200),
    credit_summaries: [],
    cumulative_gpa: gpaMatch ? Number(gpaMatch[1]) : null,
    observed_at: new Date().toISOString(),
    reason_code: null,
  };
}

/**
 * Parse the visible HTML table linked as "取得済み単位数" in SITRUS.
 * The summary page does not expose course codes or credits, so those fields
 * remain null instead of being fabricated from the subject name.
 */
export function parseSitrusGradeTableProjection(
  rows: SitrusTableRow[],
  url: string,
): SitrusLocalGradeResult {
  if (!isSitrusPath(url, "/SITRUS/login/ShutokuTaniShukei.html")) {
    return unavailable("invalid_grade_url");
  }

  const grades: SitrusGrades = [];
  for (const raw of rows.slice(0, 200)) {
    if (!raw || typeof raw !== "object") continue;
    const subject = cleanSubject(raw.subject);
    const result = raw.result.replace(/\s+/gu, " ").trim().slice(0, 40);
    const grade = raw.grade.trim().toUpperCase();
    if (!result || !subject || !ALLOWED_GRADES.has(grade)) continue;
    if (
      grades.some((item) => item.subject === subject && item.grade === grade)
    ) {
      continue;
    }
    grades.push({
      subject,
      course_code: null,
      credits: null,
      grade: grade as SitrusGrade["grade"],
      outcome: result,
      year: null,
      term: null,
      term_slot: null,
      repeated: false,
    });
  }

  if (grades.length === 0) return unavailable("grade_table_unparsed");
  return {
    schema_version: "v1",
    status: "known",
    report_label: "取得済み科目",
    grades,
    credit_summaries: [],
    cumulative_gpa: null,
    observed_at: new Date().toISOString(),
    reason_code: null,
  };
}
