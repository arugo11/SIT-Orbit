import { type CareerVault, serializeCareerVaultMutation } from "./career-vault";

export type CareerEvidenceSource =
  | "course"
  | "research"
  | "pbl"
  | "club"
  | "part_time"
  | "personal_project"
  | "other";
export type CareerEvidenceStatus = "draft" | "confirmed";
export type CareerEvidenceMaterialKind = "document" | "link" | "artifact";

export interface CareerEvidenceMaterial {
  kind: CareerEvidenceMaterialKind;
  label: string;
  locator: string;
}

export interface CareerEvidenceInput {
  claim: string;
  context: string;
  action: string;
  result: string;
  source: CareerEvidenceSource;
  person_ref?: string;
  materials?: CareerEvidenceMaterial[];
  status?: CareerEvidenceStatus;
}

export interface CareerEvidenceRecord extends CareerEvidenceInput {
  schema_version: "v1";
  evidence_id: string;
  created_at: string;
  updated_at: string;
}

/** Safe projection for the local Prompt API and evidence-grounded generators. */
export interface CareerEvidencePromptItem {
  evidence_id: string;
  claim: string;
  context: string;
  action: string;
  result: string;
  source: CareerEvidenceSource;
  material_count: number;
}

const INDEX_RECORD_ID = "career-evidence-index:v1";
const RECORD_PREFIX = "career-evidence:v1:";
const EVIDENCE_MUTATION_KEY = "career-evidence:index";
const MAX_TEXT_LENGTH = 4000;
const MAX_MATERIALS = 12;
const MAX_INDEX_SIZE = 2000;

function assertText(
  name: string,
  value: string | undefined,
  maxLength = MAX_TEXT_LENGTH,
): string {
  const normalized = (value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) throw new Error(`${name} must not be empty.`);
  if (normalized.length > maxLength) {
    throw new Error(`${name} exceeds the maximum length.`);
  }
  return normalized;
}

function isSource(value: unknown): value is CareerEvidenceSource {
  return (
    value === "course" ||
    value === "research" ||
    value === "pbl" ||
    value === "club" ||
    value === "part_time" ||
    value === "personal_project" ||
    value === "other"
  );
}

function isStatus(value: unknown): value is CareerEvidenceStatus {
  return value === "draft" || value === "confirmed";
}

function normalizeLocator(value: string): string {
  const locator = assertText("material locator", value, 500);
  if (locator.startsWith("orbit-evidence://")) return locator;
  try {
    const url = new URL(locator);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Evidence material URL must use HTTP or HTTPS.");
    }
    url.search = "";
    url.hash = "";
    const normalized = url.toString();
    if (normalized.length > 500) {
      throw new Error("Evidence material locator exceeds the maximum length.");
    }
    return normalized;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Evidence material")) {
      throw error;
    }
    throw new Error("Evidence material locator must be an opaque or HTTP URL.");
  }
}

function normalizeMaterial(
  material: CareerEvidenceMaterial,
): CareerEvidenceMaterial {
  if (
    material.kind !== "document" &&
    material.kind !== "link" &&
    material.kind !== "artifact"
  ) {
    throw new Error("Unsupported career evidence material kind.");
  }
  return {
    kind: material.kind,
    label: assertText("material label", material.label, 240),
    locator: normalizeLocator(material.locator),
  };
}

function normalizeInput(input: CareerEvidenceInput): CareerEvidenceInput {
  if (!isSource(input.source)) {
    throw new Error("Unsupported career evidence source.");
  }
  if (input.status !== undefined && !isStatus(input.status)) {
    throw new Error("Unsupported career evidence status.");
  }
  if (
    input.person_ref &&
    !/^person-[A-Za-z0-9_-]{4,128}$/u.test(input.person_ref)
  ) {
    throw new Error("person_ref must be an internal opaque identifier.");
  }
  const sourceMaterials = input.materials ?? [];
  if (sourceMaterials.length > MAX_MATERIALS) {
    throw new Error("Too many career evidence materials.");
  }
  const materials = sourceMaterials.map(normalizeMaterial);
  return {
    claim: assertText("claim", input.claim),
    context: assertText("context", input.context),
    action: assertText("action", input.action),
    result: assertText("result", input.result),
    source: input.source,
    ...(input.person_ref ? { person_ref: input.person_ref } : {}),
    ...(materials.length > 0 ? { materials } : {}),
    status: input.status ?? "draft",
  };
}

