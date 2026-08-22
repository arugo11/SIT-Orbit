import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentApiClient, ChatRunResponse } from "../api/client";
import {
  buttonByName,
  click,
  type MountedSidePanel,
  mountSidePanel,
  unmountSidePanel,
  waitFor,
} from "../sidepanel/ui-test-helpers";
import { ChatPanel } from "./ChatPanel";
import { deleteAllConversations } from "./chat-history";

const LIBRARY_DISCLOSURE =
  "検索語をこのサイトへ送信し、表示された結果のみを読み取ります。予約等の変更はしません。";

function toolRequired(
  name: string,
  argumentsValue: Record<string, unknown>,
  options: {
    runId?: string;
    toolCallId?: string;
  } = {},
): ChatRunResponse {
  const runId = options.runId ?? "chat-permission-run";
  return {
    status: "tool_required",
    run_id: runId,
    calls: [
      {
        tool_call_id: options.toolCallId ?? `chat-permission-${name}`,
        name,
        version: 1,
        arguments: argumentsValue,
      },
    ],
  } as ChatRunResponse;
}

function createApiClient(
  response: ChatRunResponse,
  completionId = "unexpected-completion",
): AgentApiClient & {
  startChat: ReturnType<typeof vi.fn>;
  submitChatToolResult: ReturnType<typeof vi.fn>;
} {
  return {
    startChat: vi.fn(async () => response),
    submitChatToolResult: vi.fn(async () => ({
      status: "completed",
      message: {
        message_id: completionId,
        content_markdown: "unexpected",
        evidence: [],
      },
      proposal: null,
    })),
  } as unknown as AgentApiClient & {
    startChat: ReturnType<typeof vi.fn>;
    submitChatToolResult: ReturnType<typeof vi.fn>;
  };
}

