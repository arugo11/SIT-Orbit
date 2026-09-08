import type { CastHistoryLocalSnapshot } from "../content/cast-history-reports-reader";
import type { CastSupportLocalSnapshot } from "../content/cast-support-resources-reader";
import { type LocalPromptRequest, runLocalPrompt } from "./career-prompt";
import { type CareerVault, serializeCareerVaultMutation } from "./career-vault";
import type {
  CastPersonInput,
  PseudonymizationMission,
} from "./pseudonymization";

export type ObogQuestionPriority = "must" | "should" | "optional";

export interface ObogCandidateProjection {
  alias: string;
  role: "alumni" | "recruiter" | "interviewer" | "student" | "unknown";
  company: string | null;
  technical_domains: string[];
  job_types: string[];
  graduation_year_bucket: string | null;
}

export interface ObogSupportResourceProjection {
  resource_id: string;
  kind: "video" | "event" | "counseling" | "supporter" | "guide";
  title: string;
  published_date: string | null;
}

export interface ObogConciergeInput {
  objective: string;
  candidates: ObogCandidateProjection[];
  resources: ObogSupportResourceProjection[];
  /** Terms retained only in the local parser to detect model leakage. */
  forbidden_local_terms?: string[];
}

export interface ObogQuestion {
  priority: ObogQuestionPriority;
  question: string;
}

export interface ObogBriefPoint {
  text: string;
  references: string[];
}

export interface ObogConciergePlan {
  schema_version: "v1";
  selected_candidate_alias: string | null;
  purpose: string;
  questions: ObogQuestion[];
  request_draft: {
    subject: string;
    body: string;
  };
  pre_meeting_brief: ObogBriefPoint[];
  follow_up_draft: string;
}

export interface ObogConciergePromptRequest
  extends LocalPromptRequest<ObogConciergePlan> {}

export interface ObogMeetingMemoInput {
  candidate_alias: string;
  purpose: string;
  notes: string[];
  insights: string[];
  next_steps: string[];
  captured_at?: string;
}

export interface ObogMeetingMemoRecord extends ObogMeetingMemoInput {
  schema_version: "v1";
  memo_id: string;
  created_at: string;
  updated_at: string;
}

const OBOG_MEMO_INDEX = "obog-concierge-memo-index:v1";
const OBOG_MEMO_PREFIX = "obog-concierge-memo:v1:";
const OBOG_MEMO_MUTATION_KEY = "obog-concierge:memo-index";
const MAX_CANDIDATES = 64;
const MAX_RESOURCES = 48;
const MAX_QUESTIONS = 8;
const MAX_BRIEF_POINTS = 8;
const MAX_TEXT_LENGTH = 1200;
const MAX_OBJECTIVE_LENGTH = 1000;
const MAX_MEMO_ITEMS = 16;
const OBOG_ALIAS_PATTERN = /^(?:先輩|担当者|面接官|学生|人物)-[A-Z2-7]{8}$/u;
const RESOURCE_ID_PATTERN = /^support-resource:\d+$/u;
const VALID_PRIORITIES = new Set<ObogQuestionPriority>([
  "must",
  "should",
  "optional",
]);

export const OBOG_CONCIERGE_RESPONSE_CONSTRAINT: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    schema_version: { type: "string", enum: ["v1"] },
    selected_candidate_alias: { type: ["string", "null"] },
    purpose: { type: "string", minLength: 1, maxLength: MAX_TEXT_LENGTH },
    questions: {
      type: "array",
      minItems: 1,
      maxItems: MAX_QUESTIONS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          priority: { type: "string", enum: ["must", "should", "optional"] },
          question: {
            type: "string",
            minLength: 1,
            maxLength: MAX_TEXT_LENGTH,
          },
        },
        required: ["priority", "question"],
      },
    },
    request_draft: {
      type: "object",
      additionalProperties: false,
      properties: {
        subject: { type: "string", minLength: 1, maxLength: 240 },
        body: { type: "string", minLength: 1, maxLength: MAX_TEXT_LENGTH },
      },
      required: ["subject", "body"],
    },
    pre_meeting_brief: {
      type: "array",
      minItems: 1,
      maxItems: MAX_BRIEF_POINTS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", minLength: 1, maxLength: MAX_TEXT_LENGTH },
          references: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: { type: "string" },
          },
        },
        required: ["text", "references"],
      },
    },
    follow_up_draft: {
      type: "string",
      minLength: 1,
      maxLength: MAX_TEXT_LENGTH,
    },
  },
  required: [
    "schema_version",
    "selected_candidate_alias",
    "purpose",
    "questions",
    "request_draft",
    "pre_meeting_brief",
    "follow_up_draft",
  ],
};

