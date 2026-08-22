import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const LIBRARY_DISCLOSURE =
  "検索語をこのサイトへ送信し、表示された結果のみを読み取ります。予約等の変更はしません。";

function toolRequired(
  name: string,
  argumentsValue: Record<string, unknown>,
): ChatRunResponse {
  return {
    status: "tool_required",
    run_id: "chat-permission-run",
    calls: [
      {
        tool_call_id: `chat-permission-${name}`,
        name,
        version: 1,
        arguments: argumentsValue,
      },
    ],
  } as ChatRunResponse;
}

function createApiClient(response: ChatRunResponse): AgentApiClient & {
  startChat: ReturnType<typeof vi.fn>;
  submitChatToolResult: ReturnType<typeof vi.fn>;
} {
  return {
    startChat: vi.fn(async () => response),
    submitChatToolResult: vi.fn(async () => ({
      status: "completed",
      message: {
        message_id: "unexpected-completion",
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

  afterEach(async () => {
    if (mounted) {
      await unmountSidePanel(mounted.root);
      mounted = undefined;
    }
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
