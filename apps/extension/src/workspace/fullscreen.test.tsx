import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceSession } from "../shared/workspace-session";
import { App } from "../sidepanel/App";
import {
  buttonByName,
  click,
  type MountedSidePanel,
  mountSidePanel,
  unmountSidePanel,
  waitFor,
} from "../sidepanel/ui-test-helpers";

const workspaceSession: WorkspaceSession = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  sourceTabId: 11,
  sourceWindowId: 4,
  workspaceTabId: 91,
  pageContext: {
    title: "ScombZ Home",
    url: "https://scombz.shibaura-it.ac.jp/portal/home",
    kind: "scombz",
  },
  stableState: {
    status: "idle",
    proposal: null,
    completionEvent: null,
    changeNote: "",
    error: null,
  },
  sourceAvailable: true,
  updatedAt: "2026-08-19T03:00:00.000Z",
};

describe("full-page workspace", () => {
  let mounted: MountedSidePanel | undefined;

  afterEach(async () => {
    if (mounted) {
      await unmountSidePanel(mounted.root);
      mounted = undefined;
    }
  });

  it("renders the bound ScombZ context, Chat composer, and session-only API settings", async () => {
    mounted = await mountSidePanel(() => (
      <App mode="workspace" workspaceSession={workspaceSession} />
    ));

    expect(
      mounted.document.querySelector('[data-display-mode="workspace"]'),
    ).not.toBeNull();
    expect(mounted.document.body.textContent).toContain("ScombZ Home");
    expect(mounted.document.body.textContent).toContain(
      "今日は何を進めますか？",
    );
    expect(
      mounted.document.querySelector(
        'textarea[placeholder="SIT ORBITに相談する"]',
      ),
    ).not.toBeNull();
    expect(
      mounted.document
        .querySelector(".settings-backdrop")
        ?.hasAttribute("hidden"),
    ).toBe(true);
    const settingsButton = mounted.document.querySelector(
      'button[aria-label="設定"]',
    );
    if (!(settingsButton instanceof HTMLElement)) {
      throw new Error("Settings button was not rendered.");
    }
    await click(settingsButton);
    expect(
      mounted.document
        .querySelector(".settings-backdrop")
        ?.hasAttribute("hidden"),
    ).toBe(false);
    expect(mounted.document.body.textContent).not.toContain("Access token");
    expect(
      mounted.document.querySelector('[aria-label="全画面で開く"]'),
    ).toBeNull();

    await waitFor(
      () =>
        mounted?.chromeRuntime.sendMessage.mock.calls.some(
          ([message]) =>
            (message as { type?: string }).type === "update-workspace-session",
        ) ?? false,
    );
    const update = mounted.chromeRuntime.sendMessage.mock.calls.find(
      ([message]) =>
        (message as { type?: string }).type === "update-workspace-session",
    )?.[0] as Record<string, unknown>;
    expect(JSON.stringify(update)).not.toContain("pendingRunId");
    expect(JSON.stringify(update)).not.toContain("oauth");
  });

  it("shows an accessible full-page control only in the Side Panel", async () => {
    mounted = await mountSidePanel(() => <App />);

    const control = mounted.document.querySelector(
      '[aria-label="全画面で開く"]',
    );
    expect(control).not.toBeNull();
    expect(control?.getAttribute("title")).toBe("全画面で開く");
  });

  it("makes the Side Panel read-only while its workspace owns the session", async () => {
    mounted = await mountSidePanel(
      () => <App />,
      (runtime) => {
        runtime.sendMessage.mockImplementation(
          (message: unknown, callback?: (response: unknown) => void) => {
            const type = (message as { type?: string }).type;
            if (type === "get-page-context") {
              callback?.(workspaceSession.pageContext);
            } else if (type === "get-workspace-status") {
              callback?.({
                active: true,
                session: workspaceSession,
                sourceTabId: workspaceSession.sourceTabId,
              });
            } else {
              callback?.(null);
            }
          },
        );
      },
    );

    await waitFor(
      () =>
        mounted?.document.body.textContent?.includes(
          "全画面ワークスペースで操作中です",
        ) ?? false,
    );
    expect(buttonByName(mounted.document, "B1 大宮の提案を作成").disabled).toBe(
      true,
    );
  });
});
