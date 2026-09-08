import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentApiClient, ChatRunResponse } from "../api/client";
import { AgentApiError } from "../api/client";
import {
  buttonByName,
  type MountedSidePanel,
  mountSidePanel,
  unmountSidePanel,
  waitFor,
} from "../sidepanel/ui-test-helpers";
import { ChatPanel } from "./ChatPanel";
import { deleteAllConversations, listConversations } from "./chat-history";

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
      if (
        typeof request === "object" &&
        request !== null &&
        (request as { type?: string }).type === "chat-auth-preflight"
      ) {
        callback?.({
          schema_version: "v1",
          ready_tools: kind === "browser" ? [] : [],
          unknown_tools: [],
        });
        return;
      }
      if (
        kind === "library" &&
        typeof request === "object" &&
        request !== null &&
        (request as { type?: string }).type === "library-item-read"
      ) {
        callback?.({
          status: "known",
          projection: {
            schema_version: "v1",
            status: "known",
            resource_ref: libraryItems[0]?.resource_ref,
            item: libraryItems[0] ?? null,
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

  it("reads SITRUS without an active grade tab and keeps the result ephemeral", async () => {
    const apiClient = createApiClient(toolRequired("sitrus_read", {}));
    Object.assign(apiClient, {
      chatCapabilities: vi.fn(async () => ({
        schema_version: "v1",
        agent_backend: "azure_openai",
        observability: "off",
        scombz_student_read_mode: "off",
        sitrus_personal_context_mode: "live",
        supported_client_tools: ["sitrus_read"],
        max_client_tools: 32,
      })),
    });
    mounted = await mountSidePanel(() => (
      <ChatPanel
        apiClient={apiClient}
        pageContext={null}
        calendarState={{ status: "not_connected" }}
        calendarRequest={async () => ({ status: "not_connected" })}
      />
    ));
    const sessionValues: Record<string, unknown> = {};
    Object.assign(chrome, {
      storage: {
        session: {
          get: vi.fn(async (key: string | string[] | null) => {
            if (key === null) return { ...sessionValues };
            const keys = Array.isArray(key) ? key : [key];
            return Object.fromEntries(
              keys
                .filter((item) => item in sessionValues)
                .map((item) => [item, sessionValues[item]]),
            );
          }),
          set: vi.fn(async (values: Record<string, unknown>) => {
            Object.assign(sessionValues, values);
          }),
          remove: vi.fn(async (key: string | string[]) => {
            for (const item of Array.isArray(key) ? key : [key]) {
              delete sessionValues[item];
            }
          }),
        },
      },
    });
    mounted.chromeRuntime.sendMessage.mockImplementation(
      (request: unknown, callback?: (response: unknown) => void) => {
        if (
          typeof request === "object" &&
          request !== null &&
          (request as { type?: string }).type === "sitrus-read"
        ) {
          callback?.({
            status: "known",
            projection: {
              schema_version: "v1",
              status: "known",
              report_label: "取得済み科目・単位数",
              grades: [
                {
                  subject: "合成科目",
                  credits: 2,
                  grade: "A",
                  outcome: "合格",
                  year: 2025,
                  term: 2,
                },
              ],
              credit_summaries: [],
              observed_at: "2026-09-02T00:00:00Z",
              reason_code: null,
            },
          });
          return;
        }
        if (
          typeof request === "object" &&
          request !== null &&
          (request as { type?: string }).type === "chat-auth-preflight"
        ) {
          callback?.({
            schema_version: "v1",
            ready_tools: ["sitrus_read"],
            unknown_tools: [],
          });
          return;
        }
        callback?.({ ok: true });
      },
    );

    await sendMessage(mounted, "私の成績を教えて");
    await waitFor(() => apiClient.startChat.mock.calls.length === 1);
    expect(apiClient.startChat).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "私の成績を教えて",
        client_tools: [{ name: "sitrus_read", version: 1 }],
      }),
    );
    await waitFor(
      () => apiClient.submitChatToolResult.mock.calls.length === 1,
      3_000,
    );
    const runtimeRequest = mounted.chromeRuntime.sendMessage.mock.calls.find(
      ([request]) =>
        typeof request === "object" &&
        request !== null &&
        (request as { type?: string }).type === "sitrus-read",
    )?.[0] as Record<string, unknown> | undefined;
    expect(runtimeRequest).toEqual({
      type: "sitrus-read",
      tool_call_id: "chat-read-only-sitrus_read",
    });
    const submitted = apiClient.submitChatToolResult.mock.calls[0]?.[1];
    expect(JSON.stringify(submitted)).not.toMatch(
      /student_number|gakuseki|teacher|classroom|cookie|token/iu,
    );
    await waitFor(() =>
      (mounted?.document.body.textContent ?? "").includes("確認しました。"),
    );
    expect(await listConversations()).toHaveLength(0);
  });

  it("does not require a live SCombZ read for public OPAC from a SCombZ workspace", async () => {
    const apiClient = createApiClient({
      status: "completed",
      message: {
        message_id: "public-opac-from-scombz",
        content_markdown: "3冊をOPACで確認します。",
        evidence: [],
      },
      proposal: null,
    });
    Object.assign(apiClient, {
      chatCapabilities: vi.fn(async () => ({
        agent_backend: "fixture",
        observability: "off",
        scombz_student_read_mode: "off",
        my_library_personal_context: true,
        supported_client_tools: ["library_catalog_search", "library_item_read"],
        max_client_tools: 32,
      })),
    });
    mounted = await mountSidePanel(() => (
      <ChatPanel
        apiClient={apiClient}
        pageContext={{
          title: "SCombZ Home",
          url: "https://scombz.shibaura-it.ac.jp/portal/home",
          kind: "scombz",
        }}
        calendarState={{ status: "not_connected" }}
        calendarRequest={async () => ({ status: "not_connected" })}
      />
    ));

    await sendMessage(mounted, "この3冊の中で図書館で借りれるものはある?");
    await waitFor(() => apiClient.startChat.mock.calls.length === 1);

    expect(
      mounted.chromeRuntime.sendMessage.mock.calls.some(
        ([request]) =>
          typeof request === "object" &&
          request !== null &&
          (request as { type?: string }).type === "scombz-pin",
      ),
    ).toBe(false);
    expect(apiClient.startChat).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "この3冊の中で図書館で借りれるものはある?",
        client_tools: expect.arrayContaining([
          { name: "library_catalog_search", version: 1 },
          { name: "library_item_read", version: 1 },
        ]),
      }),
    );
  });

  it("does not retain failed OPAC progress rows in the transcript", async () => {
    const apiClient = createApiClient(
      toolRequired("library_catalog_search", { query: "対象書籍" }),
    );
    mounted = await mountSidePanel(() => (
      <ChatPanel
        apiClient={apiClient}
        pageContext={null}
        calendarState={{ status: "not_connected" }}
        calendarRequest={async () => ({ status: "not_connected" })}
      />
    ));
    mounted.chromeRuntime.sendMessage.mockImplementation(
      (_request: unknown, callback?: (response: unknown) => void) => {
        callback?.({
          status: "unavailable",
          reason_code: "search_navigation_timeout",
        });
      },
    );

    await sendMessage(mounted, "対象書籍は大学にある？");
    await waitFor(() => apiClient.submitChatToolResult.mock.calls.length === 1);
    await waitFor(() =>
      (mounted?.document.body.textContent ?? "").includes("確認しました。"),
    );

    expect(
      mounted.document.querySelectorAll(".chat-message-tool"),
    ).toHaveLength(0);
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
    expect(mapImage).toBeNull();
  });

  it("renders a floor map only for a single-book detail read", async () => {
    const item = {
      resource_ref: "orbit-library://record/0123456789abcdef",
      title: "ロボットテクノロジー",
      authors: ["日本ロボット学会編"],
      subjects: ["ロボット"],
      isbn: null,
      publisher: "公開出版社",
      publication_year: 2024,
      format: "book",
      campus: "toyosu",
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
    };
    const apiClient = createApiClient(
      toolRequired("library_item_read", {
        resource_ref: item.resource_ref,
        presentation: "location",
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
    installReadOnlyRuntime(mounted, "library", [item]);

    await sendMessage(mounted, "どこに配架されていますか？");
    await waitFor(() => apiClient.submitChatToolResult.mock.calls.length === 1);

    const mapImage = mounted.document.querySelector<HTMLImageElement>(
      'img[alt="豊洲図書館フロアマップ"]',
    );
    expect(mapImage?.getAttribute("src")).toBe(
      "https://lib.shibaura-it.ac.jp/files/images/toyosu_room_map_2607.png",
    );
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
    const request = apiClient.startChat.mock.calls[0]?.[0] as {
      client_tools?: Array<{ name: string }>;
      execution_mode?: string;
    };
    expect(request.execution_mode).toBeUndefined();
    expect(request.client_tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "library_catalog_search",
        "library_item_read",
        "library_catalog_browse",
        "library_discovery_search",
      ]),
    );
    expect(permissionsRequest).not.toHaveBeenCalled();
  });

  it("does not advertise campus tools when capabilities cannot be verified", async () => {
    const apiClient = createApiClient({
      status: "completed",
      message: {
        message_id: "must-not-send",
        content_markdown: "unexpected",
        evidence: [],
      },
      proposal: null,
    });
    Object.assign(apiClient, {
      chatCapabilities: vi.fn(async () => {
        throw new Error("capability unavailable");
      }),
    });
    mounted = await mountSidePanel(() => (
      <ChatPanel
        apiClient={apiClient}
        pageContext={null}
        calendarState={{ status: "not_connected" }}
        calendarRequest={async () => ({ status: "not_connected" })}
      />
    ));

    await sendMessage(mounted, "SCombZの履修情報 PRIVATE_MARKER を確認して");
    await waitFor(() => apiClient.startChat.mock.calls.length === 1);
    expect(apiClient.startChat).toHaveBeenCalledWith(
      expect.objectContaining({ client_tools: [] }),
    );
  });

  it("deduplicates evidence mirrored by message and context manifest before the next turn", async () => {
    const mirroredEvidence = {
      evidence_id: "web-search-v1-mirrored",
      title: "公開書誌",
      source_type: "web" as const,
      locator: "https://books.example/llm",
      data_classification: "public" as const,
    };
    const apiClient = createApiClient({
      status: "completed",
      message: {
        message_id: "mirrored-completed",
        content_markdown: "最初の回答です。",
        evidence: [mirroredEvidence],
      },
      proposal: null,
      context_manifest: {
        schema_version: "v1",
        evidence: [mirroredEvidence],
        library_records: [],
        related_books: [],
      },
    });
    mounted = await mountSidePanel(() => (
      <ChatPanel
        apiClient={apiClient}
        pageContext={null}
        calendarState={{ status: "not_connected" }}
        calendarRequest={async () => ({ status: "not_connected" })}
      />
    ));

    await sendMessage(mounted, "LLMの本を教えて");
    await waitFor(() =>
      (mounted?.document.body.textContent ?? "").includes("最初の回答です。"),
    );
    apiClient.startChat.mockResolvedValueOnce({
      status: "completed",
      message: {
        message_id: "mirrored-follow-up",
        content_markdown: "続きの回答です。",
        evidence: [],
      },
      proposal: null,
    });

    await sendMessage(mounted, "その本は大学にある？");
    await waitFor(() => apiClient.startChat.mock.calls.length === 2);
    const secondRequest = apiClient.startChat.mock.calls[1]?.[0] as {
      context_manifest?: { evidence?: Array<{ evidence_id: string }> };
    };
    expect(secondRequest.context_manifest?.evidence).toHaveLength(1);
    expect(secondRequest.context_manifest?.evidence?.[0]?.evidence_id).toBe(
      mirroredEvidence.evidence_id,
    );
  });

  it("renders compact related-book cards and reuses them in the next turn", async () => {
    const apiClient = createApiClient({
      status: "completed",
      message: {
        message_id: "related-books-completed",
        content_markdown: "異なる観点から候補を比較しました。",
        evidence: [
          {
            evidence_id: "web-search-v1-books-1",
            title: "公開書誌",
            source_type: "web",
            locator: "https://books.example/robot-learning",
            data_classification: "public",
          },
        ],
        related_books: [
          {
            candidate_ref: "orbit-book://candidate/1234567890abcdef",
            title: "Robot Learning",
            authors: ["Jane Doe"],
            isbn: "9780000000001",
            publication_year: 2024,
            relation_axes: [
              { label: "強化学習", source: "metadata" },
              { label: "身体性", source: "inferred" },
            ],
            why_related: "学習とロボット制御を別の観点から結び付けます。",
            evidence_ids: ["web-search-v1-books-1"],
            catalog_verification: {
              status: "unverified",
              resource_ref: null,
              observed_at: null,
            },
            observed_at: "2026-08-24T00:00:00Z",
          },
        ],
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

    await sendMessage(mounted, "関連する本を探して");
    await waitFor(() =>
      (mounted?.document.body.textContent ?? "").includes("Robot Learning"),
    );

    expect(
      mounted.document.querySelectorAll(".related-book-card"),
    ).toHaveLength(1);
    expect(mounted.document.body.textContent).toContain("SIT所蔵未確認");
    expect(mounted.document.body.textContent).toContain("強化学習");
    expect(mounted.document.querySelector(".related-book-card img")).toBeNull();

    apiClient.startChat.mockResolvedValueOnce({
      status: "completed",
      message: {
        message_id: "related-books-follow-up",
        content_markdown: "SIT所蔵を確認します。",
        evidence: [],
        related_books: [],
      },
      proposal: null,
    });
    await sendMessage(mounted, "その中でSITにある本は？");
    await waitFor(() => apiClient.startChat.mock.calls.length === 2);
    const secondRequest = apiClient.startChat.mock.calls[1]?.[0] as {
      context_manifest?: { related_books?: Array<{ candidate_ref: string }> };
    };
    expect(
      secondRequest.context_manifest?.related_books?.[0]?.candidate_ref,
    ).toBe("orbit-book://candidate/1234567890abcdef");
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

  it("does not describe a read-only 422 as a reservation failure", async () => {
    const apiClient = createApiClient({
      status: "completed",
      message: {
        message_id: "unused-422",
        content_markdown: "unused",
        evidence: [],
      },
      proposal: null,
    });
    apiClient.startChat.mockRejectedValue(
      new AgentApiError("Agent API returned HTTP 422.", 422, {
        detail: "validation failed",
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

    await sendMessage(mounted, "LLMに関するおすすめの本はある？");
    await waitFor(
      () => mounted?.document.querySelector(".chat-retry-button") !== null,
    );

    expect(mounted.document.body.textContent).toContain("接続仕様");
    expect(mounted.document.body.textContent).not.toContain("予約や送信");
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
      ).includes("Agentが回答方針を検討中"),
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
