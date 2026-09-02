import type {
  ActionProposal,
  ChatContextManifest as ApiChatContextManifest,
  ChatLibraryContextRecord as ApiChatLibraryContextRecord,
  ChatHistoryMessage,
  EvidenceLink,
  LibraryBibliographicRecord,
  RelatedBookCandidate,
} from "../api/client";
import { isProviderSafeConversationText } from "../privacy/conversation-pseudonymization";

export type ChatTimelineRole = "user" | "assistant" | "tool";

export interface ChatTimelineMessage {
  id: string;
  role: ChatTimelineRole;
  content: string;
  evidence?: ActionProposal["evidence"];
  proposal?: ActionProposal | null;
  proposalState?: "pending" | "approved" | "rejected";
  toolName?: string;
  toolState?: "running" | "completed" | "failed";
  relatedBooks?: RelatedBookCandidate[];
  /** Provider-safe projection retained separately from local display text. */
  provider_content?: string;
  display_content?: string;
  privacy_transform?: {
    schema_version: "v1";
    replaced_count: number;
    removed_fields: string[];
    generalized_fields: string[];
    warnings: string[];
  };
}

export interface ChatConversation {
  conversationId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatTimelineMessage[];
  contextManifest: ChatContextManifest;
  processing_scope:
    | "none"
    | "personal/scombz_student"
    | "personal/sitrus_academic_record"
    | "restricted/cast_career"
    | "public/syllabus"
    | "mixed";
  provider_destination: "local" | "azure_openai" | "none" | "unknown";
  history_eligible: boolean;
}

export interface ChatContextManifest {
  schema_version: "v1";
  evidence: EvidenceLink[];
  library_records: ChatLibraryContextRecord[];
  related_books: RelatedBookCandidate[];
}

export interface ChatLibraryContextRecord {
  resource_ref: string;
  record: LibraryBibliographicRecord;
  evidence_ids: string[];
  observed_at: string;
}

const DATABASE_NAME = "sit-orbit-chat";
const DATABASE_VERSION = 1;
const STORE_NAME = "conversations";

const fallbackStore = new Map<string, ChatConversation>();

/**
 * Raised when one evidence ID is associated with incompatible public
 * metadata.  The caller must not guess which representation is correct.
 */
export class ContextEvidenceConflictError extends Error {
  readonly code = "context_evidence_conflict" as const;

  constructor() {
    super("Chat context contains conflicting evidence metadata.");
    this.name = "ContextEvidenceConflictError";
  }
}

function sanitizeStoredText(value: string): string {
  return value.replace(/<[^>]*>/g, "").slice(0, 12000);
}

const LIBRARY_RESOURCE_REF_RE =
  /^orbit-library:\/\/record\/[A-Za-z0-9_-]{16,128}$/u;
const LIBRARY_RECORD_PATH = "/opc/recordID/catalog.bib/";
const RELATED_BOOK_REF_RE =
  /^orbit-book:\/\/candidate\/[A-Za-z0-9_-]{16,128}$/u;

function sanitizeEvidence(item: EvidenceLink): EvidenceLink | null {
  const opaqueScombzEvidence =
    item?.data_classification === "personal" && item.source_type === "scombz";
  const publicOrSynthetic = ["public", "synthetic"].includes(
    item?.data_classification ?? "",
  );
  const opaquePersonalScombz =
    opaqueScombzEvidence && item.locator.startsWith("orbit-scombz://");
  if (
    !item ||
    (!publicOrSynthetic && !opaquePersonalScombz) ||
    !item.evidence_id ||
    !item.title ||
    !item.locator
  ) {
    return null;
  }
  if (
    opaqueScombzEvidence &&
    (!/^scombz-(?:page-summary|read|course-list|portal-read|course-read|material-search)-v1-[A-Za-z0-9_-]{16,200}$/u.test(
      item.evidence_id,
    ) ||
      !/^orbit-scombz:\/\/(?:read|citation)\/[A-Za-z0-9_-]{16,128}$/u.test(
        item.locator,
      ))
  ) {
    return null;
  }
  try {
    const url = new URL(item.locator);
    if (
      ["http:", "https:"].includes(url.protocol) &&
      (url.username || url.password || url.search || url.hash)
    ) {
      return null;
    }
  } catch {
    // Opaque orbit-* locators are intentionally not parsed as URLs.
  }
  const raw = `${item.title}\n${item.locator}`.toLowerCase();
  if (
    /<script|<input|cookie=|access_token|oauth_token|csrf|session_token/u.test(
      raw,
    )
  ) {
    return null;
  }
  return {
    evidence_id: sanitizeStoredText(item.evidence_id).slice(0, 240),
    title: sanitizeStoredText(item.title).slice(0, 300),
    source_type: item.source_type,
    locator: sanitizeStoredText(item.locator).slice(0, 500),
    data_classification: item.data_classification,
  };
}

