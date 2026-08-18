import { describe, expect, it } from "vitest";
import { parseSyllabusSearchHtml } from "./syllabus-search";

describe("official syllabus adapter", () => {
  it("accepts only official HTTPS result links", () => {
    const result = parseSyllabusSearchHtml(
      `<a href="/course/1">微積分学</a>
       <a href="https://example.com/no">外部</a>
       <a href="javascript:alert(1)">危険</a>`,
      "微積分",
      2026,
      "工学部",
    );
    expect(result.results).toEqual([
      {
        title: "微積分学",
        course_code: null,
        faculty: "工学部",
        url: "https://syllabus.sic.shibaura-it.ac.jp/course/1",
        snippet: null,
      },
    ]);
  });
});
