import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createManagedAgentSessionProvider,
  ManagedAgentAuthenticationError,
} from "./managed-agent-auth";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

describe("managed Agent authentication", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exchanges a PKCE authorization code and stores only the managed session", async () => {
    const stored: Record<string, unknown> = {};
    vi.stubGlobal(
      "__ORBIT_GOOGLE_AGENT_OAUTH_CLIENT_ID__",
      "agent-web-client.apps.googleusercontent.com",
    );
    const launchWebAuthFlow = vi.fn(async ({ url }: { url: string }) => {
      const authorizationUrl = new URL(url);
      const state = authorizationUrl.searchParams.get("state");
      const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
      expect(redirectUri).toBe(
        "https://onlkblmignmbeaogocmhgkiecmdlihci.chromiumapp.org/agent-auth",
      );
      expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
      expect(authorizationUrl.searchParams.get("response_mode")).toBe("query");
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      expect(authorizationUrl.searchParams.get("code_challenge")).toMatch(
        /^[A-Za-z0-9_-]{43}$/u,
      );
      expect(authorizationUrl.searchParams.get("prompt")).toBe(
        "select_account",
      );
      expect(authorizationUrl.searchParams.has("code_verifier")).toBe(false);
      expect(authorizationUrl.searchParams.has("client_secret")).toBe(false);
      return `${redirectUri}?iss=${encodeURIComponent("https://accounts.google.com")}&state=${state}&code=one-time-code`;
    });
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          access_token: "opaque-session",
          expires_at: "2099-01-01T00:00:00Z",
        }),
    );
    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: () => ({}),
      },
      identity: {
        getRedirectURL: (path?: string) =>
          `https://onlkblmignmbeaogocmhgkiecmdlihci.chromiumapp.org/${path ?? ""}`,
        launchWebAuthFlow,
      },
      storage: {
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async (value: Record<string, unknown>) => {
            Object.assign(stored, value);
          }),
        },
      },
    });

    const provider = createManagedAgentSessionProvider({
      baseUrl: "https://agent.example.test",
      fetcher,
    });

    await expect(provider()).resolves.toBe("opaque-session");
    await expect(provider()).resolves.toBe("opaque-session");
    expect(launchWebAuthFlow).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "https://agent.example.test/v1/auth/session",
      expect.objectContaining({
        body: expect.any(String),
      }),
    );
    const request = JSON.parse(
      String((fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as { authorization_code: string; code_verifier: string };
    expect(request.authorization_code).toBe("one-time-code");
    expect(request.code_verifier).toMatch(/^[A-Za-z0-9_-]{86}$/u);
    const challenge = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(request.code_verifier),
      ),
    );
    const expectedChallenge = Buffer.from(challenge).toString("base64url");
    const firstAuthorizationRequest = launchWebAuthFlow.mock.calls[0]?.[0] as
      | { url: string }
      | undefined;
    expect(firstAuthorizationRequest).toBeDefined();
    if (!firstAuthorizationRequest) throw new Error("OAuth was not started.");
    expect(
      new URL(firstAuthorizationRequest.url).searchParams.get("code_challenge"),
    ).toBe(expectedChallenge);
    expect(stored).toEqual({
      "orbit-managed-agent-session-v1": {
        accessToken: "opaque-session",
        expiresAt: "2099-01-01T00:00:00Z",
      },
    });
    expect(JSON.stringify(stored)).not.toContain("one-time-code");
    expect(JSON.stringify(stored)).not.toContain(request.code_verifier);
  });

  it("does not force account selection when refreshing an existing session", async () => {
    vi.stubGlobal(
      "__ORBIT_GOOGLE_AGENT_OAUTH_CLIENT_ID__",
      "agent-web-client.apps.googleusercontent.com",
    );
    const launchWebAuthFlow = vi.fn(async ({ url }: { url: string }) => {
      const authorizationUrl = new URL(url);
      const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
      return `${redirectUri}?iss=${encodeURIComponent("https://accounts.google.com")}&state=${authorizationUrl.searchParams.get("state")}&code=refreshed-code`;
    });
    vi.stubGlobal("chrome", {
      runtime: { getManifest: () => ({}) },
      identity: {
        getRedirectURL: (path?: string) =>
          `https://onlkblmignmbeaogocmhgkiecmdlihci.chromiumapp.org/${path ?? ""}`,
        launchWebAuthFlow,
      },
      storage: {
        session: {
          get: vi.fn(async () => ({
            "orbit-managed-agent-session-v1": {
              accessToken: "expired-session",
              expiresAt: "2020-01-01T00:00:00Z",
            },
          })),
          set: vi.fn(async () => undefined),
        },
      },
    });
    const provider = createManagedAgentSessionProvider({
      baseUrl: "https://agent.example.test",
      fetcher: vi.fn(async () =>
        jsonResponse({
          access_token: "refreshed-session",
          expires_at: "2099-01-01T00:00:00Z",
        }),
      ),
    });

    await expect(provider()).resolves.toBe("refreshed-session");

    const refreshAuthorizationRequest = launchWebAuthFlow.mock.calls[0]?.[0] as
      | { url: string }
      | undefined;
    expect(refreshAuthorizationRequest).toBeDefined();
    if (!refreshAuthorizationRequest)
      throw new Error("OAuth refresh was not started.");
    const authorizationUrl = new URL(refreshAuthorizationRequest.url);
    expect(authorizationUrl.searchParams.has("prompt")).toBe(false);
  });

  it("rejects a callback whose state does not match before exchanging the code", async () => {
    vi.stubGlobal(
      "__ORBIT_GOOGLE_AGENT_OAUTH_CLIENT_ID__",
      "agent-web-client.apps.googleusercontent.com",
    );
    const fetcher = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: { getManifest: () => ({}) },
      identity: {
        getRedirectURL: (path?: string) =>
          `https://onlkblmignmbeaogocmhgkiecmdlihci.chromiumapp.org/${path ?? ""}`,
        launchWebAuthFlow: vi.fn(async ({ url }: { url: string }) => {
          const redirectUri = new URL(url).searchParams.get("redirect_uri");
          return `${redirectUri}?iss=${encodeURIComponent("https://accounts.google.com")}&state=wrong-state&code=intercepted-code`;
        }),
      },
      storage: {
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
      },
    });
    const provider = createManagedAgentSessionProvider({
      baseUrl: "https://agent.example.test",
      fetcher,
    });

    await expect(provider()).rejects.toBeInstanceOf(
      ManagedAgentAuthenticationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not invoke OAuth in fixture-style Chrome test mounts", async () => {
    vi.stubGlobal("chrome", {
      runtime: { getManifest: () => ({}) },
    });
    const provider = createManagedAgentSessionProvider({
      baseUrl: "https://agent.example.test",
      fetcher: vi.fn(),
    });

    await expect(provider()).resolves.toBeNull();
  });
});
