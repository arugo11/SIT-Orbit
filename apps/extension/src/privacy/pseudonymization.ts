import type { CareerVault } from "./career-vault";

export type CastPersonRole =
  | "alumni"
  | "recruiter"
  | "interviewer"
  | "student"
  | "unknown";

export type PseudonymizationDestination = "local" | "azure";

export interface CastPersonInput {
  name?: string;
  romanized_name?: string;
  source_identifier?: string;
  email?: string;
  phone?: string;
  student_id?: string;
  url?: string;
  file_name?: string;
  free_text?: string;
  role?: CastPersonRole;
  company?: string;
  technical_domains?: string[];
  job_types?: string[];
  location_area?: string;
  graduation_year?: number;
  evidence_id?: string;
}

export interface CastPublicAggregateInput {
  category: "job" | "internship" | "event" | "hiring_record";
  company?: string;
  count: number;
  year?: number;
  technical_domain?: string;
}

export interface CastTypedSnapshot {
  schema_version: "v1";
  records: CastPersonInput[];
  public_aggregates?: CastPublicAggregateInput[];
}

/**
 * Local-only CAST reasoning input.  This is intentionally a separate contract
 * from CastTypedSnapshot: a model-facing caller cannot accidentally attach raw
 * HTML, a URL, a form value, or a free-text report to a reasoning record.
 *
 * A person may be attached when a CAST detail page exposed a name.  The name
 * is consumed by the gateway and is represented by a mission-scoped alias in
 * the returned projection.  The snapshot must never leave the extension.
 */
export interface CastReasoningRecordInput {
  surface: string;
  title?: string;
  company_name?: string;
  dates?: string[];
  deadline?: string | null;
  locations?: string[];
  technical_domains?: string[];
  occupations?: string[];
  employment_types?: string[];
  graduation_years?: number[];
  relation_flags?: string[];
  result_ref?: string;
  person?: CastPersonInput;
}

export interface CastReasoningSnapshot {
  schema_version: "v2";
  records: CastReasoningRecordInput[];
}

export interface PseudonymizedPerson {
  alias: string;
  role: CastPersonRole;
  company?: string;
  technical_domains?: string[];
  job_types?: string[];
  location_area?: string;
  graduation_year_bucket?: string;
  evidence_id?: string;
}

export interface PseudonymizedPublicAggregate {
  category: CastPublicAggregateInput["category"];
  company?: string;
  count: number;
  year_bucket?: string;
  technical_domain?: string;
}

export interface PseudonymizedCastPayload {
  schema_version: "v1";
  destination: PseudonymizationDestination;
  people: PseudonymizedPerson[];
  public_aggregates: PseudonymizedPublicAggregate[];
}

/** A local Prompt API record after person fields have been replaced. */
export interface PseudonymizedReasoningRecord {
  surface: string;
  title?: string;
  company_name?: string;
  person_alias?: string;
  dates: string[];
  deadline: string | null;
  locations: string[];
  technical_domains: string[];
  occupations: string[];
  employment_types: string[];
  graduation_year_buckets: string[];
  relation_flags: string[];
  result_ref?: string;
}

export interface PseudonymizedReasoningPayload {
  schema_version: "v2";
  destination: "local";
  records: PseudonymizedReasoningRecord[];
}

export interface ReasoningContextManifest {
  schema_version: "v2";
  source: "CAST";
  destination: "local";
  record_count: number;
  replaced_person_count: number;
  removed_fields: string[];
  generalized_fields: string[];
  /** A safe preview for the local Prompt API; no raw input is retained. */
  payload_preview: PseudonymizedReasoningPayload;
}

export interface PseudonymizedReasoningResult {
  payload: PseudonymizedReasoningPayload;
  manifest: ReasoningContextManifest;
}

export interface ContextManifestEntry {
  source: string;
  destination: PseudonymizationDestination;
  included: boolean;
  count: number;
  reason: string;
}

export interface ContextManifest {
  schema_version: "v1";
  entries: ContextManifestEntry[];
  replaced_person_count: number;
  removed_fields: string[];
  generalized_fields: string[];
  payload_preview: PseudonymizedCastPayload;
}

export interface PseudonymizationResult {
  payload: PseudonymizedCastPayload;
  manifest: ContextManifest;
}

interface InternalPersonRecord {
  schema_version: "v1";
  person_ref: string;
  original_names: string[];
  source_identifiers: string[];
  sensitive_identifiers: {
    email?: string;
    phone?: string;
    student_id?: string;
    url?: string;
    file_name?: string;
  };
  role: CastPersonRole;
  first_seen_at: string;
  last_seen_at: string;
}

