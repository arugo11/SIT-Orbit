import { describe, expect, it } from "vitest";
import {
  createApplicationMission,
  reduceApplicationMission,
} from "./application-mission";
import type { CastChangeSet } from "./cast-change-feed";
import {
  type CastQualityReleaseInput,
  runCastQualityRelease,
} from "./cast-quality-release";

function completeMission() {
  let mission = createApplicationMission({
    target_local_id: "internship:robotics-2026",
    target_kind: "internship",
    display_label: "合成ロボティクス インターン",
  });
  mission = reduceApplicationMission(mission, {
    type: "requirements-confirmed",
    deadline: "2026-09-01",
    required_documents: ["履歴書"],
    source_ref: "cast-opportunity:1",
  });
  mission = reduceApplicationMission(mission, {
    type: "history-collected",
    source_refs: ["cast-history:1"],
  });
  mission = reduceApplicationMission(mission, {
    type: "evidence-collected",
    evidence_ids: ["evidence:1"],
  });
  mission = reduceApplicationMission(mission, {
    type: "es-drafted",
    draft_ref: "es-draft:1",
    review_refs: ["review:1"],
  });
  mission = reduceApplicationMission(mission, {
    type: "counseling-selected",
    resource_ref: "counseling:1",
  });
  mission = reduceApplicationMission(mission, {
    type: "calendar-previewed",
    preview_ref: "calendar-preview:1",
  });
  return reduceApplicationMission(mission, {
    type: "calendar-confirmed",
    confirmation_ref: "calendar-confirmation:1",
  });
}

const changeSet: CastChangeSet = {
  schema_version: "v1",
  status: "known",
  captured_at: "2026-08-22T00:00:00.000Z",
  previous_captured_at: "2026-08-21T00:00:00.000Z",
  changes: [
    {
      path: "opportunities[job:1].application_deadline",
      kind: "changed",
      category: "deadline",
      summary: "締切が変更されました",
    },
    {
      path: "opportunities[internship:2]",
      kind: "added",
      category: "internship",
      summary: "インターン情報が追加されました",
    },
  ],
};

const evidenceDraft = {
  schema_version: "v1" as const,
  prompt_version: "career-es-v1" as const,
  sentences: [
    {
      sentence_id: "es-sentence:0" as const,
      text: "要求仕様を整理しました。",
      evidence_ids: ["career-evidence:v1:0123456789abcdef0123456789abcdef"],
      grounding_quotes: ["要求仕様を整理"],
    },
  ],
  plain_text: "要求仕様を整理しました。",
  used_evidence_ids: ["career-evidence:v1:0123456789abcdef0123456789abcdef"],
};

function input(
  overrides: Partial<CastQualityReleaseInput> = {},
): CastQualityReleaseInput {
  return {
    pseudonymized_payload: {
      schema_version: "v1",
      destination: "local",
      people: [
        {
          alias: "先輩-ABCDEFGH",
          role: "alumni",
          company: "合成ロボティクス",
        },
      ],
      public_aggregates: [],
    },
    forbidden_terms: ["山田 太郎", "alumni-123", "student@example.invalid"],
    evidence_draft: evidenceDraft,
    change_set: changeSet,
    expected_change_keys: [
      "changed:opportunities[job:1].application_deadline",
      "added:opportunities[internship:2]",
    ],
    mission: completeMission(),
    performance: {
      cross_search_ms: [3, 8, 5],
      prompt_ms: [20, 10, 30, 40],
      pseudonymization_ms: [2, 2, 4],
    },
    ...overrides,
  };
}

describe("CAST quality release", () => {
  it("passes the complete synthetic release fixture and reports latency only as observations", () => {
    const report = runCastQualityRelease(input());

    expect(report.status).toBe("pass");
    expect(report.leakage_count).toBe(0);
    expect(report.evidence_sentence_count).toBe(1);
    expect(report.grounded_sentence_count).toBe(1);
    expect(report.change_precision).toBe(1);
    expect(report.change_recall).toBe(1);
    expect(report.performance.cross_search).toEqual({
      sample_count: 3,
      median_ms: 5,
      p95_ms: 8,
    });
    expect(JSON.stringify(report)).not.toContain("山田");
    expect(JSON.stringify(report)).not.toContain("alumni-123");
  });

  it("fails closed when a forbidden person or identifier remains in the payload", () => {
    const report = runCastQualityRelease(
      input({
        pseudonymized_payload: {
          schema_version: "v1",
          destination: "local",
          people: [
            {
              alias: "先輩-ABCDEFGH",
              role: "alumni",
              company: "山田 太郎",
            },
          ],
          public_aggregates: [],
        },
      }),
    );

    expect(report.status).toBe("fail");
    expect(
      report.checks.find((check) => check.id === "pseudonymization_leakage"),
    ).toMatchObject({ status: "fail", observed: 1, threshold: 0 });
  });

  it("fails when an ES sentence or change is not grounded exactly", () => {
    const firstSentence = evidenceDraft.sentences[0];
    if (!firstSentence) throw new Error("Fixture sentence is missing.");
    const report = runCastQualityRelease(
      input({
        evidence_draft: {
          ...evidenceDraft,
          sentences: [
            {
              ...firstSentence,
              evidence_ids: [],
              grounding_quotes: [],
            },
          ],
        },
        expected_change_keys: ["added:opportunities[internship:2]"],
      }),
    );

    expect(report.status).toBe("fail");
    expect(
      report.checks.find((check) => check.id === "evidence_coverage"),
    ).toMatchObject({ status: "fail", threshold: 1 });
    expect(
      report.checks.find((check) => check.id === "change_exactness"),
    ).toMatchObject({ status: "fail", threshold: 1 });
  });

  it("rejects a mission trace that confirms Calendar without a preview", () => {
    const invalidMission = {
      ...completeMission(),
      transitions: [
        {
          type: "calendar-confirmed" as const,
          step: "calendar" as const,
          recorded_at: "2026-08-22T00:00:00.000Z",
        },
      ],
    };
    const report = runCastQualityRelease(input({ mission: invalidMission }));

    expect(report.status).toBe("fail");
    expect(
      report.checks.find((check) => check.id === "mission_trace"),
    ).toMatchObject({ status: "fail", observed: false, threshold: true });
  });

  it("rejects invalid performance samples instead of hiding a measurement error", () => {
    expect(() =>
      runCastQualityRelease(input({ performance: { prompt_ms: [1, -1] } })),
    ).toThrow("finite non-negative");
  });
});
