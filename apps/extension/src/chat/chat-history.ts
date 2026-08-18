import type { ActionProposal, ChatHistoryMessage } from "../api/client";

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
}

const DATABASE_NAME = "sit-orbit-chat";
const DATABASE_VERSION = 1;
const STORE_NAME = "conversations";

const fallbackStore = new Map<string, ChatConversation>();

function sanitizeStoredText(value: string): string {
  return value.replace(/<[^>]*>/g, "").slice(0, 12000);
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
  };
}