interface MissionRecord {
  schema_version: "v1";
  mission_nonce: string;
  created_at: string;
}

export class PseudonymizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PseudonymizationError";
  }
}

export class ExternalPersonalDataError extends PseudonymizationError {
  constructor() {
    super(
      "Personal CAST records are local-only and cannot be sent to an external provider.",
    );
    this.name = "ExternalPersonalDataError";
  }
}

export class LocalReasoningOnlyError extends PseudonymizationError {
  constructor() {
    super(
      "Detailed CAST reasoning is local-only; the reasoning projection cannot be sent to an external provider.",
    );
    this.name = "LocalReasoningOnlyError";
  }
}

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
// Count digits instead of just characters so ISO dates such as 2026-08-20
// are not mistaken for phone numbers.
const PHONE_PATTERN = /(?:\+81|0)(?:[-()\s]?\d){8,11}\b/u;
const STUDENT_ID_PATTERN = /\b[A-Z]{1,5}[-_ ]?\d{5,}\b/iu;
const CREDENTIAL_PATTERN =
  /(?:access[_-]?token|id[_-]?token|refresh[_-]?token|session|cookie|password|oauth|authorization)/iu;

function getCrypto(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new PseudonymizationError("Web Crypto API is unavailable.");
  }
  return globalThis.crypto;
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer as ArrayBuffer;
}

function randomNonce(): string {
  const bytes = new Uint8Array(32);
  getCrypto().getRandomValues(bytes);
  return toBase64(bytes);
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function base32(value: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

function compact(value: string | undefined, limit: number): string | undefined {
  const normalized = value?.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, limit) : undefined;
}

function normalizeIdentifier(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("ja-JP");
}

function normalizeName(value: string): string {
  return normalizeIdentifier(value).replace(/[。、，,．.・]/gu, " ");
}

function nameKey(names: string[]): string {
  const tokens = names
    .flatMap((name) => normalizeName(name).split(" "))
    .filter(Boolean)
    .sort();
  return tokens.join(" ");
}

function namesFor(input: CastPersonInput): string[] {
  return [input.name, input.romanized_name]
    .filter((value): value is string => Boolean(value?.trim()))
    .map(normalizeName)
    .filter((value, index, values) => values.indexOf(value) === index);
}

function rolePrefix(role: CastPersonRole): string {
  switch (role) {
    case "alumni":
      return "先輩";
    case "recruiter":
      return "担当者";
    case "interviewer":
      return "面接官";
    case "student":
      return "学生";
    default:
      return "人物";
  }
}

function yearBucket(year: number | undefined): string | undefined {
  if (
    year === undefined ||
    !Number.isInteger(year) ||
    year < 1900 ||
    year > 2200
  ) {
    return undefined;
  }
  if (year < 2010) return "before-2010";
  return `${Math.floor(year / 5) * 5}-${Math.floor(year / 5) * 5 + 4}`;
}

function ensureSafeUrl(value: string | undefined): void {
  if (!value) return;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new PseudonymizationError(
        "A URL with credentials, query, or fragment cannot enter the gateway.",
      );
    }
  } catch (error) {
    if (error instanceof PseudonymizationError) throw error;
    throw new PseudonymizationError("Invalid URL in CAST snapshot.");
  }
}

function assertNoCredentialLikeData(input: CastPersonInput): void {
  const values = [
    input.source_identifier,
    input.email,
    input.phone,
    input.student_id,
    input.url,
    input.file_name,
    input.free_text,
  ].filter((value): value is string => Boolean(value));
  if (values.some((value) => CREDENTIAL_PATTERN.test(value))) {
    throw new PseudonymizationError(
      "Credential-like CAST data cannot be processed by this gateway.",
    );
  }
  ensureSafeUrl(input.url);
}

function collectRemovedFields(input: CastPersonInput): string[] {
  const removed: string[] = [];
  for (const field of [
    "email",
    "phone",
    "student_id",
    "source_identifier",
    "url",
    "file_name",
    "free_text",
  ] as const) {
    if (input[field]) removed.push(field);
  }
  return removed;
}

const REASONING_FIELDS = new Set([
  "surface",
  "title",
  "company_name",
  "dates",
  "deadline",
  "locations",
  "technical_domains",
  "occupations",
  "employment_types",
  "graduation_years",
  "relation_flags",
  "result_ref",
  "person",
]);

