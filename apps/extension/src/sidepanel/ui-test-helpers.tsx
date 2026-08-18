import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

export interface TestChromeRuntime {
  sendMessage: ReturnType<typeof vi.fn>;
  onMessage: {
    addListener: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };
}

export interface MountedSidePanel {
  document: Document;
  root: Root;
  chromeRuntime: TestChromeRuntime;
}

export type ConfigureTestChromeRuntime = (runtime: TestChromeRuntime) => void;

export function installSidePanelGlobals(): TestChromeRuntime {
  const chromeRuntime: TestChromeRuntime = {
    sendMessage: vi.fn(
      (_message: unknown, callback?: (response: unknown) => void) => {
        callback?.(null);
      },
    ),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  };
  const { document, window } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );

  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("navigator", window.navigator);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("Node", window.Node);
  vi.stubGlobal("Event", window.Event);
  vi.stubGlobal("MouseEvent", window.Event);
  vi.stubGlobal("getComputedStyle", window.getComputedStyle);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("chrome", {
    runtime: {
      ...chromeRuntime,
      lastError: undefined,
    },
  });

  return chromeRuntime;
}

export async function mountSidePanel(
  render: (container: HTMLElement) => ReactNode,
  configureRuntime?: ConfigureTestChromeRuntime,
): Promise<MountedSidePanel> {
  const chromeRuntime = installSidePanelGlobals();
  configureRuntime?.(chromeRuntime);
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("Test root is missing.");
  }

  const root = createRoot(container);
  await act(async () => {
    root.render(render(container));
  });

  return { document, root, chromeRuntime };
}

export async function unmountSidePanel(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  vi.unstubAllGlobals();
}

export function buttonByName(
  document: Document,
  name: string,
): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!(button instanceof HTMLElement)) {
    throw new Error(`Button not found: ${name}`);
  }
  return button as HTMLButtonElement;
}

export async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the UI state.");
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
