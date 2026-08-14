import { afterAll, describe, expect, it, vi } from "vitest";

const initialUrl = "https://scombz.shibaura-it.ac.jp/portal/home";
const nextUrl = "https://scombz.shibaura-it.ac.jp/course/calculus/assignments";
const pendingTimers: Array<() => void> = [];
const windowListeners = new Map<string, () => void>();
const navigationListeners = new Map<string, () => void>();
const sendMessage = vi.fn(() => Promise.resolve());

const windowMock = {
  location: { href: initialUrl },
  setTimeout: vi.fn((callback: () => void, _delay: number) => {
    pendingTimers.push(callback);
    return 1;
  }),
  addEventListener: vi.fn((type: string, callback: () => void) => {
    windowListeners.set(type, callback);
  }),
  navigation: {
    addEventListener: vi.fn((type: string, callback: () => void) => {
      navigationListeners.set(type, callback);
    }),
  },
} as unknown as Window;

const documentMock = {
  title: "ScombZ",
} as unknown as Document;

const chromeMock = {
  runtime: {
    onMessage: {
      addListener: vi.fn((_listener: unknown) => undefined),
    },
    sendMessage,
  },
} as unknown as typeof chrome;

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: windowMock,
});
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: documentMock,
});
Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: chromeMock,
});

await import("./content-script");

sendMessage.mockClear();

afterAll(() => {
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("content script navigation contract", () => {
  it("reports the new minimal context after a Navigation API route change", () => {
    const navigate = navigationListeners.get("navigate");

    expect(navigate).toBeDefined();
    navigate?.();
    expect(windowMock.setTimeout).toHaveBeenCalledWith(expect.any(Function), 0);
    expect(sendMessage).not.toHaveBeenCalled();

    windowMock.location.href = nextUrl;
    documentMock.title = "  課題一覧  ";
    pendingTimers.shift()?.();

    expect(sendMessage).toHaveBeenCalledWith({
      type: "page-context-updated",
      context: {
        title: "課題一覧",
        url: nextUrl,
        kind: "scombz",
      },
    });
  });
});
