import { type CareerVault, serializeCareerVaultMutation } from "./career-vault";

export const APPLICATION_MISSION_STEPS = [
  "requirements",
  "history",
  "evidence",
  "es",
  "counseling",
  "calendar",
] as const;

export type ApplicationMissionStep = (typeof APPLICATION_MISSION_STEPS)[number];
export type ApplicationMissionStatus =
  | "active"
  | "blocked"
  | "ready_for_confirmation"
  | "completed"
  | "cancelled";
export type ApplicationMissionTargetKind = "job" | "internship";

export interface ApplicationMissionStepState {
  status: "pending" | "completed" | "awaiting_confirmation";
  completed_at: string | null;
  refs: string[];
  blocker: string | null;
}

export interface ApplicationMissionRecord {
  schema_version: "v1";
  mission_id: string;
  target_local_id: string;
  target_kind: ApplicationMissionTargetKind;
  display_label: string;
  status: ApplicationMissionStatus;
  current_step: ApplicationMissionStep | "completed";
  steps: Record<ApplicationMissionStep, ApplicationMissionStepState>;
  requirements: {
    deadline: string | null;
    required_documents: string[];
    source_ref: string | null;
  };
  history: { source_refs: string[] };
  evidence: { evidence_ids: string[] };
  es: { draft_ref: string | null; review_refs: string[] };
  counseling: { resource_ref: string | null };
  calendar: { preview_ref: string | null; confirmation_ref: string | null };
  transitions: ApplicationMissionTransition[];
  created_at: string;
  updated_at: string;
}

export interface CreateApplicationMissionInput {
  target_local_id: string;
  target_kind: ApplicationMissionTargetKind;
  display_label: string;
}

export interface RequirementsConfirmedEvent {
  type: "requirements-confirmed";
  deadline: string | null;
  required_documents: string[];
  source_ref: string;
}

export interface HistoryCollectedEvent {
  type: "history-collected";
  source_refs: string[];
}

export interface EvidenceCollectedEvent {
  type: "evidence-collected";
  evidence_ids: string[];
}

export interface EsDraftedEvent {
  type: "es-drafted";
  draft_ref: string;
  review_refs: string[];
}

export interface CounselingSelectedEvent {
  type: "counseling-selected";
  resource_ref: string;
}

export interface CalendarPreviewedEvent {
  type: "calendar-previewed";
  preview_ref: string;
}

export interface CalendarConfirmedEvent {
  type: "calendar-confirmed";
  confirmation_ref: string;
}

export interface MissionBlockedEvent {
  type: "blocked";
  step: ApplicationMissionStep;
  reason: string;
}

export type ApplicationMissionEvent =
  | RequirementsConfirmedEvent
  | HistoryCollectedEvent
  | EvidenceCollectedEvent
  | EsDraftedEvent
  | CounselingSelectedEvent
  | CalendarPreviewedEvent
  | CalendarConfirmedEvent
  | MissionBlockedEvent
  | { type: "unblocked" }
  | { type: "cancelled" };

export interface ApplicationMissionTransition {
  type: ApplicationMissionEvent["type"];
  step: ApplicationMissionStep | null;
  recorded_at: string;
}

const MISSION_INDEX = "application-mission-index:v1";
const MISSION_PREFIX = "application-mission:v1:";
const MISSION_MUTATION_KEY = "application-mission:index";
const MAX_REFS = 32;
const MAX_DOCUMENTS = 24;
const MAX_TRANSITIONS = 128;
const MAX_TEXT_LENGTH = 600;
const TARGET_ID_PATTERN = /^(?:job|internship):[A-Za-z0-9:_-]{3,180}$/u;
const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{2,180}$/u;
const MISSION_ID_PATTERN = /^application-mission:v1:[a-f0-9]{32}$/u;
const DATE_PATTERN = /^20\d{2}-\d{2}-\d{2}$/u;

function compact(value: string, maxLength = MAX_TEXT_LENGTH): string {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized)
    throw new Error("Application mission text must not be empty.");
  if (normalized.length > maxLength) {
    throw new Error("Application mission text exceeds the maximum length.");
  }
  return normalized;
}