function evidenceMetadataEqual(
  left: EvidenceLink,
  right: EvidenceLink,
): boolean {
  return (
    left.evidence_id === right.evidence_id &&
    left.title === right.title &&
    left.source_type === right.source_type &&
    left.locator === right.locator &&
    left.data_classification === right.data_classification
  );
}

function mergeEvidenceById(
  groups: readonly (readonly EvidenceLink[])[],
): EvidenceLink[] {
  const byId = new Map<string, EvidenceLink>();
  for (const group of groups) {
    for (const item of group) {
      const previous = byId.get(item.evidence_id);
      if (previous === undefined) {
        byId.set(item.evidence_id, item);
        continue;
      }
      if (!evidenceMetadataEqual(previous, item)) {
        throw new ContextEvidenceConflictError();
      }
    }
  }
  return [...byId.values()];
}

function sanitizeLibraryRecord(
  value: LibraryBibliographicRecord,
): LibraryBibliographicRecord | null {
  if (!value || !LIBRARY_RESOURCE_REF_RE.test(value.resource_ref)) return null;
  if (!value.title || !value.url) return null;
  try {
    const url = new URL(value.url);
    if (
      url.protocol !== "https:" ||
      url.origin !== "https://library.shibaura-it.ac.jp" ||
      !url.pathname.startsWith(LIBRARY_RECORD_PATH) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      return null;
    }
  } catch {
    return null;
  }
  const holdings = (value.holdings ?? []).slice(0, 20).map((holding) => ({
    campus: holding.campus,
    location:
      holding.location === null || holding.location === undefined
        ? null
        : sanitizeStoredText(holding.location).slice(0, 200),
    call_number:
      holding.call_number === null || holding.call_number === undefined
        ? null
        : sanitizeStoredText(holding.call_number).slice(0, 100),
    status: holding.status,
    due_date: holding.due_date ?? null,
    reservation_count: holding.reservation_count ?? null,
  }));
  if (holdings.length === 0) return null;
  const raw = JSON.stringify(value).toLowerCase();
  if (
    /<script|<input|cookie=|access_token|oauth_token|csrf|session_token/u.test(
      raw,
    )
  ) {
    return null;
  }
  return {
    resource_ref: value.resource_ref,
    title: sanitizeStoredText(value.title).slice(0, 300),
    authors: (value.authors ?? [])
      .slice(0, 20)
      .map((item) => sanitizeStoredText(item).slice(0, 200)),
    subjects: (value.subjects ?? [])
      .slice(0, 20)
      .map((item) => sanitizeStoredText(item).slice(0, 200)),
    isbn: value.isbn ? sanitizeStoredText(value.isbn).slice(0, 32) : null,
    publisher: value.publisher
      ? sanitizeStoredText(value.publisher).slice(0, 300)
      : null,
    publication_year: value.publication_year ?? null,
    format: value.format,
    campus: value.campus,
    url: new URL(value.url).toString(),
    holdings,
    related_records: (value.related_records ?? []).slice(0, 20).map((item) => ({
      resource_ref: item.resource_ref,
      title: sanitizeStoredText(item.title).slice(0, 300),
      relation: item.relation,
    })),
  };
}

