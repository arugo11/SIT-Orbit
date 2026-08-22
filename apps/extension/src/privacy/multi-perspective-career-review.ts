import type { CareerEvidencePromptItem } from "./career-evidence-bank";
import { type LocalPromptRequest, runLocalPrompt } from "./career-prompt";
import type { EvidenceGroundedEsDraft } from "./evidence-grounded-es";

export const CAREER_REVIEW_PERSPECTIVES = [
  {
    id: "hr",
    label: "人事視点",
    instruction:
      "応募書類として結論が明快か、役割への貢献が読み取れるか、過度な誇張がないかを確認してください。",
  },
  {
    id: "technical",
    label: "技術部門視点",
    instruction:
      "技術的な判断、制約、再現可能な行動が具体的かを確認してください。証拠にない技術要素は要求しないでください。",
  },
  {
    id: "shibaura_alumni",
    label: "芝浦卒業生視点",
    instruction:
      "学生の経験が自然に伝わり、芝浦の学生としての学び方・姿勢が読み取れるかを確認してください。個人名や校内情報を推測しないでください。",
  },
  {
    id: "first_reader",
    label: "初見の第三者視点",
    instruction:
      "前提知識のない読み手でも理解でき、主張と根拠の対応が追えるかを確認してください。",
  },
] as const;

export type CareerReviewPerspectiveId =
  (typeof CAREER_REVIEW_PERSPECTIVES)[number]["id"];
export type CareerReviewVerdict =
  | "clear"
  | "needs_revision"
  | "insufficient_evidence";
export type CareerReviewFindingKind = "strength" | "gap";

export interface CareerReviewFinding {
  kind: CareerReviewFindingKind;
  text: string;
  sentence_ids: string[];
  evidence_ids: string[];
}

export interface CareerPerspectiveReview {
  perspective: CareerReviewPerspectiveId;
  perspective_label: string;
  verdict: CareerReviewVerdict;
  findings: CareerReviewFinding[];
}

export interface CareerReviewDisagreement {
  dimension: "verdict";
  perspectives: CareerReviewPerspectiveId[];
  verdicts: CareerReviewVerdict[];
}

export interface MultiPerspectiveCareerReview {
  schema_version: "v1";
  reviews: CareerPerspectiveReview[];
  disagreements: CareerReviewDisagreement[];
}

export interface MultiPerspectiveCareerReviewInput {
  draft: EvidenceGroundedEsDraft;
  evidence: CareerEvidencePromptItem[];
}

export interface CareerReviewPromptRequest
  extends LocalPromptRequest<CareerPerspectiveReview> {}

const MAX_FINDINGS = 8;
const MAX_FINDING_LENGTH = 500;
const MAX_SENTENCES_PER_FINDING = 4;
const MAX_EVIDENCE_PER_FINDING = 8;
const MAX_EVIDENCE_ITEMS = 48;
const EVIDENCE_ID_PATTERN = /^career-evidence:v1:[a-f0-9]{32}$/u;
const SENTENCE_ID_PATTERN = /^es-sentence:\d+$/u;
const VALID_VERDICTS = new Set<CareerReviewVerdict>([
  "clear",
  "needs_revision",
  "insufficient_evidence",
]);
const VALID_FINDING_KINDS = new Set<CareerReviewFindingKind>([
  "strength",
  "gap",
]);

export const CAREER_REVIEW_RESPONSE_CONSTRAINT: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: {
      type: "string",
      enum: ["clear", "needs_revision", "insufficient_evidence"],
    },
    findings: {
      type: "array",
      minItems: 1,
      maxItems: MAX_FINDINGS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["strength", "gap"] },
          text: { type: "string", minLength: 1, maxLength: MAX_FINDING_LENGTH },
          sentence_ids: {
            type: "array",
            minItems: 1,
            maxItems: MAX_SENTENCES_PER_FINDING,
            items: { type: "string" },
          },
          evidence_ids: {
            type: "array",
            maxItems: MAX_EVIDENCE_PER_FINDING,
            items: { type: "string" },
          },
        },
        required: ["kind", "text", "sentence_ids", "evidence_ids"],
      },
    },
  },
  required: ["verdict", "findings"],
};

function compact(value: string, limit: number): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error("Career review text must not be empty.");
  if (normalized.length > limit) {
    throw new Error("Career review text exceeds the maximum length.");
  }
  return normalized;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error(`${label} contains an unsupported field.`);
  }
}

function rejectCredentialLikeText(value: string): void {
  if (
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(value) ||
    /(?:access[_-]?token|id[_-]?token|refresh[_-]?token|session|cookie|password|oauth|authorization)/iu.test(
      value,
    ) ||
    /\b[A-Z]{1,5}[-_ ]?\d{5,}\b/iu.test(value)
  ) {
    throw new Error(
      "Career review contains a credential or student identifier.",
    );
  }
}

