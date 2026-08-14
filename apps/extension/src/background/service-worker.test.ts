import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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
const onMessage = createEvent();
const setOptions = vi.fn(async (_options: unknown) => undefined);
const setPanelBehavior = vi.fn(async (_options: unknown) => undefined);

const chromeMock = {
  runtime: {
    onInstalled,
    onStartup,
    onMessage,
    sendMessage: vi.fn(async (_message: unknown) => undefined),
  },
  sidePanel: {
    setOptions,
    setPanelBehavior,
  },
  tabs: {
    onUpdated,
    onActivated,
    get: vi.fn(async (_tabId: number) => ({
      url: "https://scombz.shibaura-it.ac.jp/portal/home",
    })),
    query: vi.fn(async () => []),
    sendMessage: vi.fn(async (_tabId: number, _message: unknown) => undefined),
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

describe("service worker side panel contract", () => {
  beforeEach(() => {
    setOptions.mockClear();
    setPanelBehavior.mockClear();
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

    await vi.waitFor(() => expect(setOptions).toHaveBeenCalledTimes(2));

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
    expect(setPanelBehavior).not.toHaveBeenCalled();
  });
});
