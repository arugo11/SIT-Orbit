import type {
  ActionProposal,
  ChatContextManifest as ApiChatContextManifest,
  ChatLibraryContextRecord as ApiChatLibraryContextRecord,
  ChatHistoryMessage,
  EvidenceLink,
  LibraryBibliographicRecord,
} from "../api/client";

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
}

export interface ChatConversation {
  conversationId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatTimelineMessage[];
  contextManifest: ChatContextManifest;
}

export interface ChatContextManifest {
  schema_version: "v1";
  evidence: EvidenceLink[];
  library_records: ChatLibraryContextRecord[];
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

function sanitizeStoredText(value: string): string {
  return value.replace(/<[^>]*>/g, "").slice(0, 12000);
}

const LIBRARY_RESOURCE_REF_RE =
  /^orbit-library:\/\/record\/[A-Za-z0-9_-]{16,128}$/u;
const LIBRARY_RECORD_PATH = "/opc/recordID/catalog.bib/";

function sanitizeEvidence(item: EvidenceLink): EvidenceLink | null {
  if (
    !item ||
    !["public", "synthetic"].includes(item.data_classification) ||
    !item.evidence_id ||
    !item.title ||
    !item.locator
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
  const evidence = (value?.evidence ?? [])
    .map(sanitizeEvidence)
    .filter((item): item is EvidenceLink => item !== null)
    .slice(0, 100);
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
  return {
    schema_version: "v1",
    evidence,
    library_records: [...byRef.values()],
  };
}

function sanitizeMessage(message: ChatTimelineMessage): ChatTimelineMessage {
  return {
    ...message,
    content: sanitizeStoredText(message.content),
    evidence: message.evidence?.map((item) => ({ ...item })),
    proposal: message.proposal ? { ...message.proposal } : message.proposal,
  };
}

function sanitizeConversation(
  conversation: ChatConversation,
): ChatConversation {
  return {
    ...conversation,
    title: sanitizeStoredText(conversation.title).slice(0, 120),
    messages: conversation.messages.map(sanitizeMessage),
    contextManifest: sanitizeContextManifest(conversation.contextManifest),
  };
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
    return fallbackStore.get(conversationId) ?? null;
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
  return result ? sanitizeConversation(result) : null;
}

export async function listConversations(): Promise<ChatConversation[]> {
  const database = await openDatabase();
  if (!database) {
    return [...fallbackStore.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  const result = await new Promise<ChatConversation[]>((resolve, reject) => {
    const request = database
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .getAll();
    request.onsuccess = () =>
      resolve((request.result as ChatConversation[]).map(sanitizeConversation));
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

export function toChatHistory(
  messages: ChatTimelineMessage[],
): ChatHistoryMessage[] {
  return messages
    .filter(
      (
        message,
      ): message is ChatTimelineMessage & { role: "user" | "assistant" } =>
        message.role === "user" || message.role === "assistant",
    )
    .slice(-20)
    .map((message) => ({ role: message.role, content: message.content }));
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
  };
}

export function mergeLibraryContext(
  conversation: ChatConversation,
  records: readonly LibraryBibliographicRecord[],
  evidence: readonly EvidenceLink[] = [],
): ChatConversation {
  const current = sanitizeContextManifest(conversation.contextManifest);
  const nextEvidence = [
    ...current.evidence,
    ...evidence
      .map(sanitizeEvidence)
      .filter((item): item is EvidenceLink => item !== null),
  ];
  const normalizedEvidence = sanitizeContextManifest({
    evidence: nextEvidence,
  }).evidence;
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
  });
  return { ...conversation, contextManifest };
}

export function mergeConversationEvidence(
  conversation: ChatConversation,
  evidence: readonly EvidenceLink[],
): ChatConversation {
  return mergeLibraryContext(conversation, [], evidence);
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
    },
  };
}
