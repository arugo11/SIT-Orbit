export interface SyllabusSearchResultView {
  schema_version: "v1";
  status: "known" | "unavailable";
  query: string;
  year: number | null;
  faculty: string | null;
  results: Array<{
    title: string;
    course_code: string | null;
    faculty: string | null;
    url: string;
    snippet: string | null;
  }>;
  reason_code: string | null;
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
    return url.origin === SYLLABUS_SEARCH_ORIGIN && url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Parse only official syllabus result anchors from a public HTML fixture. */
export function parseSyllabusSearchHtml(
  html: string,
  query: string,
  year: number | null = null,
  faculty: string | null = null,
): SyllabusSearchResultView {
  const results: SyllabusSearchResultView["results"] = [];
  const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu;
  for (const match of html.matchAll(pattern)) {
    const url = safeOfficialUrl(match[1] ?? "");
    const title = stripMarkup(match[2] ?? "");
    if (!url || !title || results.some((item) => item.url === url)) continue;
    results.push({
      title: title.slice(0, 300),
      course_code: null,
      faculty,
      url,
      snippet: null,
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
  const url = new URL("/namazu/", SYLLABUS_SEARCH_ORIGIN);
  url.searchParams.set("query", query);
  if (year !== null) url.searchParams.set("year", String(year));
  if (faculty) url.searchParams.set("faculty", faculty);
  try {
    const response = await fetcher(url.href, { credentials: "omit" });
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
    return parseSyllabusSearchHtml(await response.text(), query, year, faculty);
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
