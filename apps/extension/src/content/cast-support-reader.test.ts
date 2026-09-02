import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  CAST_NOTION_EVENT_URL,
  CAST_NOTION_RECORDING_URL,
  extractCastSupportPage,
  isCastSupportPageUrl,
} from "./cast-support-reader";

describe("CAST linked support reader", () => {
  it("reads visible recording/event metadata without links or page internals", () => {
    const document = parseHTML(`<!doctype html><html><body>
      <main>
        <article><h2>就活講座 録画：ESの書き方</h2><p>2026-08-20</p><p>対象：学部生</p><p>概要：公開講座</p><a href="https://zoom.us/j/secret">Zoom</a></article>
        <article><h2>企業説明会スケジュール</h2><p>2026/09/01</p><p>対象学年：全学年</p></article>
      </main>
    </body></html>`).document;
    const recording = extractCastSupportPage(
      document,
      CAST_NOTION_RECORDING_URL,
      "recording",
    );
    expect(recording.status).toBe("known");
    if (recording.status !== "known") return;
    expect(recording.items[0]).toEqual(
      expect.objectContaining({
        title: "就活講座 録画:ESの書き方",
        date: "2026-08-20",
        target: "学部生",
      }),
    );
    expect(JSON.stringify(recording)).not.toContain("zoom.us");
    expect(JSON.stringify(recording)).not.toContain("secret");

    const event = extractCastSupportPage(
      document,
      CAST_NOTION_EVENT_URL,
      "career_event",
    );
    expect(event.status).toBe("known");
  });

  it("accepts only the two CAST-linked roots and fails closed on drift", () => {
    expect(isCastSupportPageUrl(CAST_NOTION_RECORDING_URL, "recording")).toBe(
      true,
    );
    expect(
      isCastSupportPageUrl(`${CAST_NOTION_RECORDING_URL}?pvs=4`, "recording"),
    ).toBe(true);
    expect(
      isCastSupportPageUrl(
        "https://evil.example.invalid/recording",
        "recording",
      ),
    ).toBe(false);
    const drifted = extractCastSupportPage(
      parseHTML("<main>404 System Error</main>").document,
      CAST_NOTION_RECORDING_URL,
      "recording",
    );
    expect(drifted).toEqual({
      status: "unavailable",
      reason_code: "support_page_unavailable",
    });
  });
});
