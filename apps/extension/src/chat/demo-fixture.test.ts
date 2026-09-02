import { describe, expect, it } from "vitest";
import {
  isCastSearchResult,
  isLibraryCatalogSearchResult,
  isScombzCourseListResult,
  isScombzCourseReadResult,
  isSyllabusReadResult,
  isSyllabusSearchResult,
} from "../api/client";
import { demoFixtureToolResult } from "./demo-fixture";

describe("demoFixtureToolResult", () => {
  it("returns schema-valid results for the exact demo tool sequence", () => {
    expect(
      isScombzCourseListResult(demoFixtureToolResult("scombz_course_list", {})),
    ).toBe(true);
    expect(
      isScombzCourseReadResult(demoFixtureToolResult("scombz_course_read", {})),
    ).toBe(true);
    expect(
      isSyllabusSearchResult(
        demoFixtureToolResult("syllabus_search", { query: "強化学習" }),
      ),
    ).toBe(true);
    expect(
      isSyllabusReadResult(demoFixtureToolResult("syllabus_read", {})),
    ).toBe(true);
    expect(isCastSearchResult(demoFixtureToolResult("cast_search", {}))).toBe(
      true,
    );
    for (const title of [
      "人工知能は人間を超えるか",
      "ゼロから作るDeep Learning",
      "強化学習 第2版",
    ]) {
      expect(
        isLibraryCatalogSearchResult(
          demoFixtureToolResult("library_catalog_search", { query: title }),
        ),
      ).toBe(true);
    }
  });

  it("does not invent fixture results for tools outside the demo", () => {
    expect(
      demoFixtureToolResult("google_calendar_availability", {}),
    ).toBeNull();
  });
});
