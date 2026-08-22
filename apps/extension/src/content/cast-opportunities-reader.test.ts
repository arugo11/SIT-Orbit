import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  CAST_INTERNSHIP_SEARCH_URL,
  CAST_JOB_SEARCH_URL,
  extractCastOpportunities,
  isCastInternshipSearchUrl,
  isCastJobSearchUrl,
  projectCastOpportunitiesForAgent,
} from "./cast-opportunities-reader";

const jobFixture = readFileSync(
  fileURLToPath(
    new URL("./fixtures/cast-opportunities-job.html", import.meta.url),
  ),
  "utf8",
);
const internshipFixture = readFileSync(
  fileURLToPath(
    new URL("./fixtures/cast-opportunities-internship.html", import.meta.url),
  ),
  "utf8",
);

describe("CAST opportunities reader", () => {
  it("accepts only the observed search paths without query or fragment", () => {
    expect(isCastJobSearchUrl(CAST_JOB_SEARCH_URL)).toBe(true);
    expect(isCastJobSearchUrl(`${CAST_JOB_SEARCH_URL}?page=2`)).toBe(false);
    expect(isCastInternshipSearchUrl(CAST_INTERNSHIP_SEARCH_URL)).toBe(true);
    expect(
      isCastInternshipSearchUrl(
        "https://shibaura.pita.services/career/unknown",
      ),
    ).toBe(false);
    expect(
      isCastInternshipSearchUrl("https://example.com/career/internship_search"),
    ).toBe(false);
  });

  it("extracts a typed job snapshot and keeps raw details local", () => {
    const { document } = parseHTML(jobFixture);
    const snapshot = extractCastOpportunities(document, CAST_JOB_SEARCH_URL);
    expect(snapshot).toEqual({
      schema_version: "v1",
      kind: "job",
      opportunities: [
        expect.objectContaining({
          kind: "job",
          local_id: "job:27-12345",
          company_name: "合成ロボティクス株式会社",
          status: "open",
          received_date: "2026-08-21",
          application_deadline: "2027-03-31",
          occupations: ["開発・設計", "ＳＥ・プログラマー等"],
          locations: ["東京都", "埼玉県"],
          eligible_programs: ["機械工学科", "情報工学科"],
          application_methods: ["自由応募"],
          relations: expect.objectContaining({
            hiring_record: true,
            alumni_directory: true,
            career_supporter: true,
          }),
        }),
      ],
    });
    expect(snapshot?.opportunities[0]?.description).toContain(
      "制御ソフトウェア",
    );
    expect(JSON.stringify(snapshot)).toContain("合成ロボティクス");
    expect(JSON.stringify(snapshot)).not.toContain("AL23088");
    expect(JSON.stringify(snapshot)).not.toContain("学生 太郎");
    expect(JSON.stringify(snapshot)).not.toContain("student-name.pdf");
    const projection = snapshot
      ? projectCastOpportunitiesForAgent(snapshot)
      : null;
    expect(projection).toEqual({
      schema_version: "v1",
      status: "known",
      kind: "job",
      opportunity_count: 1,
      open_count: 1,
      closing_soon_count: 0,
      closed_count: 0,
      nearest_deadline: "2027-03-31",
      reason_code: null,
    });
    expect(JSON.stringify(projection)).not.toContain("合成ロボティクス");
    expect(JSON.stringify(projection)).not.toContain("制御ソフトウェア");
  });

  it("extracts internship period and target fields", () => {
    const { document } = parseHTML(internshipFixture);
    const snapshot = extractCastOpportunities(
      document,
      CAST_INTERNSHIP_SEARCH_URL,
    );
    expect(snapshot?.opportunities[0]).toEqual(
      expect.objectContaining({
        kind: "internship",
        company_name: "合成メカトロ株式会社",
        received_date: "2026-08-20",
        application_deadline: "2026-09-12",
        description: "制御工学と組込み開発を体験する1Dayプログラム。",
        locations: ["東京都"],
        target_grades: ["3年", "院1年"],
        eligible_programs: ["機械工学科", "機械制御システム学科"],
        period_start: "2026-09-20",
        period_end: "2026-09-20",
        duration: ["1日間"],
      }),
    );
    if (!snapshot) throw new Error("internship fixture extraction failed");
    expect(projectCastOpportunitiesForAgent(snapshot)).toEqual(
      expect.objectContaining({
        kind: "internship",
        opportunity_count: 1,
        nearest_deadline: "2026-09-12",
      }),
    );
  });

  it("does not treat login, drift, or unsearched pages as success", () => {
    const login = parseHTML(jobFixture).document;
    login.body.innerHTML = '<input type="password" />';
    expect(extractCastOpportunities(login, CAST_JOB_SEARCH_URL)).toBeNull();

    const drifted = parseHTML(jobFixture).document;
    drifted.querySelector(".panel .view-detail")?.remove();
    expect(extractCastOpportunities(drifted, CAST_JOB_SEARCH_URL)).toBeNull();

    const unsearched = parseHTML(
      "<p>該当数：0件</p><form><button>検索</button></form>",
    ).document;
    expect(
      extractCastOpportunities(unsearched, CAST_JOB_SEARCH_URL),
    ).toBeNull();
  });
});
