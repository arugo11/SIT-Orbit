import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagedAgentSessionProvider } from "./managed-agent-auth";

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

  it("exchanges a Chrome Identity ID token and keeps the session in memory/storage", async () => {
    const stored: Record<string, unknown> = {};
    vi.stubGlobal(
      "__ORBIT_GOOGLE_AGENT_OAUTH_CLIENT_ID__",
      "agent-web-client.apps.googleusercontent.com",
    );
    const launchWebAuthFlow = vi.fn(async ({ url }: { url: string }) => {
      const state = new URL(url).searchParams.get("state");
      const redirectUri = new URL(url).searchParams.get("redirect_uri");
      expect(redirectUri).toBe(
        "https://onlkblmignmbeaogocmhgkiecmdlihci.chromiumapp.org/agent-auth",
      );
      return `${redirectUri}#state=${state}&id_token=google-id-token`;
    });
    const fetcher = vi.fn(async () =>
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
        body: JSON.stringify({ id_token: "google-id-token" }),
      }),
    );
    expect(stored).toEqual({
      "orbit-managed-agent-session-v1": {
        accessToken: "opaque-session",
        expiresAt: "2099-01-01T00:00:00Z",
      },
    });
    expect(JSON.stringify(stored)).not.toContain("google-id-token");
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