function sanitizeContextManifest(
  value: Partial<ChatContextManifest> | undefined,
): ChatContextManifest {
  const sanitizedEvidence = (value?.evidence ?? [])
    .map(sanitizeEvidence)
    .filter((item): item is EvidenceLink => item !== null);
  const evidence = mergeEvidenceById([sanitizedEvidence]).slice(0, 100);
  const evidenceIds = new Set(evidence.map((item) => item.evidence_id));
  const records = (value?.library_records ?? [])
    .map((item) => {
      const record = sanitizeLibraryRecord(item.record);
      if (!record) return null;
      const evidence_ids = [...new Set(item.evidence_ids ?? [])]
        .filter((id) => evidenceIds.has(id))
        .slice(0, 10);
      const observed = new Date(item.observed_at);
      if (Number.isNaN(observed.getTime())) return null;
      return {
        resource_ref: record.resource_ref,
        record,
        evidence_ids,
        observed_at: observed.toISOString(),
      } satisfies ChatLibraryContextRecord;
    })
    .filter((item): item is ChatLibraryContextRecord => item !== null)
    .slice(0, 20);
  const byRef = new Map<string, ChatLibraryContextRecord>();
  for (const item of records) byRef.set(item.record.resource_ref, item);
  const related = (value?.related_books ?? [])
    .map((item) =>
      sanitizeRelatedBook(item, evidenceIds, new Set(byRef.keys())),
    )
    .filter((item): item is RelatedBookCandidate => item !== null)
    .slice(0, 20);
  const relatedByRef = new Map<string, RelatedBookCandidate>();
  for (const item of related) relatedByRef.set(item.candidate_ref, item);
  return {
    schema_version: "v1",
    evidence,
    library_records: [...byRef.values()],
    related_books: [...relatedByRef.values()],
  };
}

function sanitizeRelatedBook(
  item: RelatedBookCandidate,
  evidenceIds: ReadonlySet<string>,
  libraryRefs: ReadonlySet<string>,
): RelatedBookCandidate | null {
  if (!item || !RELATED_BOOK_REF_RE.test(item.candidate_ref) || !item.title) {
    return null;
  }
  const observed = new Date(item.observed_at);
  if (Number.isNaN(observed.getTime())) return null;
  const evidence_ids = [...new Set(item.evidence_ids ?? [])]
    .filter((id) => evidenceIds.has(id))
    .slice(0, 10);
  if (evidence_ids.length === 0) return null;
  const verification = item.catalog_verification ?? { status: "unverified" };
  const resourceRef = verification.resource_ref ?? null;
  const verificationObserved = verification.observed_at
    ? new Date(verification.observed_at)
    : null;
  if (
    verification.status === "verified" &&
    (!resourceRef || !libraryRefs.has(resourceRef))
  ) {
    return null;
  }
  if (
    verification.status !== "unverified" &&
    (!verificationObserved || Number.isNaN(verificationObserved.getTime()))
  ) {
    return null;
  }
  const publicText = JSON.stringify({
    title: item.title,
    authors: item.authors,
    isbn: item.isbn,
    relation_axes: item.relation_axes,
    why_related: item.why_related,
  }).toLowerCase();
  if (
    /<script|<input|cookie=|access_token|oauth_token|csrf|session_token|orbit-/u.test(
      publicText,
    )
  ) {
    return null;
  }
  return {
    candidate_ref: item.candidate_ref,
    title: sanitizeStoredText(item.title).slice(0, 300),
    authors: (item.authors ?? [])
      .slice(0, 20)
      .map((author) => sanitizeStoredText(author).slice(0, 200)),
    isbn: item.isbn ? sanitizeStoredText(item.isbn).slice(0, 32) : null,
    publication_year: item.publication_year ?? null,
    relation_axes: (item.relation_axes ?? []).slice(0, 5).map((axis) => ({
      label: sanitizeStoredText(axis.label).slice(0, 100),
      source: axis.source,
    })),
    why_related: sanitizeStoredText(item.why_related).slice(0, 500),
    evidence_ids,
    catalog_verification: {
      status: verification.status,
      resource_ref: resourceRef,
      observed_at: verificationObserved?.toISOString() ?? null,
    },
    observed_at: observed.toISOString(),
  };
}

