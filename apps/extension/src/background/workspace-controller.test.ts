import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageContext } from "../content/page-context";
import type { WorkspaceSession } from "../shared/workspace-session";
import { WorkspaceSessionController } from "./workspace-controller";

const sessionId = "123e4567-e89b-12d3-a456-426614174000";
const storageValues: Record<string, unknown> = {};
const storageGet = vi.fn(async (keys: string | string[] | null) => {
  if (keys === null) return { ...storageValues };
  const requested = Array.isArray(keys) ? keys : [keys];
  return Object.fromEntries(
    requested
      .filter((key) => key in storageValues)
      .map((key) => [key, storageValues[key]]),
  );
});
const storageSet = vi.fn(async (values: Record<string, unknown>) => {
  Object.assign(storageValues, values);
});
const getTab = vi.fn();
const queryTabs = vi.fn(async () => [
  { id: 31, windowId: 1, url: "https://example.com/unrelated" },
]);

const pageContext: PageContext = {
  title: "SCombZ",
  url: "https://scombz.shibaura-it.ac.jp/portal/home",
  kind: "scombz",
};

function makeSession(
  overrides: Partial<WorkspaceSession> = {},
): WorkspaceSession {
  return {
    sessionId,
    sourceTabId: 11,
    sourceWindowId: 2,
    workspaceTabId: 91,
    pageContext,
    stableState: {
      status: "idle",
      proposal: null,
      completionEvent: null,
      changeNote: "",
      error: null,
    },
    sourceAvailable: true,
    updatedAt: "2026-09-08T00:00:00.000Z",
    ...overrides,
  };
}

function installChrome(): void {
  for (const key of Object.keys(storageValues)) {
    delete storageValues[key];
  }
  getTab.mockReset();
  queryTabs.mockClear();
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: (path: string) => `chrome-extension://orbit-extension-id/${path}`,
    },
    storage: {
      session: {
        get: storageGet,
        set: storageSet,
      },
    },
    tabs: {
      get: getTab,
      query: queryTabs,
    },
  });
}

describe("WorkspaceSessionController status", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("finds a workspace in another window without selecting the active unrelated tab", async () => {
    installChrome();
    const session = makeSession();
    storageValues[`workspace:session:${sessionId}`] = session;
    getTab.mockResolvedValue({
      id: 91,
      windowId: 2,
      url: `chrome-extension://orbit-extension-id/workspace.html?session=${sessionId}`,
    });

    const result = await new WorkspaceSessionController(
      async () => null,
    ).status();

    expect(result).toEqual({
      active: true,
      session,
      sourceTabId: session.sourceTabId,
    });
    expect(queryTabs).not.toHaveBeenCalled();
  });

  it("clears a saved workspace reference when its tab is closed", async () => {
    installChrome();
    storageValues[`workspace:session:${sessionId}`] = makeSession();
    getTab.mockRejectedValue(new Error("No tab with id: 91"));

    const result = await new WorkspaceSessionController(
      async () => null,
    ).status();

    expect(result).toEqual({ active: false, session: null, sourceTabId: null });
    expect(storageValues[`workspace:session:${sessionId}`]).toMatchObject({
      sessionId,
      workspaceTabId: null,
    });
  });

  it("rejects a reused tab ID when the tab is not the matching extension workspace", async () => {
    installChrome();
    storageValues[`workspace:session:${sessionId}`] = makeSession();
    getTab.mockResolvedValue({
      id: 91,
      windowId: 2,
      url: "https://scombz.shibaura-it.ac.jp/portal/home",
    });

    const result = await new WorkspaceSessionController(
      async () => null,
    ).status();

    expect(result.active).toBe(false);
    expect(storageValues[`workspace:session:${sessionId}`]).toMatchObject({
      workspaceTabId: null,
    });
  });
});
