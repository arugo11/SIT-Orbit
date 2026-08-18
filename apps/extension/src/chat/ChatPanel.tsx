import { useEffect, useMemo, useState } from "react";
import {
  type ActionProposal,
  AgentApiClient,
  type ChatRunResponse,
  type ChatToolResultRequest,
  DEFAULT_AGENT_API_BASE,
} from "../api/client";
import {
  type CalendarConnector,
  type CalendarConnectorResult,
  projectCalendarAvailability,
} from "../connectors/google-calendar";
import {
  type PageContext,
  projectScombzPageSummary,
} from "../content/page-context";
import {
  type ChatConversation,
  type ChatTimelineMessage,
  deleteAllConversations,
  deleteConversation,
  listConversations,
  loadConversation,
  newConversation,
  saveConversation,
  toChatHistory,
} from "./chat-history";

const chatApiClient = new AgentApiClient({ baseUrl: DEFAULT_AGENT_API_BASE });

type AccessMode = "ask" | "full";

export interface ChatPanelProps {
  pageContext: PageContext | null;
  calendarState: CalendarConnectorResult;
  calendarConnector?: CalendarConnector;
  calendarRequest: (command: "refresh") => Promise<CalendarConnectorResult>;
  disabled?: boolean;
}

function toolLabel(name: string): string {
  switch (name) {
    case "scombz_page_summary":
      return "SCombZを確認中";
    case "google_calendar_availability":
      return "Google Calendarを確認中";
    case "syllabus_search":
      return "シラバスを検索中";
    case "browser_read_url":
      return "ページを参照中";
    default:
      return "情報を確認中";
  }
}

function evidenceText(proposal: ActionProposal | null | undefined): string[] {
  return proposal?.evidence.map((item) => item.title) ?? [];
}

function messageFromResponse(response: ChatRunResponse): ChatTimelineMessage {
  if (response.status !== "completed") {
    throw new Error("Chat response is not complete.");
  }
  return {
    id: response.message.message_id,
    role: "assistant",
    content: response.message.content_markdown,
    evidence: response.message.evidence,
    proposal: response.proposal,
    proposalState: response.proposal ? "pending" : undefined,
  };
}

function toolResultRequest(
  toolCallId: string,
  name: "scombz_page_summary" | "google_calendar_availability",
  result: ChatToolResultRequest["result"],
): ChatToolResultRequest {
  return {
    tool_call_id: toolCallId,
    name,
    version: 1,
    result,
  };
}