function sanitizeMessage(
  message: ChatTimelineMessage,
  context: ChatContextManifest,
): ChatTimelineMessage {
  const relatedByRef = new Map(
    context.related_books.map((item) => [item.candidate_ref, item]),
  );
  const messageEvidence = message.evidence
    ? mergeEvidenceById([message.evidence.map((item) => ({ ...item }))]).slice(
        0,
        100,
      )
    : undefined;
  return {
    ...message,
    content: sanitizeStoredText(message.content),
    provider_content:
      message.provider_content === undefined
        ? undefined
        : sanitizeStoredText(message.provider_content),
    display_content:
      message.display_content === undefined
        ? undefined
        : sanitizeStoredText(message.display_content),
    privacy_transform: message.privacy_transform
      ? {
          schema_version: "v1",
          replaced_count: Math.max(
            0,
            Math.min(10_000, message.privacy_transform.replaced_count),
          ),
          removed_fields: message.privacy_transform.removed_fields
            .filter((item): item is string => typeof item === "string")
            .slice(0, 32),
          generalized_fields: message.privacy_transform.generalized_fields
            .filter((item): item is string => typeof item === "string")
            .slice(0, 32),
          warnings: message.privacy_transform.warnings
            .filter((item): item is string => typeof item === "string")
            .slice(0, 16),
        }
      : undefined,
    evidence: messageEvidence,
    proposal: message.proposal ? { ...message.proposal } : message.proposal,
    relatedBooks: message.relatedBooks
      ?.map((item) => relatedByRef.get(item.candidate_ref))
      .filter((item): item is RelatedBookCandidate => item !== undefined)
      .slice(0, 5),
  };
}

function sanitizeConversation(
  conversation: ChatConversation,
): ChatConversation {
  const contextManifest = sanitizeContextManifest(conversation.contextManifest);
  return {
    ...conversation,
    title: sanitizeStoredText(conversation.title).slice(0, 120),
    messages: conversation.messages.map((message) =>
      sanitizeMessage(message, contextManifest),
    ),
    contextManifest,
    processing_scope:
      conversation.processing_scope === "personal/scombz_student" ||
      conversation.processing_scope === "personal/sitrus_academic_record" ||
      conversation.processing_scope === "restricted/cast_career" ||
      conversation.processing_scope === "public/syllabus" ||
      conversation.processing_scope === "mixed"
        ? conversation.processing_scope
        : "none",
    provider_destination:
      conversation.provider_destination === "azure_openai" ||
      conversation.provider_destination === "local" ||
      conversation.provider_destination === "unknown" ||
      conversation.provider_destination === "none"
        ? conversation.provider_destination
        : "unknown",
    // Conversations written before the processing metadata existed are
    // deliberately ineligible for provider history.  They may still be
    // displayed locally, but their unclassified transcript/evidence must not
    // silently cross the Azure boundary.
    history_eligible: conversation.history_eligible === true,
  };
}

function safeSanitizeConversation(
  conversation: ChatConversation,
): ChatConversation | null {
  try {
    return sanitizeConversation(conversation);
  } catch (error) {
    // Conflicting evidence cannot be repaired without choosing a source. Do
    // not surface the corrupt conversation as if it were trustworthy.
    if (error instanceof ContextEvidenceConflictError) return null;
    throw error;
  }
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, {
        keyPath: "conversationId",
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB error"));
  });
}

export async function saveConversation(
  conversation: ChatConversation,
): Promise<void> {
  const sanitized = sanitizeConversation(conversation);
  if (
    !sanitized.history_eligible &&
    sanitized.messages.some((message) => message.toolName === "sitrus_read")
  ) {
    await deleteConversation(sanitized.conversationId);
    return;
  }
  const database = await openDatabase();
  if (!database) {
    fallbackStore.set(sanitized.conversationId, sanitized);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(sanitized);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB write error"));
  });
  database.close();
}

export async function loadConversation(
  conversationId: string,
): Promise<ChatConversation | null> {
  const database = await openDatabase();
  if (!database) {
    const stored = fallbackStore.get(conversationId);
    return stored ? safeSanitizeConversation(stored) : null;
  }
  const result = await new Promise<ChatConversation | undefined>(
    (resolve, reject) => {
      const request = database
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(conversationId);
      request.onsuccess = () =>
        resolve(request.result as ChatConversation | undefined);
      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB read error"));
    },
  );
  database.close();
  return result ? safeSanitizeConversation(result) : null;
}

