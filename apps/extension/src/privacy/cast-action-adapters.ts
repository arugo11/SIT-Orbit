export type CastActionKind =
  | "cast_application"
  | "cast_counseling_request"
  | "cast_attachment"
  | "calendar_event";

export type CastActionConfirmationTier = "standard" | "red";
export type CastActionPreviewStatus =
  | "pending_confirmation"
  | "awaiting_red_confirmation"
  | "confirmed"
  | "executing"
  | "executed"
  | "rejected"
  | "blocked"
  | "expired";

export interface CastApplicationActionInput {
  kind: "cast_application";
  mission_id: string;
  target_ref: string;
  display_label: string;
  deadline: string | null;
  required_documents: string[];
  is_recommendation: boolean;
}

export interface CastCounselingActionInput {
  kind: "cast_counseling_request";
  mission_id: string;
  target_ref: string;
  display_label: string;
  slot_start: string;
  slot_end: string;
  purpose: string;
}

export interface CastAttachmentActionInput {
  kind: "cast_attachment";
  mission_id: string;
  target_ref: string;
  display_label: string;
  attachment_ref: string;
  file_name: string;
  mime_type:
    | "application/pdf"
    | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

export interface CalendarEventActionInput {
  kind: "calendar_event";
  mission_id: string;
  target_ref: string;
  display_label: string;
  title: string;
  start: string;
  end: string;
  time_zone: string;
  source_ref: string;
}

export type CastActionInput =
  | CastApplicationActionInput
  | CastCounselingActionInput
  | CastAttachmentActionInput
  | CalendarEventActionInput;

export interface CastActionPreview {
  schema_version: "v1";
  preview_id: string;
  mission_id: string;
  kind: CastActionKind;
  target_ref: string;
  display_label: string;
  confirmation_tier: CastActionConfirmationTier;
  status: "pending_confirmation";
  summary: CastActionSummary;
  created_at: string;
  expires_at: string;
}

export type CastActionSummary =
  | {
      kind: "cast_application";
      deadline: string | null;
      required_documents: string[];
      required_document_count: number;
      is_recommendation: boolean;
    }
  | {
      kind: "cast_counseling_request";
      slot_start: string;
      slot_end: string;
      purpose: string;
    }
  | {
      kind: "cast_attachment";
      attachment_ref: string;
      file_name: string;
      mime_type: CastAttachmentActionInput["mime_type"];
    }
  | {
      kind: "calendar_event";
      title: string;
      start: string;
      end: string;
      time_zone: string;
      source_ref: string;
    };

export interface CastActionRecord {
  preview: CastActionPreview;
  status: CastActionPreviewStatus;
  primary_confirmed_at: string | null;
  red_confirmed_at: string | null;
  executed_at: string | null;
}

export type CastActionConfirmation =
  | { phase: "primary"; phrase: "実行を確認" }
  | { phase: "red"; phrase: "推薦応募を実行する" };

export type CastActionExecutionResult =
  | { status: "executed"; execution_ref: string }
  | { status: "blocked"; reason_code: string }
  | { status: "unavailable"; reason_code: string };

export interface CastActionExecutor {
  execute(preview: CastActionPreview): Promise<CastActionExecutionResult>;
}

const PREVIEW_PREFIX = "cast-action-preview:v1:";
const PREVIEW_ID_PATTERN = /^cast-action-preview:v1:[a-f0-9]{32}$/u;
const MISSION_ID_PATTERN = /^application-mission:v1:[a-f0-9]{32}$/u;
const OPAQUE_REF_PATTERN =
  /^(?:job|internship|counseling|calendar|attachment|cast-[A-Za-z-]+|evidence|review|es-draft|support-resource):[A-Za-z0-9:_-]{1,180}$/u;
const ISO_DATE_PATTERN = /^20\d{2}-\d{2}-\d{2}$/u;
const MAX_DOCUMENTS = 24;
const MAX_TEXT_LENGTH = 600;
const PREVIEW_TTL_MS = 10 * 60 * 1000;

function compact(value: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string") {
    throw new TypeError("CAST action text must be a string.");
  }
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error("CAST action text must not be empty.");
  if (normalized.length > maxLength) {
    throw new Error("CAST action text exceeds the maximum length.");
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
    /(?:https?:\/\/|mailto:|[?#])/u.test(value)
  ) {
    throw new Error("CAST action contains personal or credential data.");
  }
}

function assertMissionId(value: string): string {
  const normalized = compact(value, 80);
  if (!MISSION_ID_PATTERN.test(normalized)) {
    throw new Error("CAST action mission must be an application mission ID.");
  }
  return normalized;
}

function assertOpaqueRef(value: string, label: string): string {
  const normalized = compact(value, 180);
  if (!OPAQUE_REF_PATTERN.test(normalized)) {
    throw new Error(`${label} must be an opaque local reference.`);
  }
  return normalized;
}

function assertDate(value: string | null): string | null {
  if (value === null) return null;
  if (!ISO_DATE_PATTERN.test(value)) {
    throw new Error("CAST action date must be an ISO date.");
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new Error("CAST action date is invalid.");
  }
  return value;
}

function assertDateTime(value: string, label: string): string {
  const normalized = compact(value, 80);
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.valueOf()) || !normalized.includes("T")) {
    throw new Error(`${label} must be an ISO date-time.`);
  }
  return normalized;
}

