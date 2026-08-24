import { afterEach, describe, expect, it, vi } from "vitest";
import { AZURE_DEMO_AGENT_API_BASE } from "../api/client";
import {
  FIRST_USE_SETUP_STORAGE_KEY,
  type FirstUseSetupRecord,
} from "../auth/first-use-setup";
import { App } from "./App";
import {
  buttonByName,
  click,
  mountSidePanel,
  unmountSidePanel,
  waitFor,
} from "./ui-test-helpers";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

describe("first-use setup gate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("authenticates and prepares campus login tabs before Chat is unlocked", async () => {
    let setupRecord: FirstUseSetupRecord | null = null;
    const created: Array<{ url?: string; active?: boolean }> = [];
    const existingOrigins = new Set<string>();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        `${AZURE_DEMO_AGENT_API_BASE}/v1/auth/session`,
      );
      return jsonResponse({
        access_token: "opaque-setup-session",
        expires_at: "2099-01-01T00:00:00Z",
      });
    });
    const redirectUri =
      "https://onlkblmignmbeaogocmhgkiecmdlihci.chromiumapp.org/agent-auth";
    const chromeTabs = {
      query: vi.fn(async ({ url }: { url: string }) => {
        const origin = url.replace(/\/\*$/u, "");
        return existingOrigins.has(origin) ? [{ id: 1 }] : [];
      }),
      create: vi.fn(async (options: { url?: string; active?: boolean }) => {
        created.push(options);
        if (options.url) existingOrigins.add(new URL(options.url).origin);
        return { id: created.length };
      }),
    };

    vi.stubGlobal(
      "__ORBIT_GOOGLE_AGENT_OAUTH_CLIENT_ID__",
      "agent-web-client.apps.googleusercontent.com",
    );
    vi.stubGlobal("fetch", fetcher);
    const mounted = await mountSidePanel(
      () => <App />,
      (runtime) => {
        vi.stubGlobal("chrome", {
          runtime: { ...runtime, lastError: undefined },
          identity: {
            getRedirectURL: () => redirectUri,
            launchWebAuthFlow: vi.fn(async ({ url }: { url: string }) => {
              const authorizationUrl = new URL(url);
              return `${redirectUri}?iss=${encodeURIComponent("https://accounts.google.com")}&state=${authorizationUrl.searchParams.get("state")}&code=one-time-code`;
            }),
          },
          storage: {
            local: {
              get: vi.fn(async () =>
                setupRecord
                  ? { [FIRST_USE_SETUP_STORAGE_KEY]: setupRecord }
                  : {},
              ),
              set: vi.fn(async (value: Record<string, unknown>) => {
                setupRecord = value[
                  FIRST_USE_SETUP_STORAGE_KEY
                ] as FirstUseSetupRecord;
              }),
              remove: vi.fn(async () => {
                setupRecord = null;
              }),
            },
            session: {
              get: vi.fn(async () => ({})),
              set: vi.fn(async () => undefined),
            },
          },
          tabs: chromeTabs,
        });
      },
    );

    try {
      await waitFor(() =>
        Boolean(
          Array.from(mounted.document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "初回セットアップを開始",
          ),
        ),
      );
      expect(fetcher).not.toHaveBeenCalled();
      expect(mounted.document.querySelector(".chat-panel")).toBeNull();

      await click(buttonByName(mounted.document, "初回セットアップを開始"));
      await waitFor(
        () =>
          mounted.document.body.textContent?.includes(
            "学内ログインを完了してください",
          ) ?? false,
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(created).toHaveLength(5);
      expect(created[0]?.active).toBe(true);
      expect(created.slice(1).every((tab) => tab.active === false)).toBe(true);

      await click(buttonByName(mounted.document, "ログインを完了して開始"));
      await waitFor(() =>
        Boolean(mounted.document.querySelector(".chat-panel")),
      );
      expect(
        (setupRecord as FirstUseSetupRecord | null)?.completedAt,
      ).toBeTypeOf("string");
    } finally {
      await unmountSidePanel(mounted.root);
    }
  });
});
