import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentApiClient, ChatRunResponse } from "../api/client";
import {
  clearMyLibrarySessionConsent,
  MY_LIBRARY_SESSION_CONSENT_KEY,
} from "../content/my-library-consent";
import {
  buttonByName,
  click,
  type MountedSidePanel,
  mountSidePanel,
  unmountSidePanel,
  waitFor,
} from "../sidepanel/ui-test-helpers";
import { ChatPanel } from "./ChatPanel";
import { deleteAllConversations, listConversations } from "./chat-history";

const forbiddenValues = [
  "student-name-secret",
  "student-number-secret",
  "student@example.invalid",
  "sso-token-secret",
  "query-secret",
  "fragment-secret",
  "secret-call-number",
  "material-secret-1",
  "request-secret-1",
  "tracking-secret-id",
  "form-value-secret",
  "purchase-reason-secret",
  "contact-note-secret",
];

function toolRequired(): ChatRunResponse {
  return {
    status: "tool_required",
    run_id: "my-library-ui-run",
    calls: [
      {
        tool_call_id: "my-library-ui-call",
        name: "my_library_read",
        version: 1,
        arguments: {
          scope: "purchase_requests",
          query: null,
          offset: 0,
          limit: 20,
        },
      },
    ],
  } as ChatRunResponse;
}

const projection = {
  schema_version: "v1",
  status: "known",
  scope: "purchase_requests",
  items: [
    {
      resource_ref: "orbit-library://record/0123456789abcdef",
      title: "端末内資料",
      author: "公開著者",
      status: "受付済み",
      due_date: null,
      renewable: null,
      activity_date: "2026-08-01",
      request_type: "図書購入",
    },
  ],
  total_count: 1,
  next_offset: null,
  loan_count: 0,
  reservation_count: 0,
  overdue_count: 0,
  renewable_count: 0,
  earliest_due_date: null,
  reason_code: null,
};

const localDetail = {
  loans: [],
  reservations: [],
  purchase_requests: [
    {
      title: "端末内資料",
      author: "公開著者",
      status: "受付済み",
      due_date: null,
      renewable: null,
      activity_date: "2026-08-01",
      request_type: "図書購入",
      // These values represent page-only fields accidentally returned by a
      // hostile connector. They must not reach the Agent or chat history.
      student_id: "student-number-secret",
      call_number: "secret-call-number",
      material_id: "material-secret-1",
      request_id: "request-secret-1",
      purchase_reason: "purchase-reason-secret",
      contact_note: "contact-note-secret",
    },
  ],
};

function createApiClient(): AgentApiClient & {
  startChat: ReturnType<typeof vi.fn>;
  submitChatToolResult: ReturnType<typeof vi.fn>;
} {
  return {
    startChat: vi.fn(async () => toolRequired()),
    submitChatToolResult: vi.fn(async () => ({
      status: "completed",
      message: {
        message_id: "my-library-ui-completed",
        content_markdown:
          "購入依頼の状況を確認しました。対象: 端末内資料 / 公開著者",
        evidence: [],
      },
      proposal: null,
    })),
  } as unknown as AgentApiClient & {
    startChat: ReturnType<typeof vi.fn>;
    submitChatToolResult: ReturnType<typeof vi.fn>;
  };
}

async function submitMessage(
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
  if (!form) throw new Error("Chat composer is missing.");
  await act(async () => {
    form.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

describe("ChatPanel My Library consent and history boundary", () => {
  let mounted: MountedSidePanel | undefined;
  let sessionValues: Record<string, unknown>;

  beforeEach(async () => {
    await deleteAllConversations();
    sessionValues = {};
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    });
  });

  afterEach(async () => {
    if (mounted) {
      await unmountSidePanel(mounted.root);
      mounted = undefined;
    }
    await clearMyLibrarySessionConsent();
    await deleteAllConversations();
    vi.unstubAllGlobals();
  });

  function installLibraryChrome(
    options: { consented: boolean } = { consented: false },
  ): void {
    if (options.consented) {
      sessionValues[MY_LIBRARY_SESSION_CONSENT_KEY] = true;
    }
    Object.assign(chrome, {
      permissions: {
        contains: vi.fn(async () => true),
        request: vi.fn(async () => true),
        remove: vi.fn(async () => true),
      },
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
  }

  it("does not treat Full access as My Library sharing consent", async () => {
    const apiClient = createApiClient();
    mounted = await mountSidePanel(() => (
      <ChatPanel
        apiClient={apiClient}
        pageContext={null}
        calendarState={{ status: "not_connected" }}
        calendarRequest={async () => ({ status: "not_connected" })}
      />
    ));
    installLibraryChrome();
    const panel = mounted;
    if (!panel) throw new Error("ChatPanel did not mount.");

    await click(buttonByName(panel.document, "Full access"));
    await waitFor(
      () =>
        buttonByName(panel.document, "Full access").getAttribute(
          "aria-pressed",
        ) === "true",
    );
    expect(sessionValues).toEqual({});

    await submitMessage(panel, "購入依頼の状況を確認して");
    await waitFor(
      () => panel.document.querySelector(".chat-permission-prompt") !== null,
    );
    expect(
      panel.document.querySelector(".chat-permission-prompt")?.textContent,
    ).toContain("Full access権限だけでは");
    expect(buttonByName(panel.document, "このセッションで許可")).toBeTruthy();
    expect(
      panel.document.querySelector(".chat-permission-prompt")?.textContent,
    ).not.toContain("今回だけ許可");
    expect(apiClient.submitChatToolResult).not.toHaveBeenCalled();
  });

  it("keeps page-only fields out of the Agent request, rendered Chat, and history storage", async () => {
    const apiClient = createApiClient();
    mounted = await mountSidePanel(() => (
      <ChatPanel
        apiClient={apiClient}
        pageContext={null}
        calendarState={{ status: "not_connected" }}
        calendarRequest={async () => ({ status: "not_connected" })}
      />
    ));
    installLibraryChrome({ consented: true });
    mounted.chromeRuntime.sendMessage.mockImplementation(
      (message: unknown, callback?: (response: unknown) => void) => {
        if (
          typeof message === "object" &&
          message !== null &&
          (message as { type?: string }).type === "my-library-read"
        ) {
          callback?.({
            status: "known",
            projection,
            detail: localDetail,
          });
          return;
        }
        callback?.({ ok: true });
      },
    );

    await submitMessage(mounted, "購入依頼の状況を確認して");
    await waitFor(() => apiClient.submitChatToolResult.mock.calls.length === 1);
    const request = apiClient.submitChatToolResult.mock.calls[0]?.[1] as {
      result?: Record<string, unknown>;
    };
    expect(request.result).toEqual(projection);
    const conversations = await listConversations();
    const stored = JSON.stringify(conversations);
    const rendered = mounted.document.body.textContent ?? "";
    for (const marker of forbiddenValues) {
      expect(JSON.stringify(request.result)).not.toContain(marker);
      expect(stored).not.toContain(marker);
      expect(rendered).not.toContain(marker);
    }
    expect(stored).toContain("購入依頼の状況を確認しました");
    expect(rendered).toContain("端末内資料");
  });
});
