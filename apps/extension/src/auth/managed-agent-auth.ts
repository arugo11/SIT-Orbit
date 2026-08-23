import {
  AgentApiClient,
  type AgentSessionResponse,
  type Fetcher,
} from "../api/client";

const SESSION_STORAGE_KEY = "orbit-managed-agent-session-v1";
const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_SCOPES = ["openid", "email"];
export const GOOGLE_AGENT_REDIRECT_PATH = "agent-auth";
const REFRESH_MARGIN_MS = 30_000;

interface StoredSession {
  accessToken: string;
  expiresAt: string;
}

export class ManagedAgentAuthenticationError extends Error {
  constructor(message = "SITアカウントでAgentに接続できませんでした。") {
    super(message);
    this.name = "ManagedAgentAuthenticationError";
  }
}

function agentClientId(): string {
  // The production bundle always defines this symbol, including as an empty
  // string. A missing symbol only occurs in source-level fixture tests, where
  // the manifest fallback keeps the authentication provider easy to mount.
  const compiledClientId =
    typeof __ORBIT_GOOGLE_AGENT_OAUTH_CLIENT_ID__ === "undefined"
      ? null
      : typeof __ORBIT_GOOGLE_AGENT_OAUTH_CLIENT_ID__ === "string"
        ? __ORBIT_GOOGLE_AGENT_OAUTH_CLIENT_ID__.trim()
        : "";
  const manifest = chrome.runtime.getManifest?.() as
    | { oauth2?: { client_id?: string } }
    | undefined;
  const clientId =
    compiledClientId ?? manifest?.oauth2?.client_id?.trim() ?? "";
  if (!clientId) {
    throw new ManagedAgentAuthenticationError(
      "Agent認証が設定されていません。管理者のOAuth設定を確認してください。",
    );
  }
  return clientId;
}

function sessionIsUsable(
  session: StoredSession | null,
): session is StoredSession {
  if (!session?.accessToken || !session.expiresAt) return false;
  const expiresAt = Date.parse(session.expiresAt);
  return (
    Number.isFinite(expiresAt) && expiresAt - Date.now() > REFRESH_MARGIN_MS
  );
}

async function readStoredSession(): Promise<StoredSession | null> {
  const stored = await chrome.storage?.session?.get(SESSION_STORAGE_KEY);
  const value = stored?.[SESSION_STORAGE_KEY] as
    | Partial<StoredSession>
    | undefined;
  if (
    !value ||
    typeof value.accessToken !== "string" ||
    typeof value.expiresAt !== "string"
  ) {
    return null;
  }
  return { accessToken: value.accessToken, expiresAt: value.expiresAt };
}

async function writeStoredSession(session: StoredSession): Promise<void> {
  await chrome.storage?.session?.set({ [SESSION_STORAGE_KEY]: session });
}

function parseIdToken(responseUrl: string, expectedState: string): string {
  let url: URL;
  try {
    url = new URL(responseUrl);
  } catch {
    throw new ManagedAgentAuthenticationError();
  }
  const values = new URLSearchParams(url.hash.replace(/^#/u, ""));
  if (values.get("state") !== expectedState) {
    throw new ManagedAgentAuthenticationError();
  }
  const idToken = values.get("id_token");
  if (!idToken) {
    throw new ManagedAgentAuthenticationError();
  }
  return idToken;
}

async function requestGoogleIdToken(): Promise<string> {
  if (
    typeof chrome.identity?.launchWebAuthFlow !== "function" ||
    typeof chrome.identity?.getRedirectURL !== "function"
  ) {
    throw new ManagedAgentAuthenticationError();
  }
  const state = crypto.randomUUID();
  const redirectUri = chrome.identity.getRedirectURL(
    GOOGLE_AGENT_REDIRECT_PATH,
  );
  const params = new URLSearchParams({
    client_id: agentClientId(),
    redirect_uri: redirectUri,
    response_type: "id_token",
    scope: GOOGLE_SCOPES.join(" "),
    nonce: crypto.randomUUID(),
    state,
    prompt: "select_account",
  });
  try {
    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`,
      interactive: true,
    });
    if (typeof responseUrl !== "string") {
      throw new ManagedAgentAuthenticationError();
    }
    return parseIdToken(responseUrl, state);
  } catch (error) {
    if (error instanceof ManagedAgentAuthenticationError) throw error;
    throw new ManagedAgentAuthenticationError();
  }
}

export interface ManagedAgentSessionProviderOptions {
  baseUrl: string;
  fetcher?: Fetcher;
}

export function createManagedAgentSessionProvider({
  baseUrl,
  fetcher,
}: ManagedAgentSessionProviderOptions): (
  forceRefresh?: boolean,
) => Promise<string | null> {
  const exchangeClient = new AgentApiClient({ baseUrl, fetcher });
  let memorySession: StoredSession | null = null;

  return async (forceRefresh = false): Promise<string | null> => {
    if (!forceRefresh) {
      if (sessionIsUsable(memorySession)) return memorySession.accessToken;
      const stored = await readStoredSession();
      if (sessionIsUsable(stored)) {
        memorySession = stored;
        return stored.accessToken;
      }
    }

    // Fixture and unit-test mounts do not expose Chrome Identity. They use the
    // same managed endpoint with no bearer header; production builds inject the
    // OAuth client ID and therefore take the authenticated path above.
    if (typeof chrome.identity?.launchWebAuthFlow !== "function") return null;
    const idToken = await requestGoogleIdToken();
    const session: AgentSessionResponse =
      await exchangeClient.createSession(idToken);
    const next: StoredSession = {
      accessToken: session.access_token,
      expiresAt: session.expires_at,
    };
    memorySession = next;
    await writeStoredSession(next);
    return next.accessToken;
  };
}
