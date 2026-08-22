import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  extractMoodleDashboard,
  isMoodleDashboardUrl,
  projectMoodleForAgent,
} from "./moodle-reader";

const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/moodle-dashboard.html", import.meta.url)),
  "utf8",
);

describe("Moodle dashboard reader", () => {
  it("accepts only the observed Moodle dashboard path", () => {
    expect(
      isMoodleDashboardUrl("https://moodle.sic.shibaura-it.ac.jp/moodle/my/"),
    ).toBe(true);
    expect(
      isMoodleDashboardUrl(
        "https://moodle.sic.shibaura-it.ac.jp/moodle/course/view.php?id=1",
      ),
    ).toBe(false);
    expect(isMoodleDashboardUrl("https://example.com/moodle/my/")).toBe(false);
  });

  it("keeps names local and projects only counts and deadlines", () => {
    const { document } = parseHTML(fixture);
    const snapshot = extractMoodleDashboard(
      document,
      "https://moodle.sic.shibaura-it.ac.jp/moodle/my/",
      new Date("2026-08-22T00:00:00+09:00"),
    );
    expect(snapshot).toEqual({
      courses: ["制御工学", "機械学習"],
      upcoming: [
        {
          title: "レポート1",
          course: "制御工学",
          due_at: "2026-08-24T06:00:00.000Z",
          overdue: false,
        },
        {
          title: "確認テスト",
          course: "機械学習",
          due_at: "2026-08-20T01:00:00.000Z",
          overdue: true,
        },
      ],
      unread_notification_count: 3,
    });
    expect(snapshot).not.toBeNull();
    if (!snapshot)
      throw new Error("Moodle fixture did not produce a snapshot.");
    const projection = projectMoodleForAgent(snapshot);
    expect(projection).toEqual({
      schema_version: "v1",
      status: "known",
      course_count: 2,
      upcoming_item_count: 2,
      overdue_count: 1,
      earliest_due_at: "2026-08-20T01:00:00.000Z",
      unread_notification_count: 3,
      reason_code: null,
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("嶋中");
    expect(serialized).not.toContain("制御工学");
    expect(serialized).not.toContain("secret-session-token");
    expect(serialized).not.toContain("レポート1");
  });
});