function randomId(): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Web Crypto API is unavailable.");
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `${RECORD_PREFIX}${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function assertEvidenceId(evidenceId: string): void {
  if (!/^career-evidence:v1:[a-f0-9]{32}$/u.test(evidenceId)) {
    throw new Error("Invalid career evidence ID.");
  }
}

export function projectCareerEvidenceForPrompt(
  records: CareerEvidenceRecord[],
): CareerEvidencePromptItem[] {
  return records
    .filter((record) => record.status === "confirmed")
    .map((record) => ({
      evidence_id: record.evidence_id,
      claim: record.claim,
      context: record.context,
      action: record.action,
      result: record.result,
      source: record.source,
      material_count: record.materials?.length ?? 0,
    }));
}

export class CareerEvidenceBank {
  constructor(private readonly vault: CareerVault) {}

  private async index(): Promise<string[]> {
    const value = await this.vault.get<unknown>(INDEX_RECORD_ID);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is string =>
        typeof item === "string" &&
        /^career-evidence:v1:[a-f0-9]{32}$/u.test(item),
    );
  }

  private async saveIndex(evidenceIds: string[]): Promise<void> {
    await this.vault.put(
      INDEX_RECORD_ID,
      Array.from(new Set(evidenceIds)).slice(-MAX_INDEX_SIZE),
    );
  }

  async list(): Promise<CareerEvidenceRecord[]> {
    return serializeCareerVaultMutation(
      this.vault,
      EVIDENCE_MUTATION_KEY,
      async () => {
        const records: CareerEvidenceRecord[] = [];
        for (const evidenceId of await this.index()) {
          const record = await this.vault.get<CareerEvidenceRecord>(evidenceId);
          if (record) records.push(record);
        }
        return records;
      },
    );
  }

  async get(evidenceId: string): Promise<CareerEvidenceRecord | null> {
    assertEvidenceId(evidenceId);
    return this.vault.get<CareerEvidenceRecord>(evidenceId);
  }

  async create(
    input: CareerEvidenceInput,
    now = new Date().toISOString(),
  ): Promise<CareerEvidenceRecord> {
    const evidenceId = randomId();
    const normalized = normalizeInput(input);
    const record: CareerEvidenceRecord = {
      schema_version: "v1",
      evidence_id: evidenceId,
      created_at: now,
      updated_at: now,
      ...normalized,
    };
    return serializeCareerVaultMutation(
      this.vault,
      EVIDENCE_MUTATION_KEY,
      async () => {
        await this.vault.put(evidenceId, record);
        await this.saveIndex([...(await this.index()), evidenceId]);
        return record;
      },
    );
  }

  async update(
    evidenceId: string,
    patch: Partial<CareerEvidenceInput>,
    now = new Date().toISOString(),
  ): Promise<CareerEvidenceRecord> {
    assertEvidenceId(evidenceId);
    return serializeCareerVaultMutation(
      this.vault,
      EVIDENCE_MUTATION_KEY,
      async () => {
        const existing = await this.get(evidenceId);
        if (!existing) throw new Error("Career evidence record was not found.");
        const merged = normalizeInput({
          ...existing,
          ...patch,
        });
        const record: CareerEvidenceRecord = {
          ...existing,
          ...merged,
          evidence_id: evidenceId,
          updated_at: now,
        };
        await this.vault.put(evidenceId, record);
        return record;
      },
    );
  }

  async remove(evidenceId: string): Promise<void> {
    assertEvidenceId(evidenceId);
    await serializeCareerVaultMutation(
      this.vault,
      EVIDENCE_MUTATION_KEY,
      async () => {
        await this.vault.delete(evidenceId);
        await this.saveIndex(
          (await this.index()).filter((id) => id !== evidenceId),
        );
      },
    );
  }

  async clear(): Promise<void> {
    await serializeCareerVaultMutation(
      this.vault,
      EVIDENCE_MUTATION_KEY,
      async () => {
        for (const evidenceId of await this.index()) {
          await this.vault.delete(evidenceId);
        }
        await this.saveIndex([]);
      },
    );
  }
}