function numericTokens(value: string): string[] {
  return (value.normalize("NFKC").match(/[0-9]+(?:[.,][0-9]+)*/gu) ?? []).map(
    (token) => token.replace(/[.,]/gu, ""),
  );
}

function sourceText(item: CareerEvidencePromptItem): string {
  return [item.claim, item.context, item.action, item.result].join(" ");
}

function perspective(
  id: CareerReviewPerspectiveId,
): (typeof CAREER_REVIEW_PERSPECTIVES)[number] {
  const found = CAREER_REVIEW_PERSPECTIVES.find((item) => item.id === id);
  if (!found) throw new Error("Unknown career review perspective.");
  return found;
}

function validateInput(
  input: MultiPerspectiveCareerReviewInput,
): Map<string, CareerEvidencePromptItem> {
  if (!input.evidence.length || input.evidence.length > MAX_EVIDENCE_ITEMS) {
    throw new Error("Career review evidence count is out of bounds.");
  }
  const evidenceById = new Map<string, CareerEvidencePromptItem>();
  for (const item of input.evidence) {
    if (!EVIDENCE_ID_PATTERN.test(item.evidence_id)) {
      throw new Error("Career review contains an invalid evidence ID.");
    }
    if (evidenceById.has(item.evidence_id)) {
      throw new Error("Career review contains duplicate evidence IDs.");
    }
    const text = [item.claim, item.context, item.action, item.result]
      .map((value) => compact(value, 4000))
      .join(" ");
    rejectCredentialLikeText(text);
    evidenceById.set(item.evidence_id, {
      ...item,
      claim: compact(item.claim, 4000),
      context: compact(item.context, 4000),
      action: compact(item.action, 4000),
      result: compact(item.result, 4000),
    });
  }
  const sentenceIds = new Set<string>();
  if (
    input.draft.schema_version !== "v1" ||
    input.draft.prompt_version !== "career-es-v1" ||
    !input.draft.sentences.length
  ) {
    throw new Error("Career review draft schema is invalid.");
  }
  for (const sentence of input.draft.sentences) {
    if (!SENTENCE_ID_PATTERN.test(sentence.sentence_id)) {
      throw new Error("Career review contains an invalid sentence ID.");
    }
    if (sentenceIds.has(sentence.sentence_id)) {
      throw new Error("Career review contains duplicate sentence IDs.");
    }
    sentenceIds.add(sentence.sentence_id);
    const text = compact(sentence.text, 700);
    rejectCredentialLikeText(text);
    if (
      sentence.evidence_ids.length === 0 ||
      sentence.evidence_ids.some((evidenceId) => !evidenceById.has(evidenceId))
    ) {
      throw new Error("Career review draft cites unknown evidence.");
    }
  }
  return evidenceById;
}

function draftForPrompt(draft: EvidenceGroundedEsDraft): string {
  return JSON.stringify(
    draft.sentences.map((sentence) => ({
      sentence_id: sentence.sentence_id,
      text: sentence.text,
      evidence_ids: sentence.evidence_ids,
      grounding_quotes: sentence.grounding_quotes,
    })),
  );
}

function evidenceForPrompt(evidence: CareerEvidencePromptItem[]): string {
  return JSON.stringify(
    evidence.map(({ evidence_id, claim, context, action, result, source }) => ({
      evidence_id,
      claim,
      context,
      action,
      result,
      source,
    })),
  );
}

function parseFinding(
  value: unknown,
  sentencesById: Map<string, string>,
  evidenceById: Map<string, CareerEvidencePromptItem>,
): CareerReviewFinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Career review finding must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  assertAllowedKeys(
    candidate,
    ["kind", "text", "sentence_ids", "evidence_ids"],
    "Career review finding",
  );
  if (
    typeof candidate.kind !== "string" ||
    !VALID_FINDING_KINDS.has(candidate.kind as CareerReviewFindingKind)
  ) {
    throw new Error("Career review finding kind is invalid.");
  }
  const text = compact(
    typeof candidate.text === "string" ? candidate.text : "",
    MAX_FINDING_LENGTH,
  );
  rejectCredentialLikeText(text);
  if (!Array.isArray(candidate.sentence_ids)) {
    throw new Error("Career review finding must reference sentences.");
  }
  const referencedSentences = candidate.sentence_ids.map((item) => {
    if (typeof item !== "string" || !sentencesById.has(item)) {
      throw new Error("Career review finding references an unknown sentence.");
    }
    return item;
  });
  if (
    referencedSentences.length === 0 ||
    referencedSentences.length > MAX_SENTENCES_PER_FINDING ||
    new Set(referencedSentences).size !== referencedSentences.length
  ) {
    throw new Error("Career review sentence references are out of bounds.");
  }
  if (!Array.isArray(candidate.evidence_ids)) {
    throw new Error("Career review finding must include evidence IDs.");
  }
  const referencedEvidence = candidate.evidence_ids.map((item) => {
    if (typeof item !== "string" || !evidenceById.has(item)) {
      throw new Error("Career review finding references unknown evidence.");
    }
    return item;
  });
  if (
    referencedEvidence.length > MAX_EVIDENCE_PER_FINDING ||
    new Set(referencedEvidence).size !== referencedEvidence.length
  ) {
    throw new Error("Career review evidence references are out of bounds.");
  }
  if (candidate.kind === "strength" && referencedEvidence.length === 0) {
    throw new Error("A career review strength must cite evidence.");
  }
  const citedText = referencedEvidence
    .map((evidenceId) => evidenceById.get(evidenceId))
    .filter((item): item is CareerEvidencePromptItem => item !== undefined)
    .map(sourceText)
    .join(" ");
  const sentenceText = referencedSentences
    .map((sentenceId) => sentencesById.get(sentenceId) ?? "")
    .join(" ");
  const availableNumbers = new Set(
    numericTokens(`${citedText} ${sentenceText}`),
  );
  if (numericTokens(text).some((token) => !availableNumbers.has(token))) {
    throw new Error("Career review finding contains an unsupported number.");
  }
  return {
    kind: candidate.kind as CareerReviewFindingKind,
    text,
    sentence_ids: referencedSentences,
    evidence_ids: referencedEvidence,
  };
}

