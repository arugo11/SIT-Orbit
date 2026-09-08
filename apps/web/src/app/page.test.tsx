import {
  type ActionProposal,
  B1_OMIYA_CONTEXT,
  B1_OMIYA_EVENT,
} from "@sit-orbit/api-client";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import Home from "./page";

function jsonResponse(value: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  } as Response;
}

const proposal: ActionProposal = {
  action_id: "act-web-test",
  title: "次の授業までに合成関数の微分を2問確認する",
  reason: "明日の課題と直近の誤答を確認できるためです。",
  duration_minutes: 12,
  evidence: B1_OMIYA_CONTEXT,
  external_action: "checklist_update",
  requires_confirmation: true,
  prompt_version: "fixture-b1-omiya-v1",
  operation: null,
};

const completion = {
  event_id: "evt-web-completed",
  event_type: "action_completed",
  scenario_id: B1_OMIYA_EVENT.scenario_id,
  occurred_at: "2026-09-08T01:00:00Z",
  campus: "omiya",
  data_classification: "synthetic",
  payload: {
    action_id: proposal.action_id,
    approved: true,
    completed: true,
    notes: "合成fixtureを完了",
  },
} as const;

function fetcherFor(...responses: Response[]) {
  let index = 0;
  return vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>(
    async (..._args) => responses[index++] ?? jsonResponse({}, 500),
  );
}

let mountedRoot: Root | null = null;
let mountedContainer: HTMLElement | null = null;

function installDom(): Window {
  const { window } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  for (const key of [
    "window",
    "document",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLInputElement",
    "Event",
    "MouseEvent",
    "Text",
  ]) {
    vi.stubGlobal(key, (window as unknown as Record<string, unknown>)[key]);
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mountedContainer = window.document.getElementById("root");
  if (!mountedContainer) throw new Error("test root was not created");
  mountedRoot = createRoot(mountedContainer);
  return window as unknown as Window;
}

async function renderHome(): Promise<{
  window: Window;
  container: HTMLElement;
}> {
  const window = installDom();
  if (!mountedRoot || !mountedContainer)
    throw new Error("test root was not created");
  await act(async () => {
    mountedRoot?.render(<Home />);
  });
  return { window, container: mountedContainer };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(container: HTMLElement, label: string): Promise<void> {
  const button = Array.from(container.querySelectorAll("button")).find((item) =>
    item.textContent?.includes(label),
  );
  if (!button) throw new Error(`button not found: ${label}`);
  await act(async () => {
    button.dispatchEvent(
      new Event("click", { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
  }
  mountedRoot = null;
  mountedContainer = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("foundation web loop", () => {
  it("requests a proposal, requires approval, and records the returned completion event", async () => {
    const fetcher = fetcherFor(
      jsonResponse({
        agent_backend: "fixture",
        my_library_personal_context: false,
      }),
      jsonResponse(proposal),
      jsonResponse(completion),
    );
    vi.stubGlobal("fetch", fetcher);
    const { container } = await renderHome();

    expect(container.textContent).toContain("提案を取得する");
    await click(container, "提案を取得する");
    expect(container.textContent).toContain(proposal.reason);
    expect(container.textContent).toContain("微分積分学の課題は明日締切");
    expect(fetcher).toHaveBeenCalledTimes(2);

    await click(container, "提案を承認する");
    expect(container.textContent).toContain("承認済み · 所要時間 12分");
    expect(fetcher).toHaveBeenCalledTimes(2);

    await click(container, "完了を確認して記録する");
    expect(container.textContent).toContain("action_completed");
    expect(container.textContent).toContain("evt-web-completed");
    expect(container.textContent).toContain(
      "大学の公式記録ではない合成イベントです。",
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    const verifyInit = fetcher.mock.calls[2]?.[1] as RequestInit;
    expect(JSON.parse(String(verifyInit.body))).toMatchObject({
      approved: true,
      completed: true,
    });
  });

  it("keeps a duration edit local until approval and sends it as completion context", async () => {
    const fetcher = fetcherFor(
      jsonResponse({ agent_backend: "fixture" }),
      jsonResponse(proposal),
      jsonResponse(completion),
    );
    vi.stubGlobal("fetch", fetcher);
    const { container } = await renderHome();
    await click(container, "提案を取得する");

    const input = container.querySelector<HTMLInputElement>("#duration");
    if (!input) throw new Error("duration input was not rendered");
    const valueSetter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      "value",
    )?.set;
    valueSetter?.call(input, "15");
    await act(async () => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    await click(container, "変更して承認する");

    expect(container.textContent).toContain("承認済み · 所要時間 15分");
    expect(fetcher).toHaveBeenCalledTimes(2);
    await click(container, "完了を確認して記録する");
    const verifyInit = fetcher.mock.calls[2]?.[1] as RequestInit;
    expect(JSON.parse(String(verifyInit.body)).notes).toContain("15分");
  });

  it("rejects locally without sending a completion request", async () => {
    const fetcher = fetcherFor(
      jsonResponse({ agent_backend: "fixture" }),
      jsonResponse(proposal),
    );
    vi.stubGlobal("fetch", fetcher);
    const { container } = await renderHome();
    await click(container, "提案を取得する");
    await click(container, "提案を却下する");

    expect(container.textContent).toContain("提案を却下しました");
    expect(container.textContent).toContain("提案を却下しました。");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("blocks an out-of-range duration before approval", async () => {
    const fetcher = fetcherFor(
      jsonResponse({ agent_backend: "fixture" }),
      jsonResponse(proposal),
    );
    vi.stubGlobal("fetch", fetcher);
    const { container } = await renderHome();
    await click(container, "提案を取得する");

    const input = container.querySelector<HTMLInputElement>("#duration");
    if (!input) throw new Error("duration input was not rendered");
    const valueSetter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      "value",
    )?.set;
    valueSetter?.call(input, "0");
    await act(async () => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    await click(container, "変更して承認する");

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "所要時間は1〜18分",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed when capabilities advertise a non-fixture backend", async () => {
    const fetcher = fetcherFor(
      jsonResponse({
        agent_backend: "azure_openai",
        my_library_personal_context: true,
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const { container } = await renderHome();
    await click(container, "提案を取得する");

    expect(container.textContent).toContain("fixtureバックエンドではないため");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "合成デモを開始できません",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
