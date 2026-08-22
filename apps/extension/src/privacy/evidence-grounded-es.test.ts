import { afterEach, describe, expect, it, vi } from "vitest";
import type { CareerEvidencePromptItem } from "./career-evidence-bank";
import {
  createEvidenceGroundedEsPromptRequest,
  generateEvidenceGroundedEs,
  parseEvidenceGroundedEsResponse,
} from "./evidence-grounded-es";

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
  {
    evidence_id: "career-evidence:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    claim: "再現可能な実験を設計できる",
    context: "個人開発で評価条件が揃っていなかった",
    action: "評価手順と測定条件を文書化した",
    result: "同じ条件で比較できるようにした",
    source: "personal_project",
    material_count: 0,
  },
];

const firstEvidence = evidence[0];
if (!firstEvidence) {
  throw new Error("Evidence fixture is missing.");
}

const validResponse = {
  sentences: [
    {
      text: "PBLで要求仕様が不明確だった状況で、関係者3名にヒアリングして仕様を再定義し、手戻りを減らしました。",
      evidence_ids: [evidence[0]?.evidence_id],
      grounding_quotes: [
        "関係者3名にヒアリングして仕様を再定義した",
        "手戻りを減らした",
      ],
    },
  ],
};

describe("evidence-grounded ES", () => {
  afterEach(() => {
    delete (globalThis as typeof globalThis & { LanguageModel?: unknown })
      .LanguageModel;
    vi.restoreAllMocks();
  });

  it("builds a local-only prompt with no material locators", () => {
    const request = createEvidenceGroundedEsPromptRequest({
      target: "機械系の応募書類で、要求整理の経験を説明する",
      evidence,
    });
    expect(request.prompt).toContain("career-evidence:v1:aaaaaaaa");
    expect(request.prompt).toContain("grounding quote");
    expect(request.prompt).not.toContain("material_count");
    expect(request.prompt).not.toContain("orbit-evidence://");
    expect(request.responseConstraint.additionalProperties).toBe(false);
  });

  it("returns sentence-level evidence IDs and preserves grounded quotes", () => {
    const draft = parseEvidenceGroundedEsResponse(validResponse, evidence);
    expect(draft).toMatchObject({
      schema_version: "v1",
      prompt_version: "career-es-v1",
      used_evidence_ids: [evidence[0]?.evidence_id],
    });
    expect(draft.sentences[0]?.sentence_id).toBe("es-sentence:0");
    expect(draft.plain_text).toContain("関係者3名");
  });

  it("rejects unknown evidence IDs, unsupported numbers, and ungrounded quotes", () => {
    expect(() =>
      parseEvidenceGroundedEsResponse(
        {
          sentences: [
            {
              ...validResponse.sentences[0],
              evidence_ids: [
                "career-evidence:v1:cccccccccccccccccccccccccccccccc",
              ],
            },
          ],
        },
        evidence,
      ),
    ).toThrow("unknown evidence ID");

    expect(() =>
      parseEvidenceGroundedEsResponse(
        {
          sentences: [
            {
              ...validResponse.sentences[0],
              text: "関係者99名にヒアリングしました。",
              grounding_quotes: ["関係者3名にヒアリングして仕様を再定義した"],
            },
          ],
        },
        evidence,
      ),
    ).toThrow("unsupported number");

    expect(() =>
      parseEvidenceGroundedEsResponse(
        {
          sentences: [
            {
              ...validResponse.sentences[0],
              grounding_quotes: ["証拠に存在しない成果"],
            },
          ],
        },
        evidence,
      ),
    ).toThrow("not present");
  });

  it("rejects credential-like text before invoking the local model", () => {
    expect(() =>
      createEvidenceGroundedEsPromptRequest({
        target: "user@example.comの応募書類",
        evidence,
      }),
    ).toThrow("credential or student identifier");
    expect(() =>
      createEvidenceGroundedEsPromptRequest({
        target: "機械系の応募書類",
        evidence: [
          {
            ...firstEvidence,
            result: "担当者のaccess_tokenを使った",
          },
        ],
      }),
    ).toThrow("credential or student identifier");
  });

  it("uses only Chrome's local Prompt API and has no remote fallback", async () => {
    const destroy = vi.fn();
    const prompt = vi.fn(async () => JSON.stringify(validResponse));
    (
      globalThis as typeof globalThis & {
        LanguageModel?: unknown;
      }
    ).LanguageModel = {
      availability: async () => "available",
      create: async () => ({ prompt, destroy }),
    };
    await expect(
      generateEvidenceGroundedEs({
        target: "要求整理の経験を説明する",
        evidence,
      }),
    ).resolves.toMatchObject({ prompt_version: "career-es-v1" });
    expect(prompt).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