function assertReasoningPersonShape(input: CastPersonInput): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PseudonymizationError("CAST reasoning person is invalid.");
  }
  for (const field of [
    "name",
    "romanized_name",
    "source_identifier",
    "email",
    "phone",
    "student_id",
    "url",
    "file_name",
    "free_text",
    "company",
    "location_area",
    "evidence_id",
  ] as const) {
    const value = input[field];
    if (value !== undefined && typeof value !== "string") {
      throw new PseudonymizationError("CAST reasoning person is invalid.");
    }
  }
  for (const field of ["technical_domains", "job_types"] as const) {
    const values = input[field];
    if (
      values !== undefined &&
      (!Array.isArray(values) ||
        values.some((value) => typeof value !== "string"))
    ) {
      throw new PseudonymizationError("CAST reasoning person is invalid.");
    }
  }
  if (
    input.graduation_year !== undefined &&
    !Number.isInteger(input.graduation_year)
  ) {
    throw new PseudonymizationError("CAST reasoning person is invalid.");
  }
  if (
    input.role !== undefined &&
    !["alumni", "recruiter", "interviewer", "student", "unknown"].includes(
      input.role,
    )
  ) {
    throw new PseudonymizationError("CAST reasoning person is invalid.");
  }
}

function assertReasoningRecordShape(input: CastReasoningRecordInput): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PseudonymizationError("CAST reasoning record is invalid.");
  }
  const unknownFields = Object.keys(input).filter(
    (field) => !REASONING_FIELDS.has(field),
  );
  if (unknownFields.length > 0) {
    throw new PseudonymizationError(
      "CAST reasoning input contains an unsupported field.",
    );
  }
  if (
    typeof input.surface !== "string" ||
    !/^[a-z][a-z0-9_]{0,39}$/u.test(input.surface)
  ) {
    throw new PseudonymizationError("CAST reasoning surface is invalid.");
  }
  if (
    input.result_ref !== undefined &&
    !/^orbit-cast-[a-z0-9_-]{8,120}$/u.test(input.result_ref)
  ) {
    throw new PseudonymizationError(
      "CAST reasoning result reference is invalid.",
    );
  }
  if (input.person !== undefined) assertReasoningPersonShape(input.person);
}

function safeReasoningText(
  value: unknown,
  field: string,
  limit = 160,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new PseudonymizationError(`CAST reasoning ${field} is invalid.`);
  }
  const normalized = compact(value, limit);
  if (!normalized) return undefined;
  if (
    EMAIL_PATTERN.test(normalized) ||
    PHONE_PATTERN.test(normalized) ||
    STUDENT_ID_PATTERN.test(normalized) ||
    CREDENTIAL_PATTERN.test(normalized) ||
    /https?:\/\//iu.test(normalized)
  ) {
    throw new PseudonymizationError(
      `CAST reasoning ${field} contains a prohibited identifier.`,
    );
  }
  return normalized;
}

function safeReasoningTextArray(values: unknown, field: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 12) {
    throw new PseudonymizationError(`CAST reasoning ${field} is invalid.`);
  }
  return Array.from(
    new Set(
      values
        .map((value) => safeReasoningText(value, field, 100))
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

function safeReasoningDate(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new PseudonymizationError(`CAST reasoning ${field} is invalid.`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (!/^20\d{2}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new PseudonymizationError(
      `CAST reasoning ${field} contains an invalid date.`,
    );
  }
  const date = new Date(`${normalized}T00:00:00Z`);
  const [yearText, monthText, dayText] = normalized.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new PseudonymizationError(
      `CAST reasoning ${field} contains an invalid date.`,
    );
  }
  return normalized;
}

function safeReasoningDates(values: unknown, field: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 8) {
    throw new PseudonymizationError(`CAST reasoning ${field} is invalid.`);
  }
  return Array.from(
    new Set(values.map((value) => safeReasoningDate(value, field))),
  );
}

function reasoningYearBucket(year: number): string {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    throw new PseudonymizationError(
      "CAST reasoning graduation year is invalid.",
    );
  }
  const start = Math.floor(year / 5) * 5;
  return `${start}-${start + 4}`;
}

function safeReasoningYearBuckets(values: unknown): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 8) {
    throw new PseudonymizationError(
      "CAST reasoning graduation years are invalid.",
    );
  }
  return Array.from(new Set(values.map(reasoningYearBucket)));
}

