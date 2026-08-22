import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  CAST_TOP_URL,
  extractCastSupportResources,
  projectCastSupportForAgent,
} from "./cast-support-resources-reader";

const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/cast-support-top.html", import.meta.url)),
  "utf8",
);

describe("CAST support resources reader", () => {
  it("extracts videos, events, counseling, and supporter links locally", () => {
    const snapshot = extractCastSupportResources(
      parseHTML(fixture).document,
      CAST_TOP_URL,
    );
    expect(snapshot).toEqual(
      expect.objectContaining({
        schema_version: "v1",
        counseling_link_available: true,
        supporter_link_available: true,
      }),
    );
    expect(snapshot?.notices[0]).toEqual(
      expect.objectContaining({
        title: "8月カウンセラー予定表",
        published_date: "2026-08-03",
      }),
    );
    expect(snapshot?.resources.map((resource) => resource.kind)).toEqual([
      "video",
      "event",
      "event",
      "counseling",
      "supporter",
    ]);
    const projection = snapshot ? projectCastSupportForAgent(snapshot) : null;
    expect(projection).toEqual({
      schema_version: "v1",
      status: "known",
      notice_count: 1,
      resource_count: 5,
      video_count: 1,
      event_count: 2,
      counseling_count: 1,
      supporter_count: 1,
      nearest_notice_date: "2026-08-03",
      reason_code: null,
    });
    expect(JSON.stringify(projection)).not.toContain("notion.site");
    expect(JSON.stringify(projection)).not.toContain("AL23088");
  });

  it("rejects unknown origins, login pages, and structural drift", () => {
    const unknownOnly = parseHTML(
      '<div id="job_offer_count">1</div><div id="internship_count">1</div><div id="company_session_count">1</div><a href="https://evil.example.invalid">スタッフ紹介</a>',
    ).document;
    expect(extractCastSupportResources(unknownOnly, CAST_TOP_URL)).toBeNull();

    const login = parseHTML(fixture).document;
    login.body.innerHTML = '<input type="password" />';
    expect(extractCastSupportResources(login, CAST_TOP_URL)).toBeNull();

    const drifted = parseHTML(fixture).document;
    drifted.querySelector("#job_offer_count")?.remove();
    expect(extractCastSupportResources(drifted, CAST_TOP_URL)).toBeNull();
  });
});
