import { describe, expect, it } from "vitest";
import {
  advertiseReadOnlyTools,
  CHAT_TOOL_NAMES,
  isRegisteredReadOnlyTool,
  validateChatToolArguments,
} from "./tool-registry";

describe("chat tool registry", () => {
  it("exposes the complete read-only registry with stable intersections", () => {
    expect(CHAT_TOOL_NAMES).toHaveLength(21);
    const advertised = advertiseReadOnlyTools({
      locallyAvailable: new Set([
        "scombz_course_list",
        "library_catalog_search",
      ]),
      serverAllowed: new Set(["scombz_course_list", "library_catalog_search"]),
    });
    expect(advertised.map((item) => item.name)).toEqual([
      "scombz_course_list",
      "library_catalog_search",
    ]);
    expect(advertiseReadOnlyTools({ maxClientTools: 1 })).toHaveLength(1);
    expect(isRegisteredReadOnlyTool("library_action_submit")).toBe(false);
  });

  it("rejects unknown keys and invalid opaque references before execution", () => {
    expect(
      validateChatToolArguments("scombz_course_list", {
        academic_year: 2026,
        unknown: true,
      }),
    ).toEqual({ ok: false, reason: "unknown_argument" });
    expect(
      validateChatToolArguments("syllabus_read", {
        syllabus_ref: "https://example.invalid/detail",
      }),
    ).toEqual({ ok: false, reason: "invalid_syllabus_ref" });
  });

  it("validates read-only connector arguments at the shared boundary", () => {
    const courseRef = "orbit-scombz://course/abcdefghijklmnop";
    const cursor = "orbit-scombz://cursor/qrstuvwxyzabcdef";
    const libraryRef = "orbit-library://record/abcdefghijklmnop";
    expect(
      validateChatToolArguments("scombz_course_read", {
        course_refs: [courseRef],
        sections: ["assignments"],
        cursor,
        include_own_submission: false,
      }).ok,
    ).toBe(true);
    expect(
      validateChatToolArguments("scombz_material_search", {
        course_ref: courseRef,
        query: "形態素解析",
        cursor,
      }).ok,
    ).toBe(true);
    expect(
      validateChatToolArguments("scombz_course_read", {
        course_refs: ["course-1"],
      }),
    ).toEqual({ ok: false, reason: "invalid_course_refs" });
    expect(
      validateChatToolArguments("syllabus_search", { query: "  " }),
    ).toEqual({ ok: false, reason: "invalid_syllabus_query" });
    expect(
      validateChatToolArguments("browser_read_url", {
        url: "https://example.invalid/page?token=secret",
      }),
    ).toEqual({ ok: false, reason: "invalid_browser_url" });
    expect(
      validateChatToolArguments("browser_read_url", {
        url: "https://user:password@example.invalid/page",
      }),
    ).toEqual({ ok: false, reason: "invalid_browser_url" });
    expect(
      validateChatToolArguments("cast_search", { kind: "person" }),
    ).toEqual({ ok: false, reason: "invalid_cast_search_arguments" });
    expect(
      validateChatToolArguments("library_item_read", {
        resource_ref: libraryRef,
        presentation: "summary",
      }).ok,
    ).toBe(true);
    expect(
      validateChatToolArguments("library_item_read", {
        resource_ref: "record-1",
      }),
    ).toEqual({ ok: false, reason: "invalid_library_ref" });
  });
});