type TestChromePermissions = {
  contains: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

function installKnownLibraryRuntime(
  mounted: MountedSidePanel,
  query: string,
): TestChromePermissions {
  const permissions: TestChromePermissions = {
    contains: vi.fn(async () => true),
    request: vi.fn(async () => true),
    remove: vi.fn(async () => true),
  };
  Object.assign(chrome, { permissions });
  mounted.chromeRuntime.sendMessage.mockImplementation(
    (_message: unknown, callback?: (response: unknown) => void) => {
      callback?.({
        status: "known",
        projection: {
          schema_version: "v1",
          status: "known",
          query,
          items: [],
          reason_code: null,
        },
      });
    },
  );
  return permissions;
}

async function sendMessage(
  mounted: MountedSidePanel,
  message: string,
): Promise<void> {
  const textarea = mounted.document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Chatメッセージ"]',
  );
  if (!textarea) throw new Error("Chat textarea is missing.");
  const valueSetter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(textarea),
    "value",
  )?.set;
  await act(async () => {
    if (valueSetter) valueSetter.call(textarea, message);
    else textarea.value = message;
    textarea.dispatchEvent(
      new window.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: message,
      }),
    );
    textarea.dispatchEvent(new window.Event("change", { bubbles: true }));
    const propsKey = Object.keys(textarea).find((key) =>
      key.startsWith("__reactProps$"),
    );
    const props = propsKey
      ? (textarea as unknown as Record<string, unknown>)[propsKey]
      : null;
    const onChange =
      props && typeof props === "object"
        ? (props as { onChange?: unknown }).onChange
        : undefined;
    if (typeof onChange !== "function") {
      throw new Error("React textarea onChange handler is missing.");
    }
    onChange({ target: { value: message } });
  });
  await waitFor(() => !buttonByName(mounted.document, "送信").disabled);
  const form = mounted.document.querySelector("form.chat-composer");
  if (!form) throw new Error("Chat composer form is missing.");
  await act(async () => {
    form.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await waitFor(
    () => mounted.document.querySelector(".chat-permission-prompt") !== null,
  );
}

describe("ChatPanel library permission disclosure", () => {
  let mounted: MountedSidePanel | undefined;

  beforeEach(async () => {
    await deleteAllConversations();
  });

  afterEach(async () => {
    if (mounted) {
      await unmountSidePanel(mounted.root);
      mounted = undefined;
    }
    await deleteAllConversations();
  });

  it.each([
    [
      "library_catalog_search",
      "図書館で本を検索して",
      "https://library.shibaura-it.ac.jp",
    ],
    [
      "library_discovery_search",
      "電子ジャーナルを検索して",
      "https://slib.shibaura-it.ac.jp",
    ],
  ] as const)(
    "discloses official-site search and read-only behavior for %s",
    async (toolName, message, origin) => {
      const apiClient = createApiClient(
        toolRequired(toolName, { query: message, limit: 10 }),
      );
      mounted = await mountSidePanel(
        () => (
          <ChatPanel
            apiClient={apiClient}
            pageContext={null}
            calendarState={{ status: "not_connected" }}
            calendarRequest={async () => ({ status: "not_connected" })}
          />
        ),
        (runtime) => {
          runtime.sendMessage.mockImplementation(
            (_request: unknown, callback?: (response: unknown) => void) => {
              callback?.({
                status: "permission_required",
                origin,
                pattern: `${origin}/*`,
              });
            },
          );
        },
      );

      await sendMessage(mounted, message);
      const prompt = mounted.document.querySelector(".chat-permission-prompt");
      expect(prompt?.textContent).toContain(origin);
      expect(prompt?.textContent).toContain(LIBRARY_DISCLOSURE);
      expect(prompt?.textContent).not.toContain(
        "ページの表示情報だけを使い、送信・変更は行いません。",
      );
      expect(
        Array.from(mounted.document.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === "このサイトを常に許可",
        ),
      ).toBeUndefined();

      await click(buttonByName(mounted.document, "拒否"));
      expect(apiClient.submitChatToolResult).not.toHaveBeenCalled();
      expect(mounted.document.body.textContent).toContain(
        "サイトの読み取りを拒否しました。",
      );
    },
  );

  it.each([
    ["catalog/ask", "library_catalog_search", "図書館で本を検索して", false],
    [
      "discovery/ask",
      "library_discovery_search",
      "電子ジャーナルを検索して",
      false,
    ],
    ["catalog/full", "library_catalog_search", "図書館で本を検索して", true],
    [
      "discovery/full",
      "library_discovery_search",
      "電子ジャーナルを検索して",
      true,
    ],
  ] as const)(
    "requires run-scoped library approval before runtime known result (%s)",
    async (caseName, toolName, message, fullAccess) => {
      const runId = `known-${caseName}`;
      const toolCallId = `${runId}-call`;
      const apiClient = createApiClient(
        toolRequired(
          toolName,
          { query: message, limit: 10 },
          { runId, toolCallId },
        ),
        `${runId}-completed`,
      );
      const panel = await mountSidePanel(() => (
        <ChatPanel
          apiClient={apiClient}
          pageContext={null}
          calendarState={{ status: "not_connected" }}
          calendarRequest={async () => ({ status: "not_connected" })}
        />
      ));
      mounted = panel;
      const permissions = installKnownLibraryRuntime(panel, message);

      if (fullAccess) {
        await click(buttonByName(panel.document, "Full access"));
        await waitFor(
          () =>
            buttonByName(panel.document, "Full access").getAttribute(
              "aria-pressed",
            ) === "true",
        );
      }
      expect(panel.chromeRuntime.sendMessage).not.toHaveBeenCalled();

      await sendMessage(panel, message);
      const prompt = panel.document.querySelector(".chat-permission-prompt");
      expect(prompt?.textContent).toContain(LIBRARY_DISCLOSURE);
      expect(panel.chromeRuntime.sendMessage).not.toHaveBeenCalled();

      await click(buttonByName(panel.document, "今回だけ許可"));
      await waitFor(
        () => panel.chromeRuntime.sendMessage.mock.calls.length === 1,
      );
      expect(panel.chromeRuntime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: toolName.replaceAll("_", "-"),
          tool_call_id: toolCallId,
        }),
        expect.any(Function),
      );
      expect(permissions.request).toHaveBeenLastCalledWith({
        origins: [
          toolName === "library_catalog_search"
            ? "https://library.shibaura-it.ac.jp/*"
            : "https://slib.shibaura-it.ac.jp/*",
        ],
      });
      await waitFor(
        () => apiClient.submitChatToolResult.mock.calls.length === 1,
      );
    },
  );

  it("keeps the generic read-only disclosure for browser_read_url", async () => {
    const apiClient = createApiClient(
      toolRequired("browser_read_url", {
        url: "https://example.com/course",
      }),
    );
    mounted = await mountSidePanel(() => (
      <ChatPanel
        apiClient={apiClient}
        pageContext={null}
        calendarState={{ status: "not_connected" }}
        calendarRequest={async () => ({ status: "not_connected" })}
      />
    ));

    await sendMessage(mounted, "https://example.com/course を読んで");
    const prompt = mounted.document.querySelector(".chat-permission-prompt");
    expect(prompt?.textContent).toContain(
      "ページの表示情報だけを使い、送信・変更は行いません。",
    );
    expect(prompt?.textContent).not.toContain("検索語をこのサイトへ送信し");
    expect(prompt?.textContent).not.toContain("予約等の変更はしません。");

    await click(buttonByName(mounted.document, "拒否"));
    expect(apiClient.submitChatToolResult).not.toHaveBeenCalled();
  });
});