export function ChatPanel({
  pageContext,
  calendarState,
  calendarConnector,
  calendarRequest,
  disabled = false,
}: ChatPanelProps) {
  const [conversation, setConversation] = useState<ChatConversation>(() =>
    newConversation(),
  );
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [accessMode, setAccessMode] = useState<AccessMode>("ask");
  const [composer, setComposer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pageSummary = useMemo(
    () => projectScombzPageSummary(pageContext),
    [pageContext],
  );

  useEffect(() => {
    let mounted = true;
    void listConversations().then((items) => {
      if (!mounted) return;
      setConversations(items);
      if (items[0]) setConversation(items[0]);
    });
    return () => {
      mounted = false;
    };
  }, []);

  async function persist(next: ChatConversation): Promise<void> {
    setConversation(next);
    setConversations((items) => {
      const without = items.filter(
        (item) => item.conversationId !== next.conversationId,
      );
      return [next, ...without].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
    });
    await saveConversation(next);
  }

  function clientTools() {
    const tools: Array<{
      name:
        | "scombz_page_summary"
        | "google_calendar_availability"
        | "syllabus_search"
        | "browser_read_url";
      version: 1;
    }> = [];
    if (pageSummary) tools.push({ name: "scombz_page_summary", version: 1 });
    if (calendarState.status === "connected" && calendarState.snapshot) {
      tools.push({ name: "google_calendar_availability", version: 1 });
    }
    return tools;
  }

  async function runTool(
    response: Extract<ChatRunResponse, { status: "tool_required" }>,
    current: ChatConversation,
  ): Promise<{ response: ChatRunResponse; conversation: ChatConversation }> {
    const [call] = response.calls;
    if (!call) {
      throw new Error("AgentのTool呼び出しを検証できません。");
    }
    if (call.version !== 1 || Object.keys(call.arguments ?? {}).length > 0) {
      throw new Error("AgentのTool引数を検証できません。");
    }
    if (
      call.name !== "scombz_page_summary" &&
      call.name !== "google_calendar_availability"
    ) {
      throw new Error("このChatではまだ対応していないToolです。");
    }
    const activity: ChatTimelineMessage = {
      id: `tool-${call.tool_call_id}`,
      role: "tool",
      content: toolLabel(call.name),
      toolName: call.name,
      toolState: "running",
    };
    const withActivity = {
      ...current,
      updatedAt: new Date().toISOString(),
      messages: [...current.messages, activity],
    };
    await persist(withActivity);

    let request: ChatToolResultRequest;
    if (call.name === "scombz_page_summary") {
      if (!pageSummary) {
        throw new Error("表示中のSCombZページを読み取れません。");
      }
      request = toolResultRequest(call.tool_call_id, call.name, pageSummary);
    } else {
      const refreshed = calendarConnector
        ? await calendarConnector.refresh()
        : await calendarRequest("refresh");
      if (refreshed.status === "reauth_required") {
        throw new Error("Google Calendarの再認証が必要です。");
      }
      if (refreshed.status !== "connected" || !refreshed.snapshot) {
        throw new Error(
          refreshed.message ?? "Google Calendarを利用できません。",
        );
      }
      request = toolResultRequest(
        call.tool_call_id,
        call.name,
        projectCalendarAvailability(refreshed.snapshot),
      );
    }
    const nextResponse = await chatApiClient.submitChatToolResult(
      response.run_id,
      request,
    );
    const completedConversation = {
      ...withActivity,
      messages: withActivity.messages.map((item) =>
        item.id === activity.id
          ? { ...item, toolState: "completed" as const }
          : item,
      ),
    };
    await persist(completedConversation);
    return { response: nextResponse, conversation: completedConversation };
  }

  async function send(): Promise<void> {
    const message = composer.trim();
    if (!message || busy || disabled) return;
    setComposer("");
    setError(null);
    setBusy(true);
    const userMessage: ChatTimelineMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: message,
    };
    const beforeSend = conversation;
    const withUser = {
      ...beforeSend,
      title:
        beforeSend.messages.length === 0
          ? message.slice(0, 40)
          : beforeSend.title,
      updatedAt: new Date().toISOString(),
      messages: [...beforeSend.messages, userMessage],
    };
    await persist(withUser);
    let current = withUser;
    try {
      let response = await chatApiClient.startChat({
        conversation_id: withUser.conversationId,
        message,
        history: toChatHistory(beforeSend.messages),
        client_tools: clientTools(),
      });
      const seenCallIds = new Set<string>();
      for (let index = 0; response.status === "tool_required"; index += 1) {
        if (index >= 8) throw new Error("Tool呼び出し回数の上限に達しました。");
        const call = response.calls[0];
        if (!call || seenCallIds.has(call.tool_call_id)) {
          throw new Error("重複したTool呼び出しを受け取りました。");
        }
        seenCallIds.add(call.tool_call_id);
        const next = await runTool(response, current);
        response = next.response;
        current = next.conversation;
      }
      const assistant = messageFromResponse(response);
      await persist({
        ...current,
        updatedAt: new Date().toISOString(),
        messages: [...current.messages, assistant],
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Chatに失敗しました。",
      );
      await persist({
        ...current,
        updatedAt: new Date().toISOString(),
        messages: [
          ...current.messages,
          {
            id: `error-${Date.now()}`,
            role: "assistant",
            content:
              "処理を完了できませんでした。接続状態と許可を確認してください。",
          },
        ],
      });
    } finally {
      setBusy(false);
    }
  }

  async function selectConversation(id: string): Promise<void> {
    const selected = await loadConversation(id);
    if (selected) {
      setConversation(selected);
      setHistoryOpen(false);
    }
  }

  async function createConversation(): Promise<void> {
    const next = newConversation();
    await persist(next);
    setHistoryOpen(false);
  }

  async function removeConversation(id: string): Promise<void> {
    await deleteConversation(id);
    const remaining = conversations.filter(
      (item) => item.conversationId !== id,
    );
    setConversations(remaining);
    if (conversation.conversationId === id) {
      await createConversation();
    }
  }

  async function clearConversations(): Promise<void> {
    await deleteAllConversations();
    await createConversation();
  }

  async function updateProposal(
    messageId: string,
    state: "approved" | "rejected",
  ): Promise<void> {
    const next = {
      ...conversation,
      updatedAt: new Date().toISOString(),
      messages: conversation.messages.map((message) =>
        message.id === messageId
          ? { ...message, proposalState: state }
          : message,
      ),
    };
    await persist(next);
  }

  return (
    <section className="chat-panel" aria-label="SIT ORBIT Chat">
      <header className="chat-toolbar">
        <div>
          <p className="eyebrow">SIT ORBIT</p>
          <h2>Chat</h2>
        </div>
        <div className="chat-toolbar-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => void createConversation()}
          >
            新規Chat
          </button>
          <button
            type="button"
            className="secondary-button"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            履歴
          </button>
        </div>
      </header>
      {historyOpen ? (
        <aside className="chat-history" aria-label="Chat履歴">
          <div className="chat-history-heading">
            <strong>保存したChat</strong>
            <button
              type="button"
              className="text-button"
              onClick={() => void clearConversations()}
            >
              すべて削除
            </button>
          </div>
          {conversations.length === 0 ? (
            <p className="empty-state">履歴はありません。</p>
          ) : null}
          <ul>
            {conversations.map((item) => (
              <li key={item.conversationId}>
                <button
                  type="button"
                  onClick={() => void selectConversation(item.conversationId)}
                >
                  {item.title}
                </button>
                <button
                  type="button"
                  className="text-button"
                  aria-label={`${item.title}を削除`}
                  onClick={() => void removeConversation(item.conversationId)}
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        </aside>
      ) : null}

      <fieldset className="chat-access-row">
        <legend>アクセスモード</legend>
        <div className="segmented-control">
          <button
            type="button"
            aria-pressed={accessMode === "ask"}
            onClick={() => setAccessMode("ask")}
          >
            都度確認
          </button>
          <button
            type="button"
            aria-pressed={accessMode === "full"}
            onClick={() => setAccessMode("full")}
          >
            Full access
          </button>
        </div>
        <small>
          {accessMode === "ask" ? "読み取り前に確認します" : "読み取り専用"}
        </small>
      </fieldset>

      <div className="chat-timeline" aria-live="polite">
        {conversation.messages.length === 0 ? (
          <div className="chat-empty">
            <h3>何を手伝いましょうか？</h3>
            <p>
              SCombZの課題、予定、公開シラバスなどを、必要なときだけ確認できます。
            </p>
          </div>
        ) : null}
        {conversation.messages.map((message) => (
          <article
            className={`chat-message chat-message-${message.role}`}
            key={message.id}
            data-tool-state={message.toolState}
          >
            <span className="chat-message-role">
              {message.role === "user"
                ? "あなた"
                : message.role === "tool"
                  ? "Tool"
                  : "SIT ORBIT"}
            </span>
            <div className="chat-message-content">
              <p>{message.content}</p>
              {message.evidence && message.evidence.length > 0 ? (
                <div className="chat-citations">
                  <strong>参照</strong>
                  <ul>
                    {message.evidence.map((item) => (
                      <li key={item.evidence_id}>{item.title}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {message.proposal ? (
                <div
                  className="chat-proposal"
                  data-proposal-state={message.proposalState}
                >
                  <strong>確認が必要な提案</strong>
                  <p>{message.proposal.title}</p>
                  <small>
                    {message.proposal.reason}（
                    {message.proposal.duration_minutes}分）
                  </small>
                  {message.proposalState === "pending" ? (
                    <div className="button-row">
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() =>
                          void updateProposal(message.id, "approved")
                        }
                      >
                        提案を承認
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() =>
                          void updateProposal(message.id, "rejected")
                        }
                      >
                        却下
                      </button>
                    </div>
                  ) : (
                    <span className="state-message">
                      {message.proposalState === "approved"
                        ? "承認済み"
                        : "却下済み"}
                    </span>
                  )}
                  {evidenceText(message.proposal).length > 0 ? (
                    <small>
                      根拠: {evidenceText(message.proposal).join("、")}
                    </small>
                  ) : null}
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </div>

      {error ? (
        <p className="error-message" role="alert">
          {error}
        </p>
      ) : null}
      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="Chatメッセージ"
          placeholder="SIT ORBITに相談する"
          rows={2}
          value={composer}
          disabled={busy || disabled}
          onChange={(event) => setComposer(event.target.value)}
        />
        <button
          type="submit"
          className="primary-button"
          disabled={busy || disabled || !composer.trim()}
        >
          {busy ? "確認中…" : "送信"}
        </button>
      </form>
      <p className="chat-policy-note">
        明示的に送信したときだけ、必要なToolを実行します。外部への書き込みは別途確認します。
      </p>
    </section>
  );
}