function sanitizeAggregate(
  aggregate: CastPublicAggregateInput,
): PseudonymizedPublicAggregate {
  if (
    !Number.isSafeInteger(aggregate.count) ||
    aggregate.count < 0 ||
    aggregate.count > 1_000_000
  ) {
    throw new PseudonymizationError("Invalid CAST aggregate count.");
  }
  const result: PseudonymizedPublicAggregate = {
    category: aggregate.category,
    count: aggregate.count,
  };
  const company = compact(aggregate.company, 160);
  const domain = compact(aggregate.technical_domain, 120);
  if (
    STUDENT_ID_PATTERN.test(company ?? "") ||
    STUDENT_ID_PATTERN.test(domain ?? "")
  ) {
    throw new PseudonymizationError("CAST aggregate contains a student ID.");
  }
  const bucket = yearBucket(aggregate.year);
  if (company) result.company = company;
  if (domain) result.technical_domain = domain;
  if (bucket) result.year_bucket = bucket;
  return result;
}

function scanForLeakage(
  payload: PseudonymizedCastPayload,
  prohibitedValues: string[],
): void {
  const serialized = JSON.stringify(payload);
  if (
    /(?:person_ref|source_identifier|original_names|student_id|access_token|id_token|refresh_token)/iu.test(
      serialized,
    )
  ) {
    throw new PseudonymizationError(
      "Gateway payload contains a prohibited field.",
    );
  }
  if (
    prohibitedValues.some(
      (value) => value.length > 2 && serialized.includes(value),
    )
  ) {
    throw new PseudonymizationError(
      "Gateway payload contains a detected identifier.",
    );
  }
  if (EMAIL_PATTERN.test(serialized) || PHONE_PATTERN.test(serialized)) {
    throw new PseudonymizationError("Gateway payload contains contact data.");
  }
}

function scanReasoningForLeakage(
  payload: PseudonymizedReasoningPayload,
  prohibitedValues: string[],
): void {
  const serialized = JSON.stringify(payload);
  if (
    /(?:person_ref|source_identifier|original_names|student_id|access_token|id_token|refresh_token|raw_html|company_code)/iu.test(
      serialized,
    )
  ) {
    throw new PseudonymizationError(
      "CAST reasoning projection contains a prohibited field.",
    );
  }
  if (
    prohibitedValues.some((value) => {
      if (value.length <= 2) return false;
      const normalized = normalizeIdentifier(value);
      return serialized.includes(value) || serialized.includes(normalized);
    })
  ) {
    throw new PseudonymizationError(
      "CAST reasoning projection contains a detected identifier.",
    );
  }
  if (EMAIL_PATTERN.test(serialized) || PHONE_PATTERN.test(serialized)) {
    throw new PseudonymizationError(
      "CAST reasoning projection contains contact data.",
    );
  }
}