function compact(value: string, maxLength: number): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error("OBOG concierge text must not be empty.");
  if (normalized.length > maxLength) {
    throw new Error("OBOG concierge text exceeds the maximum length.");
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

function rejectSensitiveText(
  value: string,
  forbiddenTerms: string[] = [],
): void {
  if (
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(value) ||
    /(?:\+81|0)[-\d() ]{8,}/u.test(value) ||
    /(?:access[_-]?token|id[_-]?token|refresh[_-]?token|session|cookie|password|oauth|authorization)/iu.test(
      value,
    ) ||
    /\b[A-Z]{1,5}[-_ ]?\d{5,}\b/iu.test(value) ||
    /(?:https?:\/\/|mailto:)/iu.test(value)
  ) {
    throw new Error(
      "OBOG concierge output contains contact or credential data.",
    );
  }
  const normalized = value.normalize("NFKC");
  const canonical = normalized
    .toLocaleLowerCase("ja-JP")
    .replace(/[\s。、，,．.・]/gu, "");
  for (const term of forbiddenTerms) {
    const candidate = term.normalize("NFKC").trim();
    const canonicalTerm = candidate
      .toLocaleLowerCase("ja-JP")
      .replace(/[\s。、，,．.・]/gu, "");
    if (
      (candidate.length >= 2 && normalized.includes(candidate)) ||
      (canonicalTerm.length >= 2 && canonical.includes(canonicalTerm))
    ) {
      throw new Error(
        "OBOG concierge output contains a local-only person name.",
      );
    }
  }
}

function normalizeAlias(value: string): string {
  const alias = compact(value, 32);
  if (!OBOG_ALIAS_PATTERN.test(alias)) {
    throw new Error("OBOG concierge candidate alias is invalid.");
  }
  return alias;
}

function normalizeResourceId(value: string): string {
  const resourceId = compact(value, 32);
  if (!RESOURCE_ID_PATTERN.test(resourceId)) {
    throw new Error("OBOG concierge resource reference is invalid.");
  }
  return resourceId;
}

function candidateMap(
  candidates: ObogCandidateProjection[],
): Map<string, ObogCandidateProjection> {
  if (candidates.length > MAX_CANDIDATES) {
    throw new Error("Too many OBOG concierge candidates.");
  }
  const map = new Map<string, ObogCandidateProjection>();
  for (const candidate of candidates) {
    const alias = normalizeAlias(candidate.alias);
    if (map.has(alias)) throw new Error("Duplicate OBOG concierge alias.");
    map.set(alias, {
      alias,
      role: candidate.role,
      company: candidate.company ? compact(candidate.company, 240) : null,
      technical_domains: candidate.technical_domains
        .map((value) => compact(value, 120))
        .slice(0, 12),
      job_types: candidate.job_types
        .map((value) => compact(value, 120))
        .slice(0, 12),
      graduation_year_bucket: candidate.graduation_year_bucket
        ? compact(candidate.graduation_year_bucket, 32)
        : null,
    });
  }
  return map;
}

function resourceMap(
  resources: ObogSupportResourceProjection[],
): Map<string, ObogSupportResourceProjection> {
  if (resources.length > MAX_RESOURCES) {
    throw new Error("Too many OBOG concierge resources.");
  }
  const map = new Map<string, ObogSupportResourceProjection>();
  for (const resource of resources) {
    const resourceId = normalizeResourceId(resource.resource_id);
    if (map.has(resourceId)) throw new Error("Duplicate OBOG resource ID.");
    map.set(resourceId, {
      resource_id: resourceId,
      kind: resource.kind,
      title: compact(resource.title, 240),
      published_date: resource.published_date,
    });
  }
  return map;
}

function validateInput(input: ObogConciergeInput): {
  candidates: Map<string, ObogCandidateProjection>;
  resources: Map<string, ObogSupportResourceProjection>;
  forbiddenTerms: string[];
} {
  const objective = compact(input.objective, MAX_OBJECTIVE_LENGTH);
  rejectSensitiveText(objective);
  const candidates = candidateMap(input.candidates);
  const resources = resourceMap(input.resources);
  const forbiddenTerms = (input.forbidden_local_terms ?? [])
    .map((value) => compact(value, 240))
    .filter((value, index, values) => values.indexOf(value) === index);
  return { candidates, resources, forbiddenTerms };
}

function promptCandidates(
  candidates: Map<string, ObogCandidateProjection>,
): string {
  return JSON.stringify(Array.from(candidates.values()));
}

function promptResources(
  resources: Map<string, ObogSupportResourceProjection>,
): string {
  return JSON.stringify(Array.from(resources.values()));
}

function parseQuestion(value: unknown, forbiddenTerms: string[]): ObogQuestion {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OBOG concierge question must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  assertAllowedKeys(candidate, ["priority", "question"], "OBOG question");
  if (
    typeof candidate.priority !== "string" ||
    !VALID_PRIORITIES.has(candidate.priority as ObogQuestionPriority)
  ) {
    throw new Error("OBOG concierge question priority is invalid.");
  }
  const question = compact(
    typeof candidate.question === "string" ? candidate.question : "",
    MAX_TEXT_LENGTH,
  );
  rejectSensitiveText(question, forbiddenTerms);
  return {
    priority: candidate.priority as ObogQuestionPriority,
    question,
  };
}

function parseBriefPoint(
  value: unknown,
  candidates: Map<string, ObogCandidateProjection>,
  resources: Map<string, ObogSupportResourceProjection>,
  forbiddenTerms: string[],
): ObogBriefPoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OBOG concierge brief point must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  assertAllowedKeys(candidate, ["text", "references"], "OBOG brief point");
  const text = compact(
    typeof candidate.text === "string" ? candidate.text : "",
    MAX_TEXT_LENGTH,
  );
  rejectSensitiveText(text, forbiddenTerms);
  if (!Array.isArray(candidate.references) || candidate.references.length < 1) {
    throw new Error("OBOG brief point must reference a candidate or resource.");
  }
  const references = candidate.references.map((value) => {
    if (typeof value !== "string") {
      throw new Error("OBOG brief reference must be text.");
    }
    if (OBOG_ALIAS_PATTERN.test(value)) {
      if (!candidates.has(value))
        throw new Error("Unknown OBOG candidate reference.");
      return value;
    }
    const resourceId = normalizeResourceId(value);
    if (!resources.has(resourceId))
      throw new Error("Unknown OBOG resource reference.");
    return resourceId;
  });
  if (new Set(references).size !== references.length) {
    throw new Error("Duplicate OBOG brief references are not allowed.");
  }
  return { text, references };
}

