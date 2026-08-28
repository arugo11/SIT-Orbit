import Encoding from "encoding-japanese";

export interface SyllabusSearchResultView {
  schema_version: "v1";
  status: "known" | "unavailable";
  query: string;
  year: number | null;
  faculty: string | null;
  results: Array<{
    title: string;
    syllabus_ref: string;
    course_code: string | null;
    faculty: string | null;
    url: string;
    snippet: string | null;
    citation_uri: string | null;
  }>;
  reason_code: string | null;
}

export interface SyllabusDetailView {
  course_code: string | null;
  title: string | null;
  instructors: string[];
  objectives: string | null;
  weekly_plan: string[];
  evaluation: string | null;
  textbooks: string[];
  prerequisites: string | null;
}

export const SYLLABUS_SEARCH_ORIGIN = "https://syllabus.sic.shibaura-it.ac.jp";

function stripMarkup(value: string): string {
  return value
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/\s+/gu, " ")
    .trim();
}

function safeOfficialUrl(value: string): string | null {
  try {
    const url = new URL(value, SYLLABUS_SEARCH_ORIGIN);
    if (
      url.origin !== SYLLABUS_SEARCH_ORIGIN &&
      url.origin !== "http://syllabus.sic.shibaura-it.ac.jp"
    ) {
      return null;
    }
    if (url.username || url.password || url.hash) return null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.protocol = "https:";
    return url.href;
  } catch {
    return null;
  }
}

function syllabusRef(): string {
  const id =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `orbit-syllabus://result/${id.replace(/[^A-Za-z0-9_-]/gu, "")}`;
}

function eucJpEscape(value: string): string {
  const bytes = Encoding.convert(
    Encoding.stringToCode(value),
    "EUCJP",
    "UNICODE",
  );
  return bytes
    .map(
      (byte: number) => `%${byte.toString(16).padStart(2, "0").toUpperCase()}`,
    )
    .join("");
}

export function parseSyllabusDetailHtml(html: string): SyllabusDetailView {
  const clean = (value: string): string =>
    stripMarkup(value)
      .replace(/[\u00a0\t]+/gu, " ")
      .trim()
      .slice(0, 6000);
  const doc =
    typeof DOMParser === "function"
      ? new DOMParser().parseFromString(html, "text/html")
      : null;
  const headings = doc
    ? Array.from(doc.querySelectorAll("h1, h2, h3, dt, th, .heading"))
    : [];
  const valueFor = (labels: string[]): string | null => {
    const heading = headings.find((node) =>
      labels.some((label) => clean(node.textContent ?? "").includes(label)),
    );
    if (!heading) return null;
    const sibling = heading.nextElementSibling;
    return sibling ? clean(sibling.textContent ?? "") || null : null;
  };
  const listFor = (labels: string[]): string[] => {
    const value = valueFor(labels);
    if (!value) return [];
    return value
      .split(/\n|(?=第\s*\d+\s*回)/u)
      .map((item) => clean(item))
      .filter(Boolean)
      .slice(0, 60);
  };
  return {
    course_code:
      clean(
        doc?.querySelector("#KamokuCD, [name='KamokuCD']")?.textContent ?? "",
      ) || null,
    title: clean(doc?.querySelector("h1, .title")?.textContent ?? "") || null,
    instructors: valueFor(["担当教員", "教員"])
      ? [valueFor(["担当教員", "教員"]) as string]
      : [],
    objectives: valueFor(["授業の目的", "到達目標"]),
    weekly_plan: listFor(["授業計画", "授業内容"]),
    evaluation: valueFor(["評価方法", "成績評価"]),
    textbooks: listFor(["教科書", "参考書"]),
    prerequisites: valueFor(["前提", "履修条件"]),
  };
}

/** Parse only official syllabus result anchors from a public HTML fixture. */
export function parseSyllabusSearchHtml(
  html: string,
  query: string,
  year: number | null = null,
  faculty: string | null = null,
): SyllabusSearchResultView {
  const results: SyllabusSearchResultView["results"] = [];
  const dtPattern = /<dt\b[^>]*>([\s\S]*?)<\/dt>/giu;
  const resultFragments = [...html.matchAll(dtPattern)]
    .map((match) => match[1] ?? "")
    .filter((fragment) => /<a\b[^>]*href=/iu.test(fragment));
  const fragments =
    resultFragments.length > 0
      ? resultFragments
      : [
          ...html.matchAll(
            /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu,
          ),
        ].map((match) => `<a href="${match[1] ?? ""}">${match[2] ?? ""}</a>`);
  for (const fragment of fragments) {
    const match = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/iu.exec(
      fragment,
    );
    if (!match) continue;
    const url = safeOfficialUrl(match[1] ?? "");
    const title = stripMarkup(match[2] ?? "");
    if (!url || !title || results.some((item) => item.url === url)) continue;
    results.push({
      title: title.slice(0, 300),
      syllabus_ref: syllabusRef(),
      course_code: null,
      faculty,
      url,
      snippet: null,
      citation_uri: `orbit-syllabus://citation/${results.length}`,
    });
    if (results.length >= 20) break;
  }
  return {
    schema_version: "v1",
    status: "known",
    query,
    year,
    faculty,
    results,
    reason_code: null,
  };
}

export async function searchOfficialSyllabus(
  query: string,
  year: number | null = null,
  faculty: string | null = null,
  fetcher: typeof fetch = fetch,
): Promise<SyllabusSearchResultView> {
  const params = [
    `query=${eucJpEscape(query)}`,
    "whence=0",
    "max=100",
    "result=normal",
    "sort=score",
  ];
  const targetYear = year ?? new Date().getFullYear();
  const facultyIndex: Record<string, string> = {
    工学部: "ko1",
    システム理工学部: "sys",
    デザイン工学部: "dsn",
    建築学部: "arc",
    大学院: "din",
  };
  const selectedIndexes =
    faculty && facultyIndex[faculty]
      ? [facultyIndex[faculty]]
      : ["ko1", "sys", "dsn", "arc", "din"];
  for (const index of selectedIndexes) {
    params.push(`idxname=${encodeURIComponent(`${targetYear}/${index}`)}`);
  }
  const url = `${SYLLABUS_SEARCH_ORIGIN}/namazu/namazu.cgi?${params.join("&")}`;
  try {
    const response = await fetcher(url, { credentials: "omit" });
    if (!response.ok) {
      return {
        schema_version: "v1",
        status: "unavailable",
        query,
        year,
        faculty,
        results: [],
        reason_code: `http_${response.status}`,
      };
    }
    const parsed = parseSyllabusSearchHtml(
      await response.text(),
      query,
      year,
      faculty,
    );
    return parsed;
  } catch {
    return {
      schema_version: "v1",
      status: "unavailable",
      query,
      year,
      faculty,
      results: [],
      reason_code: "network_error",
    };
  }
}