function assertTimeOrder(start: string, end: string): void {
  if (new Date(start).valueOf() >= new Date(end).valueOf()) {
    throw new Error("CAST action end must be after start.");
  }
}

function assertTimeZone(value: string): string {
  const normalized = compact(value, 80);
  if (!/^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/u.test(normalized)) {
    throw new Error("CAST action time zone is invalid.");
  }
  return normalized;
}

function assertDocuments(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_DOCUMENTS) {
    throw new Error("CAST action document count is out of bounds.");
  }
  const documents = values.map((value) => {
    const normalized = compact(value, 240);
    rejectSensitiveText(normalized);
    return normalized;
  });
  if (new Set(documents).size !== documents.length) {
    throw new Error("CAST action documents must be unique.");
  }
  return documents;
}

function previewId(): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Web Crypto API is unavailable.");
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `${PREVIEW_PREFIX}${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function validateInput(input: CastActionInput): CastActionSummary {
  assertMissionId(input.mission_id);
  assertOpaqueRef(input.target_ref, "CAST action target");
  const displayLabel = compact(input.display_label, 240);
  rejectSensitiveText(displayLabel);

  if (input.kind === "cast_application") {
    if (!/^job:|^internship:/u.test(input.target_ref)) {
      throw new Error("CAST application target must be a job or internship.");
    }
    const deadline = assertDate(input.deadline);
    const documents = assertDocuments(input.required_documents);
    if (typeof input.is_recommendation !== "boolean") {
      throw new TypeError("CAST recommendation flag must be boolean.");
    }
    return {
      kind: input.kind,
      deadline,
      required_documents: documents,
      required_document_count: documents.length,
      is_recommendation: input.is_recommendation,
    };
  }
  if (input.kind === "cast_counseling_request") {
    if (!/^counseling:/u.test(input.target_ref)) {
      throw new Error("Counseling target must be a local resource reference.");
    }
    const start = assertDateTime(input.slot_start, "Counseling slot start");
    const end = assertDateTime(input.slot_end, "Counseling slot end");
    assertTimeOrder(start, end);
    const purpose = compact(input.purpose, 400);
    rejectSensitiveText(purpose);
    return { kind: input.kind, slot_start: start, slot_end: end, purpose };
  }
  if (input.kind === "cast_attachment") {
    if (!/^job:|^internship:|^counseling:/u.test(input.target_ref)) {
      throw new Error("Attachment target must be a local CAST reference.");
    }
    const attachmentRef = assertOpaqueRef(input.attachment_ref, "Attachment");
    if (!/^attachment:/u.test(attachmentRef)) {
      throw new Error("Attachment reference has an invalid type.");
    }
    const fileName = compact(input.file_name, 120);
    rejectSensitiveText(fileName);
    if (/[/\\]/u.test(fileName) || !/\.(?:pdf|docx|xlsx)$/iu.test(fileName)) {
      throw new Error("Attachment must be a local PDF, DOCX, or XLSX name.");
    }
    if (
      input.mime_type !== "application/pdf" &&
      input.mime_type !==
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" &&
      input.mime_type !==
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ) {
      throw new Error("Attachment MIME type is not allowed.");
    }
    return {
      kind: input.kind,
      attachment_ref: attachmentRef,
      file_name: fileName,
      mime_type: input.mime_type,
    };
  }
  if (!/^calendar:/u.test(input.target_ref)) {
    throw new Error("Calendar target must be a local reference.");
  }
  const title = compact(input.title, 240);
  rejectSensitiveText(title);
  const start = assertDateTime(input.start, "Calendar start");
  const end = assertDateTime(input.end, "Calendar end");
  assertTimeOrder(start, end);
  const timeZone = assertTimeZone(input.time_zone);
  const sourceRef = assertOpaqueRef(input.source_ref, "Calendar source");
  return {
    kind: input.kind,
    title,
    start,
    end,
    time_zone: timeZone,
    source_ref: sourceRef,
  };
}

function confirmationTier(input: CastActionInput): CastActionConfirmationTier {
  return input.kind === "cast_application" && input.is_recommendation
    ? "red"
    : "standard";
}

function assertPreviewId(value: string): string {
  if (!PREVIEW_ID_PATTERN.test(value)) {
    throw new Error("CAST action preview ID is invalid.");
  }
  return value;
}

function isExpired(record: CastActionRecord, now: number): boolean {
  return new Date(record.preview.expires_at).valueOf() <= now;
}

function isExecutionResult(value: unknown): value is CastActionExecutionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as Record<string, unknown>;
  if (result.status === "executed") {
    return typeof result.execution_ref === "string";
  }
  return (
    (result.status === "blocked" || result.status === "unavailable") &&
    typeof result.reason_code === "string"
  );
}

class UnavailableCastActionExecutor implements CastActionExecutor {
  async execute(): Promise<CastActionExecutionResult> {
    return {
      status: "unavailable",
      reason_code: "institutional_write_not_configured",
    };
  }
}

export class CastActionAdapter {
  private readonly records = new Map<string, CastActionRecord>();
  private readonly executor: CastActionExecutor;

  constructor(
    executor: CastActionExecutor = new UnavailableCastActionExecutor(),
  ) {
    this.executor = executor;
  }

  preview(input: CastActionInput, now = new Date()): CastActionPreview {
    const summary = validateInput(input);
    const createdAt = now.toISOString();
    const preview: CastActionPreview = {
      schema_version: "v1",
      preview_id: previewId(),
      mission_id: input.mission_id,
      kind: input.kind,
      target_ref: input.target_ref,
      display_label: input.display_label.normalize("NFKC").trim(),
      confirmation_tier: confirmationTier(input),
      status: "pending_confirmation",
      summary,
      created_at: createdAt,
      expires_at: new Date(now.valueOf() + PREVIEW_TTL_MS).toISOString(),
    };
    this.records.set(preview.preview_id, {
      preview,
      status: "pending_confirmation",
      primary_confirmed_at: null,
      red_confirmed_at: null,
      executed_at: null,
    });
    return structuredClone(preview);
  }

  get(previewIdValue: string, now = new Date()): CastActionRecord | null {
    const id = assertPreviewId(previewIdValue);
    const record = this.records.get(id);
    if (!record) return null;
    if (
      !isExpired(record, now.valueOf()) ||
      record.status === "executing" ||
      record.status === "executed" ||
      record.status === "rejected"
    ) {
      return structuredClone(record);
    }
    record.status = "expired";
    return structuredClone(record);
  }

  confirm(
    previewIdValue: string,
    confirmation: CastActionConfirmation,
    now = new Date(),
  ): CastActionRecord {
    const id = assertPreviewId(previewIdValue);
    const record = this.records.get(id);
    if (!record) throw new Error("CAST action preview was not found.");
    if (isExpired(record, now.valueOf())) {
      record.status = "expired";
      throw new Error("CAST action preview has expired.");
    }
    if (record.status === "executed" || record.status === "rejected") {
      throw new Error("CAST action preview is already terminal.");
    }
    if (record.status === "blocked") {
      throw new Error("CAST action preview is blocked.");
    }
    if (confirmation.phase === "primary") {
      if (record.status !== "pending_confirmation") {
        throw new Error("Primary confirmation is not expected for this state.");
      }
      if (confirmation.phrase !== "実行を確認") {
        throw new Error("Primary confirmation phrase is invalid.");
      }
      record.primary_confirmed_at = now.toISOString();
      record.status =
        record.preview.confirmation_tier === "red"
          ? "awaiting_red_confirmation"
          : "confirmed";
    } else {
      if (record.preview.confirmation_tier !== "red") {
        throw new Error("Red confirmation is not required for this action.");
      }
      if (!record.primary_confirmed_at) {
        throw new Error("Primary confirmation is required first.");
      }
      if (record.status !== "awaiting_red_confirmation") {
        throw new Error("Red confirmation is not expected for this state.");
      }
      if (confirmation.phrase !== "推薦応募を実行する") {
        throw new Error("Red confirmation phrase is invalid.");
      }
      record.red_confirmed_at = now.toISOString();
      record.status = "confirmed";
    }
    return structuredClone(record);
  }

  reject(previewIdValue: string): CastActionRecord {
    const id = assertPreviewId(previewIdValue);
    const record = this.records.get(id);
    if (!record) throw new Error("CAST action preview was not found.");
    if (record.status === "executing") {
      throw new Error("Executing CAST action cannot be rejected.");
    }
    if (record.status === "executed") {
      throw new Error("Executed CAST action cannot be rejected.");
    }
    record.status = "rejected";
    return structuredClone(record);
  }

  async execute(
    previewIdValue: string,
    now = new Date(),
  ): Promise<CastActionExecutionResult> {
    const id = assertPreviewId(previewIdValue);
    const record = this.records.get(id);
    if (!record) throw new Error("CAST action preview was not found.");
    if (isExpired(record, now.valueOf())) {
      record.status = "expired";
      return { status: "blocked", reason_code: "preview_expired" };
    }
    if (record.status !== "confirmed") {
      if (record.status === "executing") {
        return {
          status: "blocked",
          reason_code: "execution_in_progress",
        };
      }
      return {
        status: "blocked",
        reason_code: "explicit_confirmation_required",
      };
    }
    record.status = "executing";
    let result: CastActionExecutionResult;
    try {
      result = await this.executor.execute(structuredClone(record.preview));
    } catch {
      record.status = "blocked";
      return { status: "blocked", reason_code: "executor_failed" };
    }
    if (!isExecutionResult(result)) {
      record.status = "blocked";
      return { status: "blocked", reason_code: "invalid_executor_result" };
    }
    if (result.status === "executed") {
      if (
        !/^cast-action-execution:v1:[a-f0-9]{32}$/u.test(result.execution_ref)
      ) {
        record.status = "blocked";
        return {
          status: "blocked",
          reason_code: "invalid_execution_reference",
        };
      }
      record.status = "executed";
      record.executed_at = now.toISOString();
    } else {
      record.status = "blocked";
    }
    return result;
  }
}

export function createCastActionExecutionRef(): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Web Crypto API is unavailable.");
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `cast-action-execution:v1:${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}