export function parseObogConciergeResponse(
  value: unknown,
  input: ObogConciergeInput,
): ObogConciergePlan {
  const { candidates, resources, forbiddenTerms } = validateInput(input);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OBOG concierge response must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  assertAllowedKeys(
    candidate,
    [
      "schema_version",
      "selected_candidate_alias",
      "purpose",
      "questions",
      "request_draft",
      "pre_meeting_brief",
      "follow_up_draft",
    ],
    "OBOG concierge response",
  );
  if (candidate.schema_version !== "v1") {
    throw new Error("OBOG concierge schema version is invalid.");
  }
  const selected =
    candidate.selected_candidate_alias === null
      ? null
      : normalizeAlias(
          typeof candidate.selected_candidate_alias === "string"
            ? candidate.selected_candidate_alias
            : "",
        );
  if (selected && !candidates.has(selected)) {
    throw new Error("OBOG concierge selected an unknown candidate.");
  }
  const purpose = compact(
    typeof candidate.purpose === "string" ? candidate.purpose : "",
    MAX_TEXT_LENGTH,
  );
  rejectSensitiveText(purpose, forbiddenTerms);
  if (!Array.isArray(candidate.questions) || candidate.questions.length < 1) {
    throw new Error("OBOG concierge needs at least one question.");
  }
  if (candidate.questions.length > MAX_QUESTIONS) {
    throw new Error("OBOG concierge question count is out of bounds.");
  }
  const questions = candidate.questions.map((question) =>
    parseQuestion(question, forbiddenTerms),
  );
  if (
    !candidate.request_draft ||
    typeof candidate.request_draft !== "object" ||
    Array.isArray(candidate.request_draft)
  ) {
    throw new Error("OBOG concierge request draft is invalid.");
  }
  const requestDraft = candidate.request_draft as Record<string, unknown>;
  assertAllowedKeys(requestDraft, ["subject", "body"], "OBOG request draft");
  const subject = compact(
    typeof requestDraft.subject === "string" ? requestDraft.subject : "",
    240,
  );
  const body = compact(
    typeof requestDraft.body === "string" ? requestDraft.body : "",
    MAX_TEXT_LENGTH,
  );
  rejectSensitiveText(`${subject} ${body}`, forbiddenTerms);
  if (
    !Array.isArray(candidate.pre_meeting_brief) ||
    candidate.pre_meeting_brief.length < 1
  ) {
    throw new Error("OBOG concierge needs a pre-meeting brief.");
  }
  if (candidate.pre_meeting_brief.length > MAX_BRIEF_POINTS) {
    throw new Error("OBOG concierge brief count is out of bounds.");
  }
  const preMeetingBrief = candidate.pre_meeting_brief.map((point) =>
    parseBriefPoint(point, candidates, resources, forbiddenTerms),
  );
  const followUpDraft = compact(
    typeof candidate.follow_up_draft === "string"
      ? candidate.follow_up_draft
      : "",
    MAX_TEXT_LENGTH,
  );
  rejectSensitiveText(followUpDraft, forbiddenTerms);
  return {
    schema_version: "v1",
    selected_candidate_alias: selected,
    purpose,
    questions,
    request_draft: { subject, body },
    pre_meeting_brief: preMeetingBrief,
    follow_up_draft: followUpDraft,
  };
}

