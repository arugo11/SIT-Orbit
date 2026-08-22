import { describe, expect, it } from "vitest";
import { buildCastDecisionRoom } from "./cast-decision-room";
import type { CastHistoryLocalSnapshot } from "./cast-history-reports-reader";
import type { CastOpportunity } from "./cast-opportunities-reader";

const opportunity: CastOpportunity = {
  kind: "job",
  local_id: "job:AB-123",
  company_name: "Example Robotics",
  industry: ["ロボティクス", "機械"],
  status: "open",
  received_date: "2026-04-01",
  application_deadline: "2026-09-30",
  description: "組込み制御とソフトウェア開発",
  occupations: ["組込み開発", "研究開発"],
  locations: ["豊洲", "東京"],
  eligible_programs: ["機械系", "情報系"],
  target_grades: [],
  period_start: null,
  period_end: null,
  duration: [],
  application_methods: ["CASTから応募"],
  relations: {
    job_offer: true,
    company_session: false,
    internship: false,
    hiring_record: true,
    alumni_directory: true,
    career_supporter: true,
    entrance_exam: true,
  },
};

const history: CastHistoryLocalSnapshot = {
  schema_version: "v1",
  company_name: "Example Robotics",
  company_code: "987654",
  hiring_records: [
    {
      local_id: "employment:987654:0",
      graduation_date: "2024-03-01",
      academic_field: "機械",
      department: "機械工学科",
      advisor_or_person: "山田 太郎",
      employment_type: "正社員",
      job_type: "組込み開発",
      person_index: 0,
    },
  ],
  selection_reports: [
    {
      local_id: "exam:987654:0",
      graduation_date: "2024-03-01",
      academic_field: "機械",
      department: "機械工学科",
      gender: "",
      application_method: "自由応募",
      job_type: "組込み開発",
      has_reference_es: true,
      report_href: "https://shibaura.pita.services/career/report?private=1",
      person_index: 0,
    },
  ],
  people: [
    {
      name: "山田 太郎",
      source_identifier: "cast-person-0",
      role: "alumni",
      graduation_year: 2024,
      company: "Example Robotics",
      technical_domains: ["制御"],
      job_types: ["組込み開発"],
    },
  ],
  obog_available: true,
};

describe("buildCastDecisionRoom", () => {
  it("decomposes the comparison without a single compatibility score", () => {
    const room = buildCastDecisionRoom({
      opportunity,
      history,
      preferences: {
        technical_domains: ["機械"],
        locations: ["豊洲"],
        occupations: ["組込み開発"],
        hiring_record_year_from: 2022,
        hiring_record_year_to: 2026,
      },
      room_id: "decision-room:v1:test",
      reference_year: 2026,
    });
    expect(room.room_id).toBe("decision-room:v1:test");
    expect(room.assessments.map((assessment) => assessment.axis)).toEqual([
      "technical_domain",
      "location",
      "occupation",
      "hiring_record",
      "selection_process",
      "alumni_support",
      "deadline",
      "missing_information",
    ]);
    expect(
      room.assessments.find((item) => item.axis === "technical_domain")?.signal,
    ).toBe("match");
    expect(
      room.assessments.find((item) => item.axis === "location")?.signal,
    ).toBe("match");
    expect(
      room.assessments.find((item) => item.axis === "occupation")?.signal,
    ).toBe("match");
    expect(
      room.assessments.find((item) => item.axis === "hiring_record")?.signal,
    ).toBe("match");
    expect(
      room.assessments.find((item) => item.axis === "selection_process")
        ?.signal,
    ).toBe("match");
    expect(
      room.assessments.find((item) => item.axis === "alumni_support")?.signal,
    ).toBe("match");
    expect(room).not.toHaveProperty("score");
    expect(room).not.toHaveProperty("compatibility");
  });

  it("keeps unknown and mismatch distinct and exposes missing information", () => {
    const room = buildCastDecisionRoom({
      opportunity: {
        ...opportunity,
        status: "unknown",
        application_deadline: null,
        occupations: [],
        locations: [],
      },
      history: null,
      preferences: {
        technical_domains: ["量子工学"],
        locations: ["大宮"],
        occupations: ["データサイエンス"],
      },
      room_id: "decision-room:v1:unknown",
    });
    expect(
      room.assessments.find((item) => item.axis === "technical_domain")?.signal,
    ).toBe("mismatch");
    expect(
      room.assessments.find((item) => item.axis === "location")?.signal,
    ).toBe("unknown");
    expect(
      room.assessments.find((item) => item.axis === "hiring_record")?.signal,
    ).toBe("unknown");
    expect(
      room.assessments.find((item) => item.axis === "deadline")?.signal,
    ).toBe("unknown");
    expect(room.missing_information).toEqual(
      expect.arrayContaining(["勤務地", "応募締切", "過去の採用実績"]),
    );
    expect(room.next_steps.length).toBeGreaterThan(0);
  });

  it("does not expose private history fields or raw links in the room", () => {
    const room = buildCastDecisionRoom({ opportunity, history });
    const serialized = JSON.stringify(room);
    expect(serialized).not.toContain("山田 太郎");
    expect(serialized).not.toContain("987654");
    expect(serialized).not.toContain("report_href");
    expect(serialized).not.toContain("private=1");
    expect(serialized).toContain("CAST採用実績");
  });

  it("does not call a provider and reports absent alumni data as a separate axis", () => {
    const room = buildCastDecisionRoom({
      opportunity,
      history: {
        ...history,
        people: [],
        selection_reports: [],
        obog_available: false,
      },
      support: {
        schema_version: "v1",
        notices: [],
        resources: [],
        counseling_link_available: false,
        supporter_link_available: false,
      },
    });
    expect(
      room.assessments.find((item) => item.axis === "alumni_support")?.signal,
    ).toBe("mismatch");
    expect(
      room.assessments.find((item) => item.axis === "selection_process")
        ?.signal,
    ).toBe("unknown");
  });

  it("does not attach a history snapshot for another company or accept a non-opaque room ID", () => {
    expect(() =>
      buildCastDecisionRoom({
        opportunity,
        history: { ...history, company_name: "Other Company" },
        room_id: "山田 太郎",
      }),
    ).toThrow("opaque");
    const room = buildCastDecisionRoom({
      opportunity,
      history: { ...history, company_name: "Other Company" },
      room_id: "decision-room:v1:other-company",
    });
    expect(
      room.assessments.find((item) => item.axis === "hiring_record")?.signal,
    ).toBe("unknown");
  });

  it("rejects oversized preference input instead of silently changing the criteria", () => {
    expect(() =>
      buildCastDecisionRoom({
        opportunity,
        preferences: { locations: ["x".repeat(241)] },
      }),
    ).toThrow("maximum length");
  });
});
