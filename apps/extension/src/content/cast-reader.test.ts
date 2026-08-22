import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  CAST_TOP_URL,
  extractCastDashboard,
  isCastReauthenticationUrl,
  isCastTopUrl,
  projectCastForAgent,
} from "./cast-reader";

const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/cast-top.html", import.meta.url)),
  "utf8",
);

function fixtureDocument(): Document {
  return parseHTML(fixture).document;
}

describe("CAST dashboard reader", () => {
  it("accepts only the confirmed top and reauthentication paths", () => {
    expect(isCastTopUrl(CAST_TOP_URL)).toBe(true);
    expect(isCastTopUrl("https://shibaura.pita.services/career/unknown")).toBe(
      false,
    );
    expect(
      isCastReauthenticationUrl(
        "https://shibaura.pita.services/career/session_timeout",
      ),
    ).toBe(true);
    expect(isCastTopUrl("https://example.com/career/top/student")).toBe(false);
  });

  it("keeps notice details local and projects only counts and a date", () => {
    const local = extractCastDashboard(fixtureDocument(), CAST_TOP_URL);
    expect(local).toEqual(
      expect.objectContaining({
        new_job_count: 4,
        new_internship_count: 7,
        new_event_count: 2,
        has_counseling_reservation: true,
      }),
    );
    expect(local?.notices).toHaveLength(2);
    if (!local) throw new Error("fixture extraction failed");
    expect(JSON.stringify(local)).not.toContain("保存してはいけない氏名");
    expect(JSON.stringify(local)).not.toContain("保存してはいけない応募履歴");
    const projection = projectCastForAgent(local);
    expect(projection).toEqual(
      expect.objectContaining({
        notice_count: 2,
        nearest_notice_date: "2026-08-20",
      }),
    );
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("合成キャリア講座");
    expect(serialized).not.toContain("応募履歴");
    expect(serialized).not.toContain("氏名");
  });

  it("fails closed for login pages and structural drift", () => {
    const login = fixtureDocument();
    login.body.innerHTML = '<input type="password" />';
    expect(extractCastDashboard(login, CAST_TOP_URL)).toBeNull();
    const drifted = fixtureDocument();
    drifted.querySelector("#company_session_count")?.remove();
    expect(extractCastDashboard(drifted, CAST_TOP_URL)).toBeNull();
  });
});