function rejectSensitiveText(value: string): void {
  if (
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(value) ||
    /(?:access[_-]?token|id[_-]?token|refresh[_-]?token|session|cookie|password|oauth|authorization)/iu.test(
      value,
    ) ||
    /\b[A-Z]{1,5}[-_ ]?\d{5,}\b/iu.test(value) ||
    /(?:https?:\/\/|mailto:|[?#])/iu.test(value)
  ) {
    throw new Error("Application mission contains personal or URL data.");
  }
}

function assertOpaqueRef(value: string, label: string): string {
  const normalized = compact(value, 180);
  if (!OPAQUE_REF_PATTERN.test(normalized)) {
    throw new Error(`${label} must be an opaque local reference.`);
  }
  return normalized;
}

function assertTargetId(value: string): string {
  const normalized = compact(value, 180);
  if (!TARGET_ID_PATTERN.test(normalized)) {
    throw new Error("Application mission target must be a local CAST ID.");
  }
  return normalized;
}

function assertDate(value: string | null): string | null {
  if (value === null) return null;
  if (!DATE_PATTERN.test(value)) {
    throw new Error("Application mission deadline must be an ISO date.");
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error("Application mission deadline is invalid.");
  }
  return value;
}

function assertRefList(values: string[], label: string): string[] {
  if (!Array.isArray(values) || values.length > MAX_REFS) {
    throw new Error(`${label} count is out of bounds.`);
  }
  const refs = values.map((value) => assertOpaqueRef(value, label));
  if (new Set(refs).size !== refs.length) {
    throw new Error(`${label} contains duplicate references.`);
  }
  return refs;
}

function emptyStep(): ApplicationMissionStepState {
  return {
    status: "pending",
    completed_at: null,
    refs: [],
    blocker: null,
  };
}

function emptySteps(): Record<
  ApplicationMissionStep,
  ApplicationMissionStepState
> {
  return Object.fromEntries(
    APPLICATION_MISSION_STEPS.map((step) => [step, emptyStep()]),
  ) as Record<ApplicationMissionStep, ApplicationMissionStepState>;
}

function missionId(): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Web Crypto API is unavailable.");
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `${MISSION_PREFIX}${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function stepIndex(step: ApplicationMissionStep): number {
  return APPLICATION_MISSION_STEPS.indexOf(step);
}

function currentStep(
  steps: Record<ApplicationMissionStep, ApplicationMissionStepState>,
): ApplicationMissionStep | "completed" {
  return (
    APPLICATION_MISSION_STEPS.find(
      (step) => steps[step].status !== "completed",
    ) ?? "completed"
  );
}

function withTransition(
  record: ApplicationMissionRecord,
  event: ApplicationMissionEvent,
  status: ApplicationMissionStatus,
  recordedAt: string,
): ApplicationMissionRecord {
  const current = currentStep(record.steps);
  const step =
    event.type === "blocked"
      ? event.step
      : event.type === "calendar-previewed" ||
          event.type === "calendar-confirmed"
        ? "calendar"
        : event.type === "cancelled" || event.type === "unblocked"
          ? null
          : current === "completed"
            ? null
            : current;
  const transitions = [
    ...(record.transitions ?? []),
    { type: event.type, step, recorded_at: recordedAt },
  ].slice(-MAX_TRANSITIONS);
  return {
    ...record,
    status,
    current_step: currentStep(record.steps),
    updated_at: recordedAt,
    transitions,
  };
}

function ensureActive(record: ApplicationMissionRecord): void {
  if (record.status === "cancelled" || record.status === "completed") {
    throw new Error("Application mission is already terminal.");
  }
  if (record.status === "blocked") {
    throw new Error("Application mission is blocked.");
  }
}

function ensureStep(
  record: ApplicationMissionRecord,
  expected: ApplicationMissionStep,
): void {
  ensureActive(record);
  if (record.current_step !== expected) {
    throw new Error(
      `Application mission step must be ${expected}, not ${record.current_step}.`,
    );
  }
}

function completeStep(
  record: ApplicationMissionRecord,
  step: ApplicationMissionStep,
  refs: string[],
  event: ApplicationMissionEvent,
  recordedAt: string,
): ApplicationMissionRecord {
  const steps = structuredClone(record.steps);
  steps[step] = {
    status: "completed",
    completed_at: recordedAt,
    refs,
    blocker: null,
  };
  const next = currentStep(steps);
  return withTransition(
    { ...record, steps },
    event,
    next === "completed" ? "completed" : "active",
    recordedAt,
  );
}

export function createApplicationMission(
  input: CreateApplicationMissionInput,
  now = new Date().toISOString(),
): ApplicationMissionRecord {
  const targetLocalId = assertTargetId(input.target_local_id);
  const displayLabel = compact(input.display_label, 240);
  rejectSensitiveText(displayLabel);
  return {
    schema_version: "v1",
    mission_id: missionId(),
    target_local_id: targetLocalId,
    target_kind: input.target_kind,
    display_label: displayLabel,
    status: "active",
    current_step: "requirements",
    steps: emptySteps(),
    requirements: {
      deadline: null,
      required_documents: [],
      source_ref: null,
    },
    history: { source_refs: [] },
    evidence: { evidence_ids: [] },
    es: { draft_ref: null, review_refs: [] },
    counseling: { resource_ref: null },
    calendar: { preview_ref: null, confirmation_ref: null },
    created_at: now,
    updated_at: now,
    transitions: [],
  };
}

export function reduceApplicationMission(
  record: ApplicationMissionRecord,
  event: ApplicationMissionEvent,
  recordedAt = new Date().toISOString(),
): ApplicationMissionRecord {
  if (
    record.schema_version !== "v1" ||
    !MISSION_ID_PATTERN.test(record.mission_id)
  ) {
    throw new Error("Application mission record is invalid.");
  }
  if (event.type === "cancelled") {
    if (record.status === "completed") {
      throw new Error("Completed application mission cannot be cancelled.");
    }
    return withTransition(record, event, "cancelled", recordedAt);
  }
  if (event.type === "blocked") {
    ensureActive(record);
    const step = event.step;
    if (stepIndex(step) < 0 || record.current_step !== step) {
      throw new Error("Application mission can only block its current step.");
    }
    const reason = compact(event.reason, 400);
    rejectSensitiveText(reason);
    const steps = structuredClone(record.steps);
    steps[step] = { ...steps[step], status: "pending", blocker: reason };
    return withTransition({ ...record, steps }, event, "blocked", recordedAt);
  }
  if (event.type === "unblocked") {
    if (record.status !== "blocked") {
      throw new Error("Application mission is not blocked.");
    }
    const steps = structuredClone(record.steps);
    const step = currentStep(steps);
    if (step !== "completed") steps[step] = { ...steps[step], blocker: null };
    return withTransition(
      { ...record, steps },
      event,
      step === "completed" ? "completed" : "active",
      recordedAt,
    );
  }
  if (event.type === "requirements-confirmed") {
    ensureStep(record, "requirements");
    const sourceRef = assertOpaqueRef(event.source_ref, "Requirements source");
    const documents = event.required_documents.map((document) => {
      const value = compact(document, 240);
      rejectSensitiveText(value);
      return value;
    });
    if (documents.length > MAX_DOCUMENTS) {
      throw new Error("Required document count is out of bounds.");
    }
    const deadline = assertDate(event.deadline);
    const next = {
      ...record,
      requirements: {
        deadline,
        required_documents: documents,
        source_ref: sourceRef,
      },
    };
    return completeStep(
      next,
      "requirements",
      [sourceRef, ...documents.map((_, index) => `document:${index}`)],
      event,
      recordedAt,
    );
  }
  if (event.type === "history-collected") {
    ensureStep(record, "history");
    const sourceRefs = assertRefList(event.source_refs, "History source");
    return completeStep(
      { ...record, history: { source_refs: sourceRefs } },
      "history",
      sourceRefs,
      event,
      recordedAt,
    );
  }
  if (event.type === "evidence-collected") {
    ensureStep(record, "evidence");
    const evidenceIds = assertRefList(event.evidence_ids, "Evidence");
    return completeStep(
      { ...record, evidence: { evidence_ids: evidenceIds } },
      "evidence",
      evidenceIds,
      event,
      recordedAt,
    );
  }
  if (event.type === "es-drafted") {
    ensureStep(record, "es");
    const draftRef = assertOpaqueRef(event.draft_ref, "ES draft");
    const reviewRefs = assertRefList(event.review_refs, "ES review");
    return completeStep(
      { ...record, es: { draft_ref: draftRef, review_refs: reviewRefs } },
      "es",
      [draftRef, ...reviewRefs],
      event,
      recordedAt,
    );
  }
  if (event.type === "counseling-selected") {
    ensureStep(record, "counseling");
    const resourceRef = assertOpaqueRef(
      event.resource_ref,
      "Counseling resource",
    );
    return completeStep(
      { ...record, counseling: { resource_ref: resourceRef } },
      "counseling",
      [resourceRef],
      event,
      recordedAt,
    );
  }
  if (event.type === "calendar-previewed") {
    ensureStep(record, "calendar");
    const steps = structuredClone(record.steps);
    const previewRef = assertOpaqueRef(event.preview_ref, "Calendar preview");
    steps.calendar = {
      status: "awaiting_confirmation",
      completed_at: null,
      refs: [previewRef],
      blocker: null,
    };
    return withTransition(
      {
        ...record,
        steps,
        calendar: { preview_ref: previewRef, confirmation_ref: null },
      },
      event,
      "ready_for_confirmation",
      recordedAt,
    );
  }
  if (event.type === "calendar-confirmed") {
    if (record.status !== "ready_for_confirmation") {
      throw new Error("Calendar confirmation requires a pending preview.");
    }
    if (record.steps.calendar.status !== "awaiting_confirmation") {
      throw new Error("Calendar preview is not pending confirmation.");
    }
    const confirmationRef = assertOpaqueRef(
      event.confirmation_ref,
      "Calendar confirmation",
    );
    const steps = structuredClone(record.steps);
    steps.calendar = {
      status: "completed",
      completed_at: recordedAt,
      refs: [...steps.calendar.refs, confirmationRef],
      blocker: null,
    };
    return withTransition(
      {
        ...record,
        steps,
        calendar: {
          preview_ref: record.calendar.preview_ref,
          confirmation_ref: confirmationRef,
        },
      },
      event,
      "completed",
      recordedAt,
    );
  }
  throw new Error("Unsupported application mission event.");
}

export class ApplicationMissionStore {
  constructor(private readonly vault: CareerVault) {}

  private async index(): Promise<string[]> {
    const value = await this.vault.get<unknown>(MISSION_INDEX);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is string =>
        typeof item === "string" && MISSION_ID_PATTERN.test(item),
    );
  }

  private async saveIndex(ids: string[]): Promise<void> {
    await this.vault.put(MISSION_INDEX, Array.from(new Set(ids)).slice(-512));
  }

  async create(
    input: CreateApplicationMissionInput,
    now = new Date().toISOString(),
  ): Promise<ApplicationMissionRecord> {
    const record = createApplicationMission(input, now);
    return serializeCareerVaultMutation(
      this.vault,
      MISSION_MUTATION_KEY,
      async () => {
        await this.vault.put(record.mission_id, record);
        await this.saveIndex([...(await this.index()), record.mission_id]);
        return record;
      },
    );
  }

  async get(missionIdValue: string): Promise<ApplicationMissionRecord | null> {
    if (!MISSION_ID_PATTERN.test(missionIdValue)) {
      throw new Error("Invalid application mission ID.");
    }
    return this.vault.get<ApplicationMissionRecord>(missionIdValue);
  }

  async dispatch(
    missionIdValue: string,
    event: ApplicationMissionEvent,
    recordedAt = new Date().toISOString(),
  ): Promise<ApplicationMissionRecord> {
    return serializeCareerVaultMutation(
      this.vault,
      MISSION_MUTATION_KEY,
      async () => {
        const current = await this.get(missionIdValue);
        if (!current) throw new Error("Application mission was not found.");
        const next = reduceApplicationMission(current, event, recordedAt);
        await this.vault.put(next.mission_id, next);
        return next;
      },
    );
  }

  async list(): Promise<ApplicationMissionRecord[]> {
    return serializeCareerVaultMutation(
      this.vault,
      MISSION_MUTATION_KEY,
      async () => {
        const records: ApplicationMissionRecord[] = [];
        for (const id of await this.index()) {
          const record = await this.get(id);
          if (record) records.push(record);
        }
        return records;
      },
    );
  }

  async remove(missionIdValue: string): Promise<void> {
    if (!MISSION_ID_PATTERN.test(missionIdValue)) {
      throw new Error("Invalid application mission ID.");
    }
    await serializeCareerVaultMutation(
      this.vault,
      MISSION_MUTATION_KEY,
      async () => {
        await this.vault.delete(missionIdValue);
        await this.saveIndex(
          (await this.index()).filter((id) => id !== missionIdValue),
        );
      },
    );
  }

  async clear(): Promise<void> {
    await serializeCareerVaultMutation(
      this.vault,
      MISSION_MUTATION_KEY,
      async () => {
        for (const id of await this.index()) await this.vault.delete(id);
        await this.saveIndex([]);
      },
    );
  }
}
