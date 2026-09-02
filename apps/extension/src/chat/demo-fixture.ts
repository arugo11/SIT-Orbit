import type { ChatToolName, ChatToolResultRequest } from "../api/client";

const OBSERVED_AT = "2026-08-31T09:00:00+09:00";
const COURSE_REF = "orbit-scombz://course/demo-ai-course-2025";
const SYLLABUS_REF = "orbit-syllabus://result/demo-ai-syllabus-2025";

function coverage(scope: string) {
  return {
    scope,
    requested: 1,
    attempted: 1,
    succeeded: 1,
    failed: 0,
    truncated: false,
    next_cursor: null,
  };
}

function libraryResult(query: string): ChatToolResultRequest["result"] {
  const records: Record<string, ChatToolResultRequest["result"]> = {
    人工知能は人間を超えるか: {
      schema_version: "v1",
      status: "known",
      query,
      items: [
        {
          resource_ref: "orbit-library://record/demo-ai-book-available-01",
          title: query,
          authors: ["松尾豊"],
          subjects: ["人工知能"],
          isbn: "9784040800202",
          publisher: "KADOKAWA",
          publication_year: 2015,
          format: "book",
          campus: "omiya",
          url: "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/demo-ai-book-01",
          holdings: [
            {
              campus: "omiya",
              location: "大宮図書館 開架",
              call_number: "007.13||Ma85",
              status: "available",
              due_date: null,
              reservation_count: 0,
            },
          ],
          related_records: [],
        },
      ],
      reason_code: null,
    },
    "ゼロから作るDeep Learning": {
      schema_version: "v1",
      status: "known",
      query,
      items: [
        {
          resource_ref: "orbit-library://record/demo-dl-book-available-02",
          title: query,
          authors: ["斎藤康毅"],
          subjects: ["深層学習"],
          isbn: "9784873117584",
          publisher: "オライリー・ジャパン",
          publication_year: 2016,
          format: "book",
          campus: "toyosu",
          url: "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/demo-dl-book-02",
          holdings: [
            {
              campus: "toyosu",
              location: "豊洲図書館 開架",
              call_number: "007.13||Sa25",
              status: "available",
              due_date: null,
              reservation_count: 0,
            },
          ],
          related_records: [],
        },
      ],
      reason_code: null,
    },
    "強化学習 第2版": {
      schema_version: "v1",
      status: "known",
      query,
      items: [],
      reason_code: null,
    },
  };
  return (
    records[query] ?? {
      schema_version: "v1",
      status: "known",
      query,
      items: [],
      reason_code: null,
    }
  );
}

/** Deterministic read-only tool results compiled only into an explicit demo build. */
export function demoFixtureToolResult(
  name: ChatToolName,
  args: Record<string, unknown>,
): ChatToolResultRequest["result"] | null {
  if (name === "scombz_course_list") {
    return {
      schema_version: "v1",
      status: "known",
      courses: [
        {
          course_ref: COURSE_REF,
          display_name: "人工知能",
          academic_year: 2025,
          term: "前期",
          weekday: "水曜日",
          period: "3限",
          citation_uri: "orbit-scombz://citation/demo-ai-course-list-2025",
        },
      ],
      coverage: coverage("courses"),
      observed_at: OBSERVED_AT,
      reason_code: null,
    };
  }
  if (name === "scombz_course_read") {
    return {
      schema_version: "v1",
      status: "known",
      items: [
        {
          ref: "orbit-scombz://item/demo-ai-course-summary-2025",
          course_ref: COURSE_REF,
          section: "科目概要",
          title: "人工知能の基礎となる知識と理論",
          body: "探索、知識表現、機械学習、ニューラルネットワーク、強化学習までを全14回で学びます。",
          due_at: null,
          state: "published",
          has_pdf: false,
          observed_at: OBSERVED_AT,
          citation_uri: "orbit-scombz://citation/demo-ai-course-summary-2025",
        },
      ],
      section_states: { 科目概要: "complete" },
      coverage: coverage("course"),
      observed_at: OBSERVED_AT,
      reason_code: null,
    };
  }
  if (name === "syllabus_search") {
    const query = typeof args.query === "string" ? args.query : "人工知能";
    return {
      schema_version: "v1",
      status: "known",
      query,
      year: 2025,
      faculty: "工学部",
      results: [
        {
          syllabus_ref: SYLLABUS_REF,
          title: "人工知能",
          course_code: "01SU015623",
          faculty: "工学部",
          url: "https://syllabus.sic.shibaura-it.ac.jp/demo/ai-2025",
          snippet: "第8回 計画と決定2（強化学習）",
          citation_uri: "orbit-syllabus://citation/demo-ai-syllabus-2025",
        },
      ],
      observed_at: OBSERVED_AT,
      reason_code: null,
    };
  }
  if (name === "syllabus_read") {
    return {
      schema_version: "v1",
      status: "known",
      syllabus_ref: SYLLABUS_REF,
      url: "https://syllabus.sic.shibaura-it.ac.jp/demo/ai-2025",
      course_code: "01SU015623",
      title: "人工知能",
      instructors: ["担当教員"],
      objectives:
        "人工知能の基礎理論を理解し、代表的手法の考え方を説明できる。",
      weekly_plan: [
        "第1〜7回：探索・知識表現・計画と決定1",
        "第8回：計画と決定2（強化学習）／予習80分・復習80分",
        "第9〜14回：機械学習・ニューラルネットワーク・総括",
      ],
      evaluation: null,
      textbooks: [],
      prerequisites: null,
      observed_at: OBSERVED_AT,
      reason_code: null,
      citation_uri: "orbit-syllabus://citation/demo-ai-syllabus-2025",
    };
  }
  if (name === "cast_search") {
    return {
      schema_version: "v1",
      status: "known",
      applied_filters: {
        kind: "internship",
        filters: { include_closed: false },
        sort: null,
        graduation_years_defaulted: false,
      },
      total_count: 161,
      returned_count: 20,
      coverage: {
        mode: "page",
        page_size: 20,
        fetched_pages: 1,
        total_pages: 9,
      },
      anonymous_aggregates: [
        { dimension: "industry", value: "情報・通信", count: 161 },
        { dimension: "location", value: "首都圏", count: 96 },
      ],
      evidence_ids: [],
      reason_code: null,
    };
  }
  if (name === "library_catalog_search") {
    const query = typeof args.query === "string" ? args.query : "";
    return libraryResult(query);
  }
  return null;
}
