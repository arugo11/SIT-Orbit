import type { CareerEvidencePromptItem } from "./career-evidence-bank";
import { type LocalPromptRequest, runLocalPrompt } from "./career-prompt";

const EVIDENCE_ID_PATTERN = /^career-evidence:v1:[a-f0-9]{32}$/u;
const MAX_TARGET_LENGTH = 600;
const MAX_EVIDENCE_ITEMS = 48;
const MAX_SENTENCES = 12;
const MAX_SENTENCE_LENGTH = 700;
const MAX_EVIDENCE_IDS_PER_SENTENCE = 8;
const MAX_QUOTES_PER_SENTENCE = 4;
const MAX_QUOTE_LENGTH = 240;
const VALID_EVIDENCE_SOURCES = new Set([
  "course",
  "research",
  "pbl",
  "club",
  "part_time",
  "personal_project",
  "other",
]);

export interface EvidenceGroundedEsInput {
  target: string;
  evidence: CareerEvidencePromptItem[];
}

export interface EvidenceGroundedEsSentence {
  sentence_id: `es-sentence:${number}`;
  text: string;
  evidence_ids: string[];
  grounding_quotes: string[];
}

export interface EvidenceGroundedEsDraft {
  schema_version: "v1";
  prompt_version: "career-es-v1";
  sentences: EvidenceGroundedEsSentence[];
  plain_text: string;
  used_evidence_ids: string[];
}

export interface EvidenceGroundedEsPromptRequest
  extends LocalPromptRequest<EvidenceGroundedEsDraft> {}

export const EVIDENCE_GROUNDED_ES_RESPONSE_CONSTRAINT: Record<string, unknown> =
  {
    type: "object",
    additionalProperties: false,
    properties: {
      sentences: {
        type: "array",
        minItems: 1,
        maxItems: MAX_SENTENCES,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: {
              type: "string",
              minLength: 1,
              maxLength: MAX_SENTENCE_LENGTH,
            },
            evidence_ids: {
              type: "array",
              minItems: 1,
              maxItems: MAX_EVIDENCE_IDS_PER_SENTENCE,
              items: { type: "string" },
            },
            grounding_quotes: {
              type: "array",
              minItems: 1,
              maxItems: MAX_QUOTES_PER_SENTENCE,
              items: {
                type: "string",
                minLength: 1,
                maxLength: MAX_QUOTE_LENGTH,
              },
            },
          },
          required: ["text", "evidence_ids", "grounding_quotes"],
        },
      },
    },
    required: ["sentences"],
  };

function compact(value: string, limit: number): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized)
    throw new Error("Evidence-grounded ES text must not be empty.");
  if (normalized.length > limit) {
    throw new Error("Evidence-grounded ES text exceeds the maximum length.");
  }
  return normalized;
}

function assertEvidenceId(value: string): void {
  if (!EVIDENCE_ID_PATTERN.test(value)) {
    throw new Error("Evidence-grounded ES contains an invalid evidence ID.");
  }
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
      "Evidence-grounded ES prompt contains a credential or student identifier.",
    );
  }
}

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function sourceText(item: CareerEvidencePromptItem): string {
  return [item.claim, item.context, item.action, item.result]
    .map((value) => compact(value, 4000))
    .join(" ");
}

function validateEvidence(
  evidence: CareerEvidencePromptItem[],
): CareerEvidencePromptItem[] {
  if (evidence.length === 0) {
    throw new Error("At least one confirmed career evidence item is required.");
  }
  if (evidence.length > MAX_EVIDENCE_ITEMS) {
    throw new Error("Too many career evidence items for one ES draft.");
  }
  const seen = new Set<string>();
  return evidence.map((item) => {
    assertEvidenceId(item.evidence_id);
    if (seen.has(item.evidence_id)) {
      throw new Error("Duplicate career evidence ID.");
    }
    seen.add(item.evidence_id);
    if (!VALID_EVIDENCE_SOURCES.has(item.source)) {
      throw new Error(
        "Evidence-grounded ES contains an invalid evidence source.",
      );
    }
    if (
      !Number.isSafeInteger(item.material_count) ||
      item.material_count < 0 ||
      item.material_count > 12
    ) {
      throw new Error(
        "Evidence-grounded ES contains an invalid material count.",
      );
    }
    const normalizedItem: CareerEvidencePromptItem = {
      evidence_id: item.evidence_id,
      claim: compact(item.claim, 4000),
      context: compact(item.context, 4000),
      action: compact(item.action, 4000),
      result: compact(item.result, 4000),
      source: item.source,
      material_count: Number.isSafeInteger(item.material_count)
        ? item.material_count
        : 0,
    };
    rejectCredentialLikeText(sourceText(normalizedItem));
    return normalizedItem;
  });
}