async function missionAlias(
  missionNonce: string,
  personRef: string,
  role: CastPersonRole,
): Promise<string> {
  const key = await getCrypto().subtle.importKey(
    "raw",
    ownedBuffer(fromBase64(missionNonce)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await getCrypto().subtle.sign(
    "HMAC",
    key,
    ownedBuffer(new TextEncoder().encode(personRef)),
  );
  return `${rolePrefix(role)}-${base32(new Uint8Array(digest)).slice(0, 8)}`;
}

export class PseudonymizationGateway {
  private readonly vault: CareerVault;

  constructor(vault: CareerVault) {
    this.vault = vault;
  }

  async startMission(missionId: string): Promise<PseudonymizationMission> {
    if (!missionId.trim()) {
      throw new PseudonymizationError("Mission ID must not be empty.");
    }
    const missionDigest = hex(
      await this.vault.hmac(`mission-key:${missionId}`),
    );
    const recordId = `mission:${missionDigest.slice(0, 48)}`;
    const existing = await this.vault.get<MissionRecord>(recordId);
    const mission: MissionRecord = existing ?? {
      schema_version: "v1",
      mission_nonce: randomNonce(),
      created_at: new Date().toISOString(),
    };
    if (!existing) await this.vault.put(recordId, mission);
    return new PseudonymizationMission(this.vault, missionId, mission);
  }
}

export class PseudonymizationMission {
  private readonly vault: CareerVault;
  private readonly missionId: string;
  private readonly mission: MissionRecord;

  constructor(vault: CareerVault, missionId: string, mission: MissionRecord) {
    this.vault = vault;
    this.missionId = missionId;
    this.mission = mission;
  }

  async transform(
    snapshot: CastTypedSnapshot,
    destination: PseudonymizationDestination = "local",
  ): Promise<PseudonymizationResult> {
    if (snapshot.schema_version !== "v1") {
      throw new PseudonymizationError("Unsupported CAST snapshot schema.");
    }
    const removedFields = new Set<string>();
    const generalizedFields = new Set<string>();
    const prohibitedValues: string[] = [];
    const people: PseudonymizedPerson[] = [];

    for (const input of snapshot.records) {
      assertNoCredentialLikeData(input);
      const names = namesFor(input);
      const sourceIdentifier = compact(input.source_identifier, 180);
      if (names.length === 0 && !sourceIdentifier) {
        throw new PseudonymizationError(
          "Every CAST person record needs a name or source identifier.",
        );
      }
      const role = input.role ?? "unknown";
      const lookupMaterial = sourceIdentifier
        ? `source:${normalizeIdentifier(sourceIdentifier)}`
        : `name:${nameKey(names)}|role:${role}`;
      const lookupDigest = hex(
        await this.vault.hmac(`person-lookup-v1:${lookupMaterial}`),
      );
      const mappingId = `person-map:${lookupDigest.slice(0, 48)}`;
      const existing = await this.vault.get<InternalPersonRecord>(mappingId);
      const now = new Date().toISOString();
      const personRef =
        existing?.person_ref ??
        `person-${hex(await this.vault.hmac(`person-ref-v1:${lookupMaterial}`)).slice(0, 24)}`;
      const record: InternalPersonRecord = {
        schema_version: "v1",
        person_ref: personRef,
        original_names: Array.from(
          new Set([...(existing?.original_names ?? []), ...names]),
        ),
        source_identifiers: Array.from(
          new Set([
            ...(existing?.source_identifiers ?? []),
            ...(sourceIdentifier ? [sourceIdentifier] : []),
          ]),
        ),
        sensitive_identifiers: {
          ...(existing?.sensitive_identifiers ?? {}),
          ...(input.email ? { email: input.email } : {}),
          ...(input.phone ? { phone: input.phone } : {}),
          ...(input.student_id ? { student_id: input.student_id } : {}),
          ...(input.url ? { url: input.url } : {}),
          ...(input.file_name ? { file_name: input.file_name } : {}),
        },
        role,
        first_seen_at: existing?.first_seen_at ?? now,
        last_seen_at: now,
      };
      await this.vault.put(mappingId, record);

      prohibitedValues.push(
        ...record.original_names,
        ...record.source_identifiers,
      );
      prohibitedValues.push(
        ...Object.values(record.sensitive_identifiers).filter(
          (value): value is string => Boolean(value),
        ),
      );
      for (const field of collectRemovedFields(input)) removedFields.add(field);
      const alias = await missionAlias(
        this.mission.mission_nonce,
        personRef,
        role,
      );
      const person: PseudonymizedPerson = { alias, role };
      const company = compact(input.company, 160);
      const location = compact(input.location_area, 80);
      const domains = input.technical_domains
        ?.map((value) => compact(value, 80))
        .filter((value): value is string => Boolean(value))
        .slice(0, 12);
      const jobTypes = input.job_types
        ?.map((value) => compact(value, 80))
        .filter((value): value is string => Boolean(value))
        .slice(0, 12);
      const bucket = yearBucket(input.graduation_year);
      if (company) person.company = company;
      if (location) person.location_area = location;
      if (domains?.length) person.technical_domains = domains;
      if (jobTypes?.length) person.job_types = jobTypes;
      if (bucket) {
        person.graduation_year_bucket = bucket;
        generalizedFields.add("graduation_year");
      }
      if (input.evidence_id && /^[-a-z0-9]{3,120}$/iu.test(input.evidence_id)) {
        person.evidence_id = input.evidence_id;
      }
      people.push(person);
    }

    if (destination === "azure" && people.length > 0) {
      throw new ExternalPersonalDataError();
    }
    const aggregates = (snapshot.public_aggregates ?? []).map(
      sanitizeAggregate,
    );
    const payload: PseudonymizedCastPayload = {
      schema_version: "v1",
      destination,
      people: destination === "local" ? people : [],
      public_aggregates: aggregates,
    };
    scanForLeakage(payload, prohibitedValues);
    return {
      payload,
      manifest: {
        schema_version: "v1",
        entries: [
          {
            source: "CAST人物記録",
            destination: "local",
            included: destination === "local",
            count: people.length,
            reason: "対応表と詳細は暗号化Vaultと端末内Prompt APIに限定",
          },
          {
            source: "CAST公開集計",
            destination,
            included: aggregates.length > 0,
            count: aggregates.length,
            reason: "個人を特定しない集計値だけを許可",
          },
        ],
        replaced_person_count: people.length,
        removed_fields: Array.from(removedFields).sort(),
        generalized_fields: Array.from(generalizedFields).sort(),
        payload_preview: payload,
      },
    };
  }

  /**
   * Build a mission-scoped, local-only reasoning projection.
   *
   * This method is deliberately not parameterized by a destination.  Detailed
   * CAST records may help the on-device Prompt API reason about a result, but
   * they are never an Azure/OpenAI payload.  Use `transform` with
   * `destination: "azure"` for the aggregate-only v1 contract instead.
   */
  async transformReasoning(
    snapshot: CastReasoningSnapshot,
  ): Promise<PseudonymizedReasoningResult> {
    if (
      !snapshot ||
      typeof snapshot !== "object" ||
      snapshot.schema_version !== "v2"
    ) {
      throw new PseudonymizationError(
        "Unsupported CAST reasoning snapshot schema.",
      );
    }
    if (!Array.isArray(snapshot.records) || snapshot.records.length > 20) {
      throw new PseudonymizationError(
        "CAST reasoning snapshots are limited to 20 records.",
      );
    }

    const removedFields = new Set<string>([
      "raw_html",
      "source_url",
      "url_query",
      "url_fragment",
      "company_code",
      "local_summary",
      "free_text",
      "email",
      "phone",
      "student_id",
      "file_name",
      "token",
    ]);
    const generalizedFields = new Set<string>();
    const records: PseudonymizedReasoningRecord[] = [];
    const prohibitedValues: string[] = [];
    let replacedPersonCount = 0;

    for (const input of snapshot.records) {
      assertReasoningRecordShape(input);
      const personResult = input.person
        ? await this.transform(
            { schema_version: "v1", records: [input.person] },
            "local",
          )
        : null;
      if (input.person) {
        const personValues = [
          input.person.name,
          input.person.romanized_name,
          input.person.source_identifier,
          input.person.email,
          input.person.phone,
          input.person.student_id,
          input.person.url,
          input.person.file_name,
          input.person.free_text,
        ].filter((value): value is string => Boolean(value));
        prohibitedValues.push(
          ...personValues.flatMap((value) => [
            value,
            normalizeIdentifier(value),
          ]),
        );
      }
      if (personResult)
        replacedPersonCount += personResult.manifest.replaced_person_count;

      const title = safeReasoningText(input.title, "title");
      const companyName = safeReasoningText(
        input.company_name,
        "company_name",
        180,
      );
      const dates = safeReasoningDates(input.dates, "dates");
      const deadline =
        input.deadline === undefined || input.deadline === null
          ? null
          : safeReasoningDate(input.deadline, "deadline");
      const graduationYearBuckets = safeReasoningYearBuckets(
        input.graduation_years,
      );
      if (input.graduation_years?.length) {
        generalizedFields.add("graduation_year");
      }
      const person = personResult?.payload.people[0];
      const record: PseudonymizedReasoningRecord = {
        surface: input.surface,
        dates,
        deadline,
        locations: safeReasoningTextArray(input.locations, "locations"),
        technical_domains: safeReasoningTextArray(
          input.technical_domains,
          "technical_domains",
        ),
        occupations: safeReasoningTextArray(input.occupations, "occupations"),
        employment_types: safeReasoningTextArray(
          input.employment_types,
          "employment_types",
        ),
        graduation_year_buckets: graduationYearBuckets,
        relation_flags: safeReasoningTextArray(
          input.relation_flags,
          "relation_flags",
        ),
      };
      if (title) record.title = title;
      if (companyName) record.company_name = companyName;
      if (person?.alias) record.person_alias = person.alias;
      if (input.result_ref) record.result_ref = input.result_ref;
      records.push(record);
    }

    const payload: PseudonymizedReasoningPayload = {
      schema_version: "v2",
      destination: "local",
      records,
    };
    scanReasoningForLeakage(payload, prohibitedValues);

    return {
      payload,
      manifest: {
        schema_version: "v2",
        source: "CAST",
        destination: "local",
        record_count: records.length,
        replaced_person_count: replacedPersonCount,
        removed_fields: Array.from(removedFields).sort(),
        generalized_fields: Array.from(generalizedFields).sort(),
        payload_preview: payload,
      },
    };
  }

  get id(): string {
    return this.missionId;
  }
}