export function createObogConciergePromptRequest(
  input: ObogConciergeInput,
): ObogConciergePromptRequest {
  validateInput(input);
  return {
    prompt: [
      "あなたはSIT ORBITの端末内OB・OGコンシェルジュです。",
      "利用者の目的に合う候補を、提示された別名だけで選びます。",
      "氏名、連絡先、URL、CAST内部ID、tokenを作らず、直接連絡や予約を開始しないでください。",
      "依頼文はキャリアサポート課を経由する下書きにし、個人のメールアドレスや直接の宛先を含めないでください。",
      "質問は面談で確認すべき事実に限定し、候補や支援資源にない事実を断定しないでください。",
      "候補別名とsupport-resource番号を引用して、質問の優先度を付けてください。",
      "JSON以外を返さないでください。",
      `利用目的: ${compact(input.objective, MAX_OBJECTIVE_LENGTH)}`,
      `候補(JSON): ${promptCandidates(candidateMap(input.candidates))}`,
      `支援資源(JSON): ${promptResources(resourceMap(input.resources))}`,
    ].join("\n"),
    responseConstraint: OBOG_CONCIERGE_RESPONSE_CONSTRAINT,
    parse: (value) => parseObogConciergeResponse(value, input),
  };
}

export async function buildObogCandidateProjections(
  snapshot: CastHistoryLocalSnapshot,
  mission: PseudonymizationMission,
): Promise<ObogCandidateProjection[]> {
  const records: CastPersonInput[] = snapshot.people.map((person, index) => ({
    name: person.name,
    source_identifier: person.source_identifier ?? `cast-person-${index}`,
    role: person.role,
    company: person.company,
    technical_domains: person.technical_domains,
    job_types: person.job_types,
    graduation_year: person.graduation_year ?? undefined,
  }));
  const result = await mission.transform(
    { schema_version: "v1", records },
    "local",
  );
  return result.payload.people.map((person) => ({
    alias: person.alias,
    role: person.role,
    company: person.company ?? null,
    technical_domains: person.technical_domains ?? [],
    job_types: person.job_types ?? [],
    graduation_year_bucket: person.graduation_year_bucket ?? null,
  }));
}