export async function listConversations(): Promise<ChatConversation[]> {
  const database = await openDatabase();
  if (!database) {
    return [...fallbackStore.values()]
      .map(safeSanitizeConversation)
      .filter((item): item is ChatConversation => item !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  const result = await new Promise<ChatConversation[]>((resolve, reject) => {
    const request = database
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .getAll();
    request.onsuccess = () =>
      resolve(
        (request.result as ChatConversation[])
          .map(safeSanitizeConversation)
          .filter((item): item is ChatConversation => item !== null),
      );
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB list error"));
  });
  database.close();
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteConversation(
  conversationId: string,
): Promise<void> {
  const database = await openDatabase();
  if (!database) {
    fallbackStore.delete(conversationId);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(conversationId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB delete error"));
  });
  database.close();
}

export async function deleteAllConversations(): Promise<void> {
  fallbackStore.clear();
  const database = await openDatabase();
  if (!database) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB clear error"));
  });
  database.close();
}

export interface ChatHistoryOptions {
  /**
   * Require an explicitly classified provider projection for every message.
   * This is used for private conversations so a legacy display-only message
   * cannot cross the provider boundary via the `content` fallback.
   */
  requireProviderContent?: boolean;
}

export function toChatHistory(
  messages: ChatTimelineMessage[],
  options: ChatHistoryOptions = {},
): ChatHistoryMessage[] {
  return messages
    .filter(
      (
        message,
      ): message is ChatTimelineMessage & { role: "user" | "assistant" } =>
        message.role === "user" || message.role === "assistant",
    )
    .slice(-20)
    .map((message) => {
      const content = options.requireProviderContent
        ? message.provider_content
        : (message.provider_content ?? message.content);
      if (typeof content !== "string" || content.trim().length === 0) {
        return null;
      }
      if (
        options.requireProviderContent &&
        !isProviderSafeConversationText(content)
      ) {
        // A provider projection is still rejected if an older or corrupted
        // record contains a credential, personal identifier, or sensitive
        // query parameter.  Never let the private-history option weaken the
        // final outbound boundary.
        return null;
      }
      return {
        role: message.role,
        content: sanitizeStoredText(content),
      } satisfies ChatHistoryMessage;
    })
    .filter((item): item is ChatHistoryMessage => item !== null);
}

export function toChatContextManifest(
  manifest: ChatContextManifest,
): ApiChatContextManifest {
  const sanitized = sanitizeContextManifest(manifest);
  return {
    schema_version: "v1",
    evidence: sanitized.evidence,
    library_records: sanitized.library_records.map(
      (item): ApiChatLibraryContextRecord => ({
        resource_ref: item.resource_ref,
        record: item.record,
        evidence_ids: item.evidence_ids,
        observed_at: item.observed_at,
      }),
    ),
    related_books: sanitized.related_books,
  };
}

export function mergeLibraryContext(
  conversation: ChatConversation,
  records: readonly LibraryBibliographicRecord[],
  evidence: readonly EvidenceLink[] = [],
): ChatConversation {
  const current = sanitizeContextManifest(conversation.contextManifest);
  const incomingEvidence = evidence
    .map(sanitizeEvidence)
    .filter((item): item is EvidenceLink => item !== null);
  const normalizedEvidence = mergeEvidenceById([
    current.evidence,
    incomingEvidence,
  ]).slice(0, 100);
  const evidenceIds = new Set(
    normalizedEvidence.map((item) => item.evidence_id),
  );
  const libraryEvidenceIds = normalizedEvidence
    .filter((item) => item.source_type === "library")
    .map((item) => item.evidence_id);
  const byRef = new Map(
    current.library_records.map((item) => [item.record.resource_ref, item]),
  );
  for (const value of records) {
    const record = sanitizeLibraryRecord(value);
    if (!record) continue;
    const previous = byRef.get(record.resource_ref);
    byRef.set(record.resource_ref, {
      resource_ref: record.resource_ref,
      record,
      evidence_ids: (previous?.evidence_ids ?? []).filter((id) =>
        evidenceIds.has(id),
      ),
      observed_at: new Date().toISOString(),
    });
  }
  if (libraryEvidenceIds.length > 0) {
    for (const [resourceRef, item] of byRef) {
      byRef.set(resourceRef, {
        ...item,
        evidence_ids: [
          ...new Set([...item.evidence_ids, ...libraryEvidenceIds]),
        ].filter((id) => evidenceIds.has(id)),
      });
    }
  }
  const contextManifest = sanitizeContextManifest({
    schema_version: "v1",
    evidence: normalizedEvidence,
    library_records: [...byRef.values()].slice(0, 20),
    related_books: current.related_books,
  });
  return { ...conversation, contextManifest };
}

export function mergeConversationEvidence(
  conversation: ChatConversation,
  evidence: readonly EvidenceLink[],
): ChatConversation {
  return mergeLibraryContext(conversation, [], evidence);
}

export function mergeRelatedBookContext(
  conversation: ChatConversation,
  candidates: readonly RelatedBookCandidate[],
  evidence: readonly EvidenceLink[] = [],
): ChatConversation {
  const withEvidence = mergeConversationEvidence(conversation, evidence);
  const current = sanitizeContextManifest(withEvidence.contextManifest);
  const byRef = new Map(
    current.related_books.map((item) => [item.candidate_ref, item]),
  );
  const evidenceIds = new Set(current.evidence.map((item) => item.evidence_id));
  const libraryRefs = new Set(
    current.library_records.map((item) => item.resource_ref),
  );
  for (const item of candidates) {
    const sanitized = sanitizeRelatedBook(item, evidenceIds, libraryRefs);
    if (sanitized) byRef.set(sanitized.candidate_ref, sanitized);
  }
  return {
    ...withEvidence,
    contextManifest: sanitizeContextManifest({
      ...current,
      related_books: [...byRef.values()].slice(-20),
    }),
  };
}

/**
 * Merge one completed API response into a conversation at a single durable
 * boundary.  The response intentionally repeats public evidence in the
 * assistant message and context manifest; both representations are folded by
 * evidence_id before records or candidates are persisted.
 */
export function mergeCompletedChatContext(
  conversation: ChatConversation,
  responseManifest: ApiChatContextManifest | null | undefined,
  assistant: Pick<ChatTimelineMessage, "evidence" | "relatedBooks">,
): ChatConversation {
  const current = sanitizeContextManifest(conversation.contextManifest);
  const incomingEvidence = (responseManifest?.evidence ?? [])
    .map(sanitizeEvidence)
    .filter((item): item is EvidenceLink => item !== null);
  const assistantEvidence = (assistant.evidence ?? [])
    .map(sanitizeEvidence)
    .filter((item): item is EvidenceLink => item !== null);
  const evidence = mergeEvidenceById([
    current.evidence,
    incomingEvidence,
    assistantEvidence,
  ]).slice(0, 100);

  // Preserve records from earlier turns and merge their evidence references
  // with the completed response before validating the combined manifest.
  const recordsByRef = new Map(
    current.library_records.map((item) => [item.resource_ref, item]),
  );
  for (const item of responseManifest?.library_records ?? []) {
    const record = sanitizeLibraryRecord(item.record);
    if (!record) continue;
    const observed = new Date(item.observed_at);
    if (Number.isNaN(observed.getTime())) continue;
    const previous = recordsByRef.get(record.resource_ref);
    recordsByRef.set(record.resource_ref, {
      resource_ref: record.resource_ref,
      record,
      evidence_ids: [
        ...new Set([
          ...(previous?.evidence_ids ?? []),
          ...(item.evidence_ids ?? []),
        ]),
      ],
      observed_at: observed.toISOString(),
    });
  }
  const evidenceIds = new Set(evidence.map((item) => item.evidence_id));
  const records = [...recordsByRef.values()].map((item) => ({
    ...item,
    evidence_ids: item.evidence_ids.filter((id) => evidenceIds.has(id)),
  }));

  return {
    ...conversation,
    contextManifest: sanitizeContextManifest({
      schema_version: "v1",
      evidence,
      library_records: records.slice(0, 20),
      related_books: [
        ...current.related_books,
        ...(responseManifest?.related_books ?? []),
        ...(assistant.relatedBooks ?? []),
      ],
    }),
  };
}

export function newConversation(): ChatConversation {
  const now = new Date().toISOString();
  const conversationId =
    globalThis.crypto?.randomUUID?.() ?? `conversation-${Date.now()}`;
  return {
    conversationId,
    title: "新しいChat",
    createdAt: now,
    updatedAt: now,
    messages: [],
    contextManifest: {
      schema_version: "v1",
      evidence: [],
      library_records: [],
      related_books: [],
    },
    processing_scope: "none",
    provider_destination: "none",
    history_eligible: true,
  };
}
