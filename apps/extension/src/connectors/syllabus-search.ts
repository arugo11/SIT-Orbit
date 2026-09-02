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
  observed_at: string;
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
const SYLLABUS_BREAK_MARKER = "__ORBIT_BREAK__";

function stripMarkup(value: string): string {
  return value
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&#(\d+);/gu, (_match, code: string) => {
      const value = Number.parseInt(code, 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : "";
    })
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => {
      const value = Number.parseInt(code, 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : "";
    })
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
  const cleanWithBreaks = (value: string): string =>
    stripMarkup(value.replace(/<br\s*\/?>/giu, SYLLABUS_BREAK_MARKER))
      .replace(/[ \t]+/gu, " ")
      .replace(new RegExp(` *${SYLLABUS_BREAK_MARKER} *`, "gu"), "\n")
      .replace(/ *\n */gu, "\n")
      .trim()
      .slice(0, 6000);
  const doc =
    typeof DOMParser === "function"
      ? new DOMParser().parseFromString(html, "text/html")
      : null;
  const panelBlocks = (): Array<{
    heading: string;
    body: string;
    bodyHtml: string;
  }> => {
    if (!doc) return [];
    return Array.from(doc.querySelectorAll<HTMLElement>(".panel.panel-default"))
      .map((panel) => {
        const heading = clean(
          panel.querySelector(".panel-heading")?.textContent ?? "",
        );
        const bodyElement = panel.querySelector<HTMLElement>(".panel-body");
        return {
          heading,
          body: cleanWithBreaks(
            bodyElement?.innerHTML ?? bodyElement?.textContent ?? "",
          ),
          bodyHtml: bodyElement?.innerHTML ?? "",
        };
      })
      .filter((item) => item.heading || item.body);
  };
  const panels = panelBlocks();
  const panelFor = (
    labels: string[],
  ): { body: string; bodyHtml: string } | null => {
    const match = panels.find((panel) =>
      labels.some((label) => panel.heading.includes(label)),
    );
    return match ? { body: match.body, bodyHtml: match.bodyHtml } : null;
  };
  const listFromBody = (
    panel: { body: string; bodyHtml: string } | null,
  ): string[] => {
    if (!panel?.body) return [];
    const fromRows = [
      ...panel.bodyHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu),
    ]
      .map((match) => cleanWithBreaks(match[1] ?? ""))
      .filter((item) => item && !/^授業計画(?:\s|$)/u.test(item));
    const values =
      fromRows.length > 0
        ? fromRows
        : panel.body.split(/\n|(?=第\s*\d+\s*回)/u);
    return values
      .map((item) => clean(item))
      .filter(Boolean)
      .slice(0, 60);
  };
  const domResult: SyllabusDetailView | null = doc
    ? (() => {
        const instructorNames = Array.from(
          doc.querySelectorAll<HTMLElement>(
            ".teacher a, a[href*='resea.shibaura-it.ac.jp']",
          ),
        )
          .map((item) => clean(item.textContent ?? ""))
          .filter(Boolean)
          .filter((item, index, values) => values.indexOf(item) === index)
          .slice(0, 20);
        const courseCode =
          clean(
            doc.querySelector("#KamokuCD, [name='KamokuCD']")?.textContent ??
              "",
          ) || null;
        const title =
          clean(
            doc.querySelector(".kamoku.jpn, h1, .title")?.textContent ?? "",
          ) || null;
        const objective = panelFor(["授業の目的", "到達目標"]);
        const plan = panelFor(["授業計画", "授業内容"]);
        const evaluation = panelFor(["評価方法と基準", "評価方法", "成績評価"]);
        const textbooks = panelFor(["教科書・参考書", "教科書", "参考書"]);
        const prerequisites = panelFor([
          "履修登録前の準備",
          "前提条件",
          "履修条件",
          "前提",
        ]);
        return {
          course_code: courseCode,
          title,
          instructors: instructorNames,
          objectives: objective?.body || null,
          weekly_plan: listFromBody(plan),
          evaluation: evaluation?.body || null,
          textbooks: listFromBody(textbooks),
          prerequisites: prerequisites?.body || null,
        };
      })()
    : null;
  if (
    domResult &&
    (domResult.course_code || domResult.title || panels.length > 0)
  ) {
    return domResult;
  }

  // Service workers do not guarantee DOMParser.  Keep a bounded regex adapter
  // for the official static syllabus HTML so the same reader works from the
  // audit bridge without injecting a page parser or loading a remote library.
  const blocks = [
    ...html.matchAll(
      /<div\b[^>]*class=["'][^"']*panel\s+panel-default[^"']*["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*panel\s+panel-default|<\/body>|$)/giu,
    ),
  ].map((match) => match[1] ?? "");
  const fallbackPanel = (
    labels: string[],
  ): { body: string; bodyHtml: string } | null => {
    for (const block of blocks) {
      const heading = clean(
        block.match(
          /<div\b[^>]*class=["'][^"']*panel-heading[^"']*["'][^>]*>([\s\S]*?)<\/div>/iu,
        )?.[1] ?? "",
      );
      if (!labels.some((label) => heading.includes(label))) continue;
      const bodyHtml =
        block.match(
          /<div\b[^>]*class=["'][^"']*panel-body[^"']*["'][^>]*>([\s\S]*)/iu,
        )?.[1] ?? "";
      return { body: cleanWithBreaks(bodyHtml), bodyHtml };
    }
    return null;
  };
  const fallbackList = (
    panel: { body: string; bodyHtml: string } | null,
  ): string[] => {
    if (!panel?.body) return [];
    const rows = [...panel.bodyHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)]
      .map((match) => cleanWithBreaks(match[1] ?? ""))
      .filter(Boolean);
    return (rows.length > 0 ? rows : panel.body.split(/\n|(?=第\s*\d+\s*回)/u))
      .map((item) => clean(item))
      .filter(Boolean)
      .slice(0, 60);
  };
  const teacherMatches = [
    ...html.matchAll(
      /<td\b[^>]*class=["'][^"']*\bteacher\b[^"']*["'][^>]*>[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/giu,
    ),
  ]
    .map((match) => clean(match[1] ?? ""))
    .filter(Boolean)
    .filter((item, index, values) => values.indexOf(item) === index)
    .slice(0, 20);
  const fallbackObjective = fallbackPanel(["授業の目的", "到達目標"]);
  const fallbackPlan = fallbackPanel(["授業計画", "授業内容"]);
  const fallbackEvaluation = fallbackPanel([
    "評価方法と基準",
    "評価方法",
    "成績評価",
  ]);
  const fallbackTextbooks = fallbackPanel([
    "教科書・参考書",
    "教科書",
    "参考書",
  ]);
  const fallbackPrerequisites = fallbackPanel([
    "履修登録前の準備",
    "前提条件",
    "履修条件",
    "前提",
  ]);
  return {
    course_code:
      clean(html.match(/id=["']KamokuCD["'][^>]*>([^<]+)/iu)?.[1] ?? "") ||
      null,
    title:
      clean(
        html.match(
          /class=["'][^"']*\bkamoku\s+jpn\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/iu,
        )?.[1] ?? "",
      ) || null,
    instructors: teacherMatches,
    objectives: fallbackObjective?.body || null,
    weekly_plan: fallbackList(fallbackPlan),
    evaluation: fallbackEvaluation?.body || null,
    textbooks: fallbackList(fallbackTextbooks),
    prerequisites: fallbackPrerequisites?.body || null,
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
  const observedAt = new Date().toISOString();
  const dtPattern = /<dt\b[^>]*>([\s\S]*?)<\/dt>/giu;
  const resultFragments = [...html.matchAll(dtPattern)]
    .map((match) => match[1] ?? "")
    .filter((fragment) => /<a\b[^>]*href=/iu.test(fragment));
  // Namazu's result list is the only trusted result region.  Navigation or
  // footer anchors outside <dt> must never become syllabus candidates.
  for (const fragment of resultFragments) {
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
    observed_at: observedAt,
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
        observed_at: new Date().toISOString(),
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
      observed_at: new Date().toISOString(),
      reason_code: "network_error",
    };
  }
}