export function projectObogSupportResources(
  snapshot: CastSupportLocalSnapshot,
): ObogSupportResourceProjection[] {
  return snapshot.resources.slice(0, MAX_RESOURCES).map((resource, index) => ({
    resource_id: `support-resource:${index}`,
    kind: resource.kind,
    title: resource.title,
    published_date: resource.published_date,
  }));
}

function memoText(value: string, label: string): string {
  const normalized = compact(value, MAX_TEXT_LENGTH);
  rejectSensitiveText(normalized);
  if (normalized.includes("<script") || normalized.includes("</")) {
    throw new Error(`${label} contains unsupported markup.`);
  }
  return normalized;
}

function memoItems(values: string[], label: string): string[] {
  if (!Array.isArray(values) || values.length > MAX_MEMO_ITEMS) {
    throw new Error(`${label} count is out of bounds.`);
  }
  return values.map((value) => memoText(value, label));
}

function memoId(): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Web Crypto API is unavailable.");
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `${OBOG_MEMO_PREFIX}${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function assertMemoAlias(value: string): string {
  return normalizeAlias(value);
}

export class ObogMeetingMemoStore {
  constructor(private readonly vault: CareerVault) {}

  private async index(): Promise<string[]> {
    const value = await this.vault.get<unknown>(OBOG_MEMO_INDEX);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is string =>
        typeof item === "string" && item.startsWith(OBOG_MEMO_PREFIX),
    );
  }

  private async saveIndex(ids: string[]): Promise<void> {
    await this.vault.put(OBOG_MEMO_INDEX, Array.from(new Set(ids)).slice(-512));
  }

  async save(
    input: ObogMeetingMemoInput,
    now = new Date().toISOString(),
  ): Promise<ObogMeetingMemoRecord> {
    const record: ObogMeetingMemoRecord = {
      schema_version: "v1",
      memo_id: memoId(),
      candidate_alias: assertMemoAlias(input.candidate_alias),
      purpose: memoText(input.purpose, "purpose"),
      notes: memoItems(input.notes, "notes"),
      insights: memoItems(input.insights, "insights"),
      next_steps: memoItems(input.next_steps, "next_steps"),
      captured_at: input.captured_at
        ? memoText(input.captured_at, "captured_at")
        : now,
      created_at: now,
      updated_at: now,
    };
    return serializeCareerVaultMutation(
      this.vault,
      OBOG_MEMO_MUTATION_KEY,
      async () => {
        await this.vault.put(record.memo_id, record);
        await this.saveIndex([...(await this.index()), record.memo_id]);
        return record;
      },
    );
  }

  async list(): Promise<ObogMeetingMemoRecord[]> {
    return serializeCareerVaultMutation(
      this.vault,
      OBOG_MEMO_MUTATION_KEY,
      async () => {
        const records: ObogMeetingMemoRecord[] = [];
        for (const id of await this.index()) {
          const record = await this.vault.get<ObogMeetingMemoRecord>(id);
          if (record?.schema_version === "v1") records.push(record);
        }
        return records;
      },
    );
  }

  async remove(memoIdValue: string): Promise<void> {
    if (!memoIdValue.startsWith(OBOG_MEMO_PREFIX)) {
      throw new Error("Invalid OBOG memo ID.");
    }
    await serializeCareerVaultMutation(
      this.vault,
      OBOG_MEMO_MUTATION_KEY,
      async () => {
        await this.vault.delete(memoIdValue);
        await this.saveIndex(
          (await this.index()).filter((id) => id !== memoIdValue),
        );
      },
    );
  }

  async clear(): Promise<void> {
    await serializeCareerVaultMutation(
      this.vault,
      OBOG_MEMO_MUTATION_KEY,
      async () => {
        for (const id of await this.index()) await this.vault.delete(id);
        await this.saveIndex([]);
      },
    );
  }
}

export async function planObogConcierge(
  input: ObogConciergeInput,
): Promise<ObogConciergePlan> {
  return runLocalPrompt(createObogConciergePromptRequest(input));
}