export function parseCareerPerspectiveReviewResponse(
  value: unknown,
  perspectiveId: CareerReviewPerspectiveId,
  draft: EvidenceGroundedEsDraft,
  evidence: CareerEvidencePromptItem[],
): CareerPerspectiveReview {
  const evidenceById = validateInput({ draft, evidence });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Career review response must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  assertAllowedKeys(
    candidate,
    ["verdict", "findings"],
    "Career review response",
  );
  if (
    typeof candidate.verdict !== "string" ||
    !VALID_VERDICTS.has(candidate.verdict as CareerReviewVerdict)
  ) {
    throw new Error("Career review verdict is invalid.");
  }
  if (!Array.isArray(candidate.findings)) {
    throw new Error("Career review response must contain findings.");
  }
  if (
    candidate.findings.length === 0 ||
    candidate.findings.length > MAX_FINDINGS
  ) {
    throw new Error("Career review finding count is out of bounds.");
  }
  const sentencesById = new Map(
    draft.sentences.map((sentence) => [sentence.sentence_id, sentence.text]),
  );
  const findings = candidate.findings.map((finding) =>
    parseFinding(finding, sentencesById, evidenceById),
  );
  const descriptor = perspective(perspectiveId);
  return {
    perspective: descriptor.id,
    perspective_label: descriptor.label,
    verdict: candidate.verdict as CareerReviewVerdict,
    findings,
  };
}

export function createCareerReviewPromptRequest(
  input: MultiPerspectiveCareerReviewInput,
  perspectiveId: CareerReviewPerspectiveId,
): CareerReviewPromptRequest {
  validateInput(input);
  const descriptor = perspective(perspectiveId);
  return {
    prompt: [
      "あなたはSIT ORBITの端末内ESレビュアーです。",
      `レビュー視点: ${descriptor.label}`,
      descriptor.instruction,
      "この視点だけで独立にレビューし、他の視点の結論を推測・統合しないでください。",
      "総合点、順位、採用確率は出さず、strengthまたはgapとして説明してください。",
      "各findingは確認対象のsentence_idsを参照し、strengthにはevidence_idsを必ず付けてください。",
      "証拠にない数値、人物情報、成果、事実を作らないでください。",
      `ES(JSON): ${draftForPrompt(input.draft)}`,
      `確認済み証拠(JSON): ${evidenceForPrompt(input.evidence)}`,
      "JSON以外を返さないでください。",
    ].join("\n"),
    responseConstraint: CAREER_REVIEW_RESPONSE_CONSTRAINT,
    parse: (value) =>
      parseCareerPerspectiveReviewResponse(
        value,
        perspectiveId,
        input.draft,
        input.evidence,
      ),
  };
}

export function collectCareerReviewDisagreements(
  reviews: CareerPerspectiveReview[],
): CareerReviewDisagreement[] {
  const verdicts = Array.from(new Set(reviews.map((review) => review.verdict)));
  if (verdicts.length < 2) return [];
  return [
    {
      dimension: "verdict",
      perspectives: reviews.map((review) => review.perspective),
      verdicts,
    },
  ];
}

export async function reviewCareerDraft(
  input: MultiPerspectiveCareerReviewInput,
): Promise<MultiPerspectiveCareerReview> {
  validateInput(input);
  const reviews: CareerPerspectiveReview[] = [];
  for (const descriptor of CAREER_REVIEW_PERSPECTIVES) {
    const request = createCareerReviewPromptRequest(input, descriptor.id);
    reviews.push(await runLocalPrompt(request));
  }
  return {
    schema_version: "v1",
    reviews,
    disagreements: collectCareerReviewDisagreements(reviews),
  };
}
