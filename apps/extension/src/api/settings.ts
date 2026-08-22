import { AZURE_DEMO_AGENT_API_BASE, DEFAULT_AGENT_API_BASE } from "./client";

const STORAGE_KEY = "orbit-agent-api-connection-v1";

export interface AgentApiConnection {
  baseUrl: string;
  accessToken: string;
}

export const DEFAULT_AGENT_API_CONNECTION: AgentApiConnection = {
  baseUrl: DEFAULT_AGENT_API_BASE,
  accessToken: "",
};

export { AZURE_DEMO_AGENT_API_BASE };

function normalizeConnection(value: unknown): AgentApiConnection {
  if (!value || typeof value !== "object") return DEFAULT_AGENT_API_CONNECTION;
  const record = value as Record<string, unknown>;
  if (
    typeof record.baseUrl !== "string" ||
    typeof record.accessToken !== "string"
  ) {
    return DEFAULT_AGENT_API_CONNECTION;
  }
  try {
    const url = new URL(record.baseUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return DEFAULT_AGENT_API_CONNECTION;
    }
    return {
      baseUrl: url.toString().replace(/\/$/u, ""),
      accessToken: record.accessToken.trim(),
    };
  } catch {
    return DEFAULT_AGENT_API_CONNECTION;
  }
}

export async function loadAgentApiConnection(): Promise<AgentApiConnection> {
  if (!globalThis.chrome?.storage?.session) {
    return DEFAULT_AGENT_API_CONNECTION;
  }
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  return normalizeConnection(stored[STORAGE_KEY]);
}

export async function saveAgentApiConnection(
  connection: AgentApiConnection,
): Promise<AgentApiConnection> {
  const normalized = normalizeConnection(connection);
  if (
    normalized === DEFAULT_AGENT_API_CONNECTION &&
    connection.baseUrl.trim() !== DEFAULT_AGENT_API_BASE
  ) {
    throw new TypeError("Agent APIにはHTTP(S)の絶対URLを指定してください。");
  }
  if (!globalThis.chrome?.storage?.session) {
    throw new Error("Chromeのセッションストレージを利用できません。");
  }
  await chrome.storage.session.set({ [STORAGE_KEY]: normalized });
  return normalized;
}

export function isAgentApiConnectionChange(
  changes: Record<string, chrome.storage.StorageChange>,
): AgentApiConnection | null {
  if (!(STORAGE_KEY in changes)) return null;
  return normalizeConnection(changes[STORAGE_KEY]?.newValue);
}
