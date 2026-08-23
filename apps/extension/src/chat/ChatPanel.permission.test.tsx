import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentApiClient, ChatRunResponse } from "../api/client";
import {
  buttonByName,
  type MountedSidePanel,
  mountSidePanel,
  unmountSidePanel,
  waitFor,
} from "../sidepanel/ui-test-helpers";
import { ChatPanel } from "./ChatPanel";
import { deleteAllConversations } from "./chat-history";

function toolRequired(
  name: string,
  argumentsValue: Record<string, unknown>,
): ChatRunResponse {
  return {
    status: "tool_required",
    run_id: "chat-read-only-run",
    calls: [
      {
        tool_call_id: `chat-read-only-${name}`,
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
        message_id: "read-only-completed",
        content_markdown: "確認しました。",
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
}

function installReadOnlyRuntime(
  mounted: MountedSidePanel,
  kind: "library" | "browser",
  libraryItems: Array<Record<string, unknown>> = [],
): ReturnType<typeof vi.fn> {
  const permissionsRequest = vi.fn(async () => true);
  Object.assign(chrome, {
    permissions: { request: permissionsRequest },
  });
  mounted.chromeRuntime.sendMessage.mockImplementation(
    (request: unknown, callback?: (response: unknown) => void) => {
      if (
        kind === "library" &&
        typeof request === "object" &&
        request !== null &&
        (request as { type?: string }).type === "library-catalog-search"
      ) {
        callback?.({
          status: "known",
          projection: {
            schema_version: "v1",
            status: "known",
            query: "図書館で本を検索して",
            items: libraryItems,
            reason_code: null,
          },
        });
        return;
      }
      if (kind === "browser") {
        callback?.({
          status: "known",
          projection: {
            schema_version: "v1",
            status: "known",
            url: "https://example.com/course",
            title: "公開ページ",
            text: "公開された本文",
            links: [],
            truncated: false,
            data_classification: "public",
            reason_code: null,
          },
        });
        return;
      }
      callback?.({ ok: true });
    },
  );
  return permissionsRequest;
}

describe("ChatPanel read-only execution boundary", () => {
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

  it("runs library search without an in-chat permission card", async () => {
    const apiClient = createApiClient(
      toolRequired("library_catalog_search", { query: "図書館で本を検索して" }),
    );
    mounted = await mountSidePanel(() => (
      <ChatPanel
        apiClient={apiClient}
        pageContext={null}
        calendarState={{ status: "not_connected" }}
        calendarRequest={async () => ({ status: "not_connected" })}
      />
    ));
    const permissionsRequest = installReadOnlyRuntime(mounted, "library");

    await sendMessage(mounted, "図書館で本を検索して");
    await waitFor(() => apiClient.submitChatToolResult.mock.calls.length === 1);

    expect(
      mounted.document.querySelector(".chat-permission-prompt"),
    ).toBeNull();
    expect(permissionsRequest).not.toHaveBeenCalled();
  });

  it("renders public OPAC holding location and loan status in the tool timeline", async () => {
    const apiClient = createApiClient(
      toolRequired("library_catalog_search", { query: "ロボット" }),
    );
    mounted = await mountSidePanel(() => (
      <ChatPanel
        apiClient={apiClient}
        pageContext={null}
        calendarState={{ status: "not_connected" }}
        calendarRequest={async () => ({ status: "not_connected" })}
      />
    ));
    installReadOnlyRuntime(mounted, "library", [
      {
        resource_ref: "orbit-library://record/0123456789abcdef",
        title: "ロボットテクノロジー",
        authors: ["日本ロボット学会編"],
        subjects: ["ロボット"],
        isbn: null,
        publisher: "公開出版社",
        publication_year: 2024,
        format: "book",
        campus: "any",
        url: "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/BB06629896",
        holdings: [
          {
            campus: "toyosu",
            location: "豊洲図書館 豊洲図書館",
            call_number: "548.3/N77",
            status: "available",
            due_date: null,
            reservation_count: 0,
          },
        ],
        related_records: [],
      },
    ]);

    await sendMessage(mounted, "図書館でロボットの本を探して");
    await waitFor(() => apiClient.submitChatToolResult.mock.calls.length === 1);

    expect(mounted.document.body.textContent).toContain("ロボットテクノロジー");
    expect(mounted.document.body.textContent).toContain(
      "豊洲図書館 豊洲図書館",
    );
    expect(mounted.document.body.textContent).toContain("配架場所:");
    expect(mounted.document.body.textContent).toContain("548.3/N77");
    expect(mounted.document.body.textContent).toContain("貸出可");

    const mapImage = mounted.document.querySelector<HTMLImageElement>(
      'img[alt="豊洲図書館フロアマップ"]',
    );
    expect(mapImage?.getAttribute("src")).toBe(
      "https://lib.shibaura-it.ac.jp/files/images/toyosu_room_map_2607.png",
    );
    expect(mapImage).not.toBeNull();
    expect(mapImage?.closest("a")?.getAttribute("aria-label")).toBe(
      "豊洲図書館フロアマップの画像を原寸で開く",
    );
  });

  it("sends an ordinary greeting directly to the Agent without permission checks", async () => {
    const apiClient = createApiClient({
      status: "completed",
      message: {
        message_id: "greeting-completed",
        content_markdown: "こんにちは。今日は何を進めますか？",
        evidence: [],
      },
      proposal: null,
    });
    mounted = await mountSidePanel(() => (
      <ChatPanel
        apiClient={apiClient}
        pageContext={null}
        calendarState={{ status: "not_connected" }}
        calendarRequest={async () => ({ status: "not_connected" })}
      />
    ));
    const permissionsRequest = vi.fn(async () => true);
    Object.assign(chrome, { permissions: { request: permissionsRequest } });

    await sendMessage(mounted, "こんにちは");
    await waitFor(() =>
      (mounted?.document.body.textContent ?? "").includes(
        "こんにちは。今日は何を進めますか？",
      ),
    );

    expect(apiClient.startChat).toHaveBeenCalledWith(
      expect.objectContaining({ message: "こんにちは" }),
    );
    expect(permissionsRequest).not.toHaveBeenCalled();
  });

  it("reads a public URL without an in-chat permission card", async () => {
    const apiClient = createApiClient(
      toolRequired("browser_read_url", { url: "https://example.com/course" }),
    );
    mounted = await mountSidePanel(() => (
      <ChatPanel
        apiClient={apiClient}
        pageContext={null}
        calendarState={{ status: "not_connected" }}
        calendarRequest={async () => ({ status: "not_connected" })}
      />
    ));
    const permissionsRequest = installReadOnlyRuntime(mounted, "browser");

    await sendMessage(mounted, "https://example.com/course を読んで");
    await waitFor(() => apiClient.submitChatToolResult.mock.calls.length === 1);

    expect(
      mounted.document.querySelector(".chat-permission-prompt"),
    ).toBeNull();
    expect(permissionsRequest).not.toHaveBeenCalled();
  });

  it("shows one generic retryable assistant error without network details", async () => {
    const apiClient = createApiClient({
      status: "completed",
      message: {
        message_id: "unused",
        content_markdown: "unused",
        evidence: [],
      },
      proposal: null,
    });
    apiClient.startChat.mockRejectedValue(new Error("Failed to fetch"));
    mounted = await mountSidePanel(() => (
      <ChatPanel
        apiClient={apiClient}
        pageContext={null}
        calendarState={{ status: "not_connected" }}
        calendarRequest={async () => ({ status: "not_connected" })}
      />
    ));

    await sendMessage(mounted, "こんにちは");
    await waitFor(
      () => mounted?.document.querySelector(".chat-retry-button") !== null,
    );

    expect(mounted.document.body.textContent).toContain(
      "今は応答できませんでした。もう一度お試しください。",
    );
    expect(mounted.document.body.textContent).not.toContain("Failed to fetch");
    expect(mounted.document.body.textContent).not.toContain("接続状態");
    expect(mounted.document.body.textContent).not.toContain("許可を確認");
  });

  it("shows a concise Agent progress status while the request is pending", async () => {
    let resolveStart: ((value: ChatRunResponse) => void) | undefined;
    const apiClient = createApiClient({
      status: "completed",
      message: {
        message_id: "progress-completed",
        content_markdown: "完了",
        evidence: [],
      },
      proposal: null,
    });
    apiClient.startChat.mockImplementation(
      () =>
        new Promise<ChatRunResponse>((resolve) => {
          resolveStart = resolve;
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

    await sendMessage(mounted, "予定を確認して");
    await waitFor(() =>
      (
        mounted?.document.querySelector(".chat-progress")?.textContent ?? ""
      ).includes("Agentに質問を送信中"),
    );
    expect(
      mounted.document.querySelector(".chat-progress")?.textContent,
    ).not.toContain("思考");

    resolveStart?.({
      status: "completed",
      message: {
        message_id: "progress-completed",
        content_markdown: "完了",
        evidence: [],
      },
      proposal: null,
    });
    await waitFor(() =>
      (
        mounted?.document.querySelector(".chat-progress")?.textContent ?? ""
      ).includes("完了"),
    );
  });
});
