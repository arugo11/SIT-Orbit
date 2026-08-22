import { afterEach, describe, expect, it, vi } from "vitest";
import type { CareerEvidencePromptItem } from "./career-evidence-bank";
import type { EvidenceGroundedEsDraft } from "./evidence-grounded-es";
import {
  CAREER_REVIEW_PERSPECTIVES,
  collectCareerReviewDisagreements,
  createCareerReviewPromptRequest,
  parseCareerPerspectiveReviewResponse,
  reviewCareerDraft,
} from "./multi-perspective-career-review";

const evidence: CareerEvidencePromptItem[] = [
  {
    evidence_id: "career-evidence:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    claim: "曖昧な課題を整理できる",
    context: "PBLで要求仕様が不明確だった",
    action: "関係者3名にヒアリングして仕様を再定義した",
    result: "手戻りを減らした",
    source: "pbl",
    material_count: 1,
  },
];

const firstEvidence = evidence[0];
if (!firstEvidence) throw new Error("Evidence fixture is missing.");
const firstEvidenceId = firstEvidence.evidence_id;

const draft: EvidenceGroundedEsDraft = {
  schema_version: "v1",
  prompt_version: "career-es-v1",
  sentences: [
    {
      sentence_id: "es-sentence:0",
      text: "PBLで要求仕様が不明確な状況で、関係者3名にヒアリングして仕様を再定義し、手戻りを減らしました。",
      evidence_ids: [firstEvidenceId],
      grounding_quotes: [
        "関係者3名にヒアリングして仕様を再定義した",
        "手戻りを減らした",
      ],
    },
  ],
  plain_text:
    "PBLで要求仕様が不明確な状況で、関係者3名にヒアリングして仕様を再定義し、手戻りを減らしました。",
  used_evidence_ids: [firstEvidenceId],
};

function validReview(verdict: "clear" | "needs_revision" = "clear") {
  return {
    verdict,
    findings: [
      {
        kind: "strength",
        text: "要求整理の行動と結果が具体的に示されています。",
        sentence_ids: ["es-sentence:0"],
        evidence_ids: [firstEvidenceId],
      },
    ],
  };
}

describe("multi-perspective career review", () => {
  afterEach(() => {
    delete (globalThis as typeof globalThis & { LanguageModel?: unknown })
      .LanguageModel;
    vi.restoreAllMocks();
  });

  it("creates an independent perspective prompt without scores or private locators", () => {
    const request = createCareerReviewPromptRequest(
      { draft, evidence },
      "technical",
    );
    expect(request.prompt).toContain("技術部門視点");
    expect(request.prompt).toContain("es-sentence:0");
    expect(request.prompt).not.toContain("相性");
    expect(request.prompt).not.toContain("person_ref");
    expect(request.responseConstraint.additionalProperties).toBe(false);
  });

  it("parses a review while preserving perspective-specific findings", () => {
    const review = parseCareerPerspectiveReviewResponse(
      validReview(),
      "hr",
      draft,
      evidence,
    );
    expect(review).toMatchObject({
      perspective: "hr",
      perspective_label: "人事視点",
      verdict: "clear",
    });
    expect(review.findings[0]?.evidence_ids).toEqual([firstEvidenceId]);
  });

  it("rejects unknown references, scores, unsupported numbers, and uncited strengths", () => {
    expect(() =>
      parseCareerPerspectiveReviewResponse(
        {
          ...validReview(),
          score: 87,
        },
        "hr",
        draft,
        evidence,
      ),
    ).toThrow("unsupported field");

    expect(() =>
      parseCareerPerspectiveReviewResponse(
        {
          findings: [
            {
              ...validReview().findings[0],
              sentence_ids: ["es-sentence:999"],
            },
          ],
          verdict: "clear",
        },
        "hr",
        draft,
        evidence,
      ),
    ).toThrow("unknown sentence");

    expect(() =>
      parseCareerPerspectiveReviewResponse(
        {
          findings: [
            {
              ...validReview().findings[0],
              kind: "gap",
              text: "99件の成果を追記してください。",
              evidence_ids: [],
            },
          ],
          verdict: "needs_revision",
        },
        "hr",
        draft,
        evidence,
      ),
    ).toThrow("unsupported number");

    expect(() =>
      parseCareerPerspectiveReviewResponse(
        {
          findings: [
            {
              ...validReview().findings[0],
              evidence_ids: [],
            },
          ],
          verdict: "clear",
        },
        "hr",
        draft,
        evidence,
      ),
    ).toThrow("strength must cite evidence");
  });

  it("keeps disagreements separate instead of merging verdicts", () => {
    const clear = parseCareerPerspectiveReviewResponse(
      validReview("clear"),
      "hr",
      draft,
      evidence,
    );
    const needsRevision = parseCareerPerspectiveReviewResponse(
      validReview("needs_revision"),
      "technical",
      draft,
      evidence,
    );
    const disagreements = collectCareerReviewDisagreements([
      clear,
      needsRevision,
    ]);
    expect(disagreements).toEqual([
      {
        dimension: "verdict",
        perspectives: ["hr", "technical"],
        verdicts: ["clear", "needs_revision"],
      },
    ]);
  });

  it("runs four independent local Prompt API sessions", async () => {
    const prompts: string[] = [];
    const destroy = vi.fn();
    (
      globalThis as typeof globalThis & { LanguageModel?: unknown }
    ).LanguageModel = {
      availability: async () => "available",
      create: async () => ({
        prompt: async (value: string) => {
          prompts.push(value);
          return JSON.stringify(
            validReview(
              value.includes("技術部門視点") ? "needs_revision" : "clear",
            ),
          );
        },
        destroy,
      }),
    };
    const bundle = await reviewCareerDraft({ draft, evidence });
    expect(bundle.reviews).toHaveLength(CAREER_REVIEW_PERSPECTIVES.length);
    expect(
      new Set(
        prompts.map((prompt) => prompt.match(/レビュー視点: (.+)/u)?.[1]),
      ),
    ).toEqual(new Set(CAREER_REVIEW_PERSPECTIVES.map((item) => item.label)));
    expect(bundle.disagreements[0]?.dimension).toBe("verdict");
    expect(destroy).toHaveBeenCalledTimes(CAREER_REVIEW_PERSPECTIVES.length);
  });
});