function promptEvidence(evidence: CareerEvidencePromptItem[]): string {
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

function numericTokens(value: string): string[] {
  return (normalized(value).match(/[0-9]+(?:[.,][0-9]+)*/gu) ?? []).map(
    (token) => token.replace(/[.,]/gu, ""),
  );
}

function quoteMatchesEvidence(
  quote: string,
  cited: CareerEvidencePromptItem[],
): boolean {
  const normalizedQuote = normalized(quote);
  if (!normalizedQuote) return false;
  return cited.some((item) =>
    [item.claim, item.context, item.action, item.result].some((field) =>
      normalized(field).includes(normalizedQuote),
    ),
  );
}

function parseSentence(
  value: unknown,
  index: number,
  evidenceById: Map<string, CareerEvidencePromptItem>,
): EvidenceGroundedEsSentence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Evidence-grounded ES sentence must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  assertAllowedKeys(
    candidate,
    ["text", "evidence_ids", "grounding_quotes"],
    "ES sentence",
  );
  const text = compact(
    typeof candidate.text === "string" ? candidate.text : "",
    MAX_SENTENCE_LENGTH,
  );
  rejectCredentialLikeText(text);
  if (!Array.isArray(candidate.evidence_ids)) {
    throw new Error("Each ES sentence must cite evidence IDs.");
  }
  const evidenceIds = candidate.evidence_ids.map((item) => {
    if (typeof item !== "string") {
      throw new Error("Each ES evidence ID must be a string.");
    }
    assertEvidenceId(item);
    if (!evidenceById.has(item)) {
      throw new Error("Evidence-grounded ES contains an unknown evidence ID.");
    }
    return item;
  });
  if (
    evidenceIds.length === 0 ||
    evidenceIds.length > MAX_EVIDENCE_IDS_PER_SENTENCE ||
    new Set(evidenceIds).size !== evidenceIds.length
  ) {
    throw new Error("Each ES sentence must cite unique, bounded evidence IDs.");
  }
  if (!Array.isArray(candidate.grounding_quotes)) {
    throw new Error("Each ES sentence must include a grounding quote.");
  }
  const quotes = candidate.grounding_quotes.map((item) => {
    if (typeof item !== "string") {
      throw new Error("Each grounding quote must be a string.");
    }
    return compact(item, MAX_QUOTE_LENGTH);
  });
  if (
    quotes.length === 0 ||
    quotes.length > MAX_QUOTES_PER_SENTENCE ||
    new Set(quotes).size !== quotes.length
  ) {
    throw new Error("Each ES sentence must include unique, bounded quotes.");
  }
  const cited = evidenceIds.flatMap((id) => {
    const item = evidenceById.get(id);
    return item ? [item] : [];
  });
  if (!quotes.every((quote) => quoteMatchesEvidence(quote, cited))) {
    throw new Error(
      "An ES grounding quote is not present in the cited evidence.",
    );
  }
  const source = cited.map(sourceText).join(" ");
  const sourceNumbers = new Set(numericTokens(source));
  if (numericTokens(text).some((token) => !sourceNumbers.has(token))) {
    throw new Error("Evidence-grounded ES contains an unsupported number.");
  }
  return {
    sentence_id: `es-sentence:${index}`,
    text,
    evidence_ids: evidenceIds,
    grounding_quotes: quotes,
  };
}

export function parseEvidenceGroundedEsResponse(
  value: unknown,
  evidence: CareerEvidencePromptItem[],
): EvidenceGroundedEsDraft {
  const validatedEvidence = validateEvidence(evidence);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Evidence-grounded ES response must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  assertAllowedKeys(candidate, ["sentences"], "Evidence-grounded ES response");
  if (!Array.isArray(candidate.sentences)) {
    throw new Error("Evidence-grounded ES response must contain sentences.");
  }
  if (
    candidate.sentences.length === 0 ||
    candidate.sentences.length > MAX_SENTENCES
  ) {
    throw new Error("Evidence-grounded ES sentence count is out of bounds.");
  }
  const evidenceById = new Map(
    validatedEvidence.map((item) => [item.evidence_id, item]),
  );
  const sentences = candidate.sentences.map((sentence, index) =>
    parseSentence(sentence, index, evidenceById),
  );
  const usedEvidenceIds = Array.from(
    new Set(sentences.flatMap((sentence) => sentence.evidence_ids)),
  );
  return {
    schema_version: "v1",
    prompt_version: "career-es-v1",
    sentences,
    plain_text: sentences.map((sentence) => sentence.text).join("\n"),
    used_evidence_ids: usedEvidenceIds,
  };
}

export function createEvidenceGroundedEsPromptRequest(
  input: EvidenceGroundedEsInput,
): EvidenceGroundedEsPromptRequest {
  const target = compact(input.target, MAX_TARGET_LENGTH);
  rejectCredentialLikeText(target);
  const evidence = validateEvidence(input.evidence);
  return {
    prompt: [
      "あなたはSIT ORBITの端末内ES下書き生成器です。",
      "確認済み証拠だけを使い、各文に証拠IDとそのままのgrounding quoteを付けてください。",
      "証拠にない成果、数値、役割、因果関係、人物情報を作らないでください。",
      "grounding_quotesは引用する証拠のclaim/context/action/resultから文字列をそのまま抜き出してください。",
      "証拠が不足する場合は文を作らず、空欄にせず、生成自体を失敗させるため空の応答は返さないでください。",
      `応募・自己PRの目的: ${target}`,
      `確認済み証拠(JSON): ${promptEvidence(evidence)}`,
      "JSON以外を返さないでください。",
    ].join("\n"),
    responseConstraint: EVIDENCE_GROUNDED_ES_RESPONSE_CONSTRAINT,
    parse: (value) => parseEvidenceGroundedEsResponse(value, evidence),
  };
}

export async function generateEvidenceGroundedEs(
  input: EvidenceGroundedEsInput,
): Promise<EvidenceGroundedEsDraft> {
  const request = createEvidenceGroundedEsPromptRequest(input);
  return runLocalPrompt(request);
}
