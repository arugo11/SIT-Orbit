import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MESSAGE_TYPES } from "../shared/messages";

type EventCallback = (...args: never[]) => void;

function createEvent() {
  let callback: EventCallback | undefined;

  return {
    addListener: vi.fn((listener: EventCallback) => {
      callback = listener;
    }),
    dispatch: (...args: unknown[]) => {
      callback?.(...(args as never[]));
    },
  };
}

const onInstalled = createEvent();
const onStartup = createEvent();
const onUpdated = createEvent();
const onActivated = createEvent();
const onRemoved = createEvent();
const onMessage = createEvent();
const setOptions = vi.fn(async (_options: unknown) => undefined);
const setPanelBehavior = vi.fn(async (_options: unknown) => undefined);
const sendMessage = vi.fn(async (_message: unknown) => undefined);
const queryTabs = vi.fn(
  async (_query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> => [],
);
const getTab = vi.fn(async (tabId: number) => ({
  id: tabId,
  windowId: 4,
  url: "https://scombz.shibaura-it.ac.jp/portal/home",
}));
const tabSendMessage = vi.fn(
  async (_tabId: number, _message: unknown): Promise<unknown> => undefined,
);
const getAuthToken = vi.fn(async () => "calendar-worker-token");
const removeCachedAuthToken = vi.fn(
  async (_details: { token: string }) => undefined,
);
const storageValues: Record<string, unknown> = {};
const storageGet = vi.fn(async (keys: string | string[] | null) => {
  if (keys === null) {
    return { ...storageValues };
  }
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
const createTab = vi.fn(async (properties: chrome.tabs.CreateProperties) => ({
  id: 91,
  windowId: properties.windowId ?? 1,
  url: properties.url,
}));
const updateTab = vi.fn(async (_tabId: number, _properties: unknown) => ({}));
const updateWindow = vi.fn(
  async (_windowId: number, _properties: unknown) => ({}),
);
const permissionsContains = vi.fn(async (_permissions: unknown) => false);
const executeScript = vi.fn(
  async (_details: unknown): Promise<Array<{ result?: unknown }>> => [],
);

const chromeMock = {
  runtime: {
    id: "orbit-extension-id",
    onInstalled,
    onStartup,
    onMessage,
    sendMessage,
    getURL: (path: string) => `chrome-extension://orbit-extension-id/${path}`,
  },
  sidePanel: {
    setOptions,
    setPanelBehavior,
  },
  tabs: {
    onUpdated,
    onActivated,
    onRemoved,
    get: getTab,
    query: queryTabs,
    create: createTab,
    update: updateTab,
    sendMessage: tabSendMessage,
  },
  identity: {
    getAuthToken,
    removeCachedAuthToken,
  },
  storage: {
    session: {
      get: storageGet,
      set: storageSet,
    },
  },
  windows: {
    update: updateWindow,
  },
  permissions: {
    contains: permissionsContains,
  },
  scripting: {
    executeScript,
  },
} as unknown as typeof chrome;

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: chromeMock,
});

await import("./service-worker");

afterAll(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("service worker side panel contract", () => {
  beforeEach(() => {
    setOptions.mockClear();
    setPanelBehavior.mockClear();
    sendMessage.mockClear();
    queryTabs.mockClear();
    getTab.mockClear();
    tabSendMessage.mockReset();
    tabSendMessage.mockResolvedValue(undefined);
    getAuthToken.mockClear();
    removeCachedAuthToken.mockClear();
    storageGet.mockClear();
    storageSet.mockClear();
    createTab.mockClear();
    updateTab.mockClear();
    updateWindow.mockClear();
    permissionsContains.mockReset();
    permissionsContains.mockResolvedValue(false);
    executeScript.mockReset();
    executeScript.mockResolvedValue([]);
    for (const key of Object.keys(storageValues)) {
      delete storageValues[key];
    }
  });

  it("returns only Moodle aggregates while keeping local detail in the extension response", async () => {
    permissionsContains.mockResolvedValue(true);
    queryTabs.mockResolvedValue([
      {
        id: 55,
        url: "https://moodle.sic.shibaura-it.ac.jp/moodle/my/",
      },
    ] as chrome.tabs.Tab[]);
    executeScript.mockResolvedValue([
      {
        result: {
          status: "known",
          detail: {
            courses: ["制御工学"],
            upcoming: [
              {
                title: "レポート1",
                course: "制御工学",
                due_at: "2026-08-24T06:00:00.000Z",
                overdue: false,
              },
            ],
            unread_notification_count: 2,
          },
        },
      },
    ]);
    const response = vi.fn();
    onMessage.dispatch(
      { type: MESSAGE_TYPES.moodleRead, tool_call_id: "moodle-call-1" },
      {},
      response,
    );
    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));
    const payload = response.mock.calls[0]?.[0];
    expect(payload).toEqual(
      expect.objectContaining({
        status: "known",
        projection: expect.objectContaining({
          course_count: 1,
          upcoming_item_count: 1,
          unread_notification_count: 2,
        }),
      }),
    );
    expect(JSON.stringify(payload.projection)).not.toContain("制御工学");
    expect(JSON.stringify(payload.projection)).not.toContain("レポート1");
  });

  it("enables the panel per tab and preserves its path for ScombZ and other origins", async () => {
    onUpdated.dispatch(
      11,
      { url: "https://scombz.shibaura-it.ac.jp/course/calculus" },
      { url: "https://scombz.shibaura-it.ac.jp/course/calculus" },
    );
    onUpdated.dispatch(
      22,
      { url: "https://example.com/course/calculus" },
      { url: "https://example.com/course/calculus" },
    );
    onUpdated.dispatch(
      33,
      {
        url: "https://sitrus.sic.shibaura-it.ac.jp/SITRUS/login/ShutokuTaniShukei.html?N=synthetic",
      },
      {
        url: "https://sitrus.sic.shibaura-it.ac.jp/SITRUS/login/ShutokuTaniShukei.html?N=synthetic",
      },
    );

    await vi.waitFor(() => expect(setOptions).toHaveBeenCalledTimes(3));

    expect(setOptions).toHaveBeenCalledWith({
      tabId: 11,
      path: "sidepanel.html",
      enabled: true,
    });
    expect(setOptions).toHaveBeenCalledWith({
      tabId: 22,
      path: "sidepanel.html",
      enabled: false,
    });
    expect(setOptions).toHaveBeenCalledWith({
      tabId: 33,
      path: "sidepanel.html",
      enabled: true,
    });
    expect(setPanelBehavior).not.toHaveBeenCalled();
  });

  it("does not rebroadcast a background tab context to the visible panel", async () => {
    queryTabs.mockResolvedValueOnce([
      {
        id: 11,
        url: "https://scombz.shibaura-it.ac.jp/portal/home",
      },
    ] as chrome.tabs.Tab[]);
    const message = {
      type: "page-context-updated",
      context: {
        title: "Background tab",
        url: "https://scombz.shibaura-it.ac.jp/course/calculus",
        kind: "scombz",
      },
    };

    onMessage.dispatch(message, { tab: { id: 22 } });

    await vi.waitFor(() => expect(chromeMock.tabs.query).toHaveBeenCalled());
    expect(sendMessage).not.toHaveBeenCalledWith(message);
  });

  it("[SW-001] rejects every calendar command from a content-script sender before identity or fetch", async () => {
    const token = "calendar-worker-token";
    const liveFetch = vi.fn(async () => {
      throw new Error("live Google fetch must not run for content scripts");
    });
    vi.stubGlobal("fetch", liveFetch);

    const commandTypes = [
      MESSAGE_TYPES.calendarConnect,
      MESSAGE_TYPES.calendarRefresh,
      MESSAGE_TYPES.calendarReauthenticate,
      MESSAGE_TYPES.calendarDisconnect,
    ] as const;
    for (const type of commandTypes) {
      const response = vi.fn();
      onMessage.dispatch({ type }, { tab: { id: 77 } }, response);
      await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));
      expect(response).toHaveBeenCalledWith(
        expect.objectContaining({ status: "unavailable" }),
      );
      expect(JSON.stringify(response.mock.calls)).not.toContain(token);
    }

    expect(getAuthToken).not.toHaveBeenCalled();
    expect(removeCachedAuthToken).not.toHaveBeenCalled();
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it("[SW-002] rejects every Drive command from a content-script sender", async () => {
    const internalFileId = "drive-internal-file-01";
    const commandMessages = [
      { type: MESSAGE_TYPES.driveSelect },
      { type: MESSAGE_TYPES.driveRead, selection_id: "sel_worker_01" },
      { type: MESSAGE_TYPES.driveDeselect, selection_id: "sel_worker_01" },
      { type: MESSAGE_TYPES.driveRefresh },
    ] as const;

    for (const message of commandMessages) {
      const response = vi.fn();
      onMessage.dispatch(message, { tab: { id: 77 } }, response);
      await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));
      expect(response).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "unavailable",
          selections: [],
        }),
      );
      expect(JSON.stringify(response.mock.calls)).not.toContain(internalFileId);
    }
  });

  it("allows a trusted full-page extension tab to use connector commands", async () => {
    getAuthToken.mockRejectedValueOnce(new Error("no cached token"));
    const response = vi.fn();
    onMessage.dispatch(
      { type: MESSAGE_TYPES.calendarRefresh },
      {
        id: "orbit-extension-id",
        tab: { id: 91 },
        url: "chrome-extension://orbit-extension-id/workspace.html",
      },
      response,
    );

    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));
    expect(response).toHaveBeenCalledWith(
      expect.objectContaining({ status: "reauth_required" }),
    );
  });

  it("opens, reuses, and releases one workspace for the active ScombZ tab", async () => {
    queryTabs.mockResolvedValue([
      {
        id: 11,
        windowId: 4,
        url: "https://scombz.shibaura-it.ac.jp/portal/home",
      },
    ] as chrome.tabs.Tab[]);
    tabSendMessage.mockResolvedValue({
      title: "Home",
      url: "https://scombz.shibaura-it.ac.jp/portal/home",
      kind: "scombz",
    });
    const response = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.openWorkspace,
        stable_state: {
          status: "idle",
          proposal: null,
          completionEvent: null,
          changeNote: "",
          error: null,
        },
      },
      { id: "orbit-extension-id" },
      response,
    );

    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));
    expect(response.mock.calls[0]?.[0]).toMatchObject({
      ok: true,
      session: {
        sourceTabId: 11,
        sourceWindowId: 4,
        workspaceTabId: 91,
        sourceAvailable: true,
      },
    });
    expect(createTab).toHaveBeenCalledWith(
      expect.objectContaining({
        openerTabId: 11,
        windowId: 4,
        active: false,
      }),
    );
    expect(updateTab).toHaveBeenCalledWith(
      91,
      expect.objectContaining({
        active: true,
        url: expect.stringContaining("workspace.html?session="),
      }),
    );
    const serialized = JSON.stringify(storageValues);
    expect(serialized).not.toContain("pendingRunId");
    expect(serialized).not.toContain("oauth");

    const secondResponse = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.openWorkspace,
        stable_state: {
          status: "idle",
          proposal: null,
          completionEvent: null,
          changeNote: "",
          error: null,
        },
      },
      { id: "orbit-extension-id" },
      secondResponse,
    );
    await vi.waitFor(() => expect(secondResponse).toHaveBeenCalledTimes(1));
    expect(createTab).toHaveBeenCalledTimes(1);
    expect(updateTab).toHaveBeenLastCalledWith(91, { active: true });

    onUpdated.dispatch(
      11,
      { url: "https://example.com/left-scombz" },
      { url: "https://example.com/left-scombz" },
    );
    await vi.waitFor(() =>
      expect(JSON.stringify(storageValues)).toContain(
        '"sourceAvailable":false',
      ),
    );

    const reconnectResponse = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.openWorkspace,
        stable_state: {
          status: "idle",
          proposal: null,
          completionEvent: null,
          changeNote: "",
          error: null,
        },
      },
      { id: "orbit-extension-id" },
      reconnectResponse,
    );
    await vi.waitFor(() => expect(reconnectResponse).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(storageValues)).toContain('"sourceAvailable":true');
    expect(createTab).toHaveBeenCalledTimes(1);

    onRemoved.dispatch(91);
    await vi.waitFor(() =>
      expect(JSON.stringify(storageValues)).toContain('"workspaceTabId":null'),
    );
  });

  it("rejects workspace creation from a ScombZ content script", async () => {
    const response = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.openWorkspace,
        stable_state: {
          status: "idle",
          proposal: null,
          completionEvent: null,
          changeNote: "",
          error: null,
        },
      },
      {
        id: "orbit-extension-id",
        tab: { id: 11 },
        url: "https://scombz.shibaura-it.ac.jp/portal/home",
      },
      response,
    );

    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));
    expect(response).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false }),
    );
    expect(createTab).not.toHaveBeenCalled();
  });
});
