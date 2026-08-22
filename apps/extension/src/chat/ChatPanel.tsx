import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ActionProposal,
  type AgentApiClient,
  type ChatRunResponse,
  type ChatToolResultRequest,
  isBrowserReadResult,
  isCastAlumniReadResult,
  isCastReadResult,
  isLibraryActionOptionsResult,
  isLibraryCatalogBrowseResult,
  isLibraryCatalogSearchResult,
  isLibraryDiscoverySearchResult,
  isLibraryItemReadResult,
  isMoodleReadResult,
  isMyLibraryReadResult,
  isSitrusGradeResult,
  isSyllabusSearchResult,
  type SyllabusSearchResult,
} from "../api/client";
import {
  type CalendarConnector,
  type CalendarConnectorResult,
  projectCalendarAvailability,
} from "../connectors/google-calendar";
import type { LibraryActionEditableInputs } from "../connectors/library-actions";
import {
  LIBRARY_OPAC_ORIGIN,
  LIBRARY_OPAC_PERMISSION_PATTERN,
  LIBRARY_SIT_SEARCH_ORIGIN,
  LIBRARY_SIT_SEARCH_PERMISSION_PATTERN,
  requestsLibraryTools,
} from "../connectors/library-discovery";
import type { CastAlumniLocalSnapshot } from "../content/cast-alumni-reader";
import { CAST_ENTRY_URL, type CastLocalSnapshot } from "../content/cast-reader";
import {
  MOODLE_DASHBOARD_URL,
  type MoodleLocalSnapshot,
} from "../content/moodle-reader";
import {
  clearMyLibrarySessionConsent,
  grantMyLibrarySessionConsent,
  hasMyLibrarySessionConsent,
} from "../content/my-library-consent";
import {
  MY_LIBRARY_ENTRY_URL,
  MY_LIBRARY_ORIGIN,
  type MyLibraryLocalSnapshot,
} from "../content/my-library-reader";
import {
  isSitrusGradeUrl,
  type PageContext,
  projectScombzPageSummary,
  projectScombzRead,
} from "../content/page-context";
import type {
  BrowserReadResponse,
  CastAlumniReadResponse,
  CastReadResponse,
  LibraryActionOptionsResponse,
  LibraryActionPreviewResponse,
  LibraryActionSubmitResponse,
  LibraryCatalogBrowseResponse,
  LibraryCatalogSearchResponse,
  LibraryDiscoverySearchResponse,
  LibraryItemReadResponse,
  MoodleReadResponse,
  MyLibraryReadResponse,
  SitrusReadResponse,
} from "../shared/messages";
import { MESSAGE_TYPES } from "../shared/messages";
import {
  type AccessMode,
  containsOriginPermission,
  hostAccessRequest,
  requestOriginPermission,
  requiresHostConfirmation,
} from "./access-policy";
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

export interface ChatPanelProps {
  apiClient: AgentApiClient;
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
    case "scombz_read":
      return "SCombZを確認中";
    case "syllabus_search":
      return "シラバスを検索中";
    case "browser_read_url":
      return "ページを参照中";
    case "sitrus_read":
      return "SITRUSの成績を確認中";
    case "moodle_read":
      return "Moodleを確認中";
    case "my_library_read":
      return "My Libraryを確認中";
    case "cast_read":
      return "CASTを確認中";
    case "cast_alumni_read":
      return "CASTの就活サポーターを確認中";
    case "library_catalog_search":
      return "OPACを検索中";
    case "library_item_read":
      return "OPACの書誌詳細を確認中";
    case "library_catalog_browse":
      return "OPACの新着・ランキングを確認中";
    case "library_discovery_search":
      return "SIT Searchを検索中";
    case "library_action_options":
      return "図書館の操作可否を確認中";
    default:
      return "情報を確認中";
  }
}

const LIBRARY_SEARCH_PERMISSION_DISCLOSURE =
  "検索語をこのサイトへ送信し、表示された結果のみを読み取ります。予約等の変更はしません。";

function evidenceText(proposal: ActionProposal | null | undefined): string[] {
  return proposal?.evidence.map((item) => item.title) ?? [];
}

function editableInputValue(
  inputs: LibraryActionEditableInputs | undefined,
  key: string,
): string {
  if (!inputs) return "";
  const values = inputs.values as unknown as Record<string, unknown>;
  const value = values[key];
  return typeof value === "string" ? value : "";
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
  name:
    | "scombz_page_summary"
    | "scombz_read"
    | "google_calendar_availability"
    | "syllabus_search"
    | "browser_read_url"
    | "sitrus_read"
    | "moodle_read"
    | "my_library_read"
    | "cast_read"
    | "cast_alumni_read"
    | "library_catalog_search"
    | "library_item_read"
    | "library_catalog_browse"
    | "library_discovery_search"
    | "library_action_options",
  result: ChatToolResultRequest["result"],
): ChatToolResultRequest {
  return {
    tool_call_id: toolCallId,
    name,
    version: 1,
    result,
  };
}

function sendExtensionMessage<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T | undefined) => {
      if (chrome.runtime.lastError || response === undefined) {
        reject(new Error("拡張機能のToolを利用できません。"));
        return;
      }
      resolve(response);
    });
  });
}

class BrowserAccessRequiredError extends Error {
  readonly pattern: string;
  readonly origin: string;
  readonly url: string;
  readonly approvalKey: string;
  readonly disclosure: string | null;

  constructor(
    url: string,
    origin: string,
    pattern: string,
    approvalKey = url,
    disclosure: string | null = null,
  ) {
    super("このサイトを読むには許可が必要です。");
    this.name = "BrowserAccessRequiredError";
    this.url = url;
    this.origin = origin;
    this.pattern = pattern;
    this.approvalKey = approvalKey;
    this.disclosure = disclosure;
  }
}

interface PendingPermission {
  url: string;
  origin: string;
  pattern: string;
  response: Extract<ChatRunResponse, { status: "tool_required" }>;
  conversation: ChatConversation;
  seenCallIds: string[];
  approvalKey: string;
  disclosure: string | null;
}

export function ChatPanel({
  apiClient,
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
  const [accessMode, setAccessMode] = useState<AccessMode>(() =>
    globalThis.localStorage?.getItem("sit-orbit-access-mode") === "full"
      ? "full"
      : "ask",
  );
  const [composer, setComposer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionPrompt, setPermissionPrompt] =
    useState<PendingPermission | null>(null);
  const [localMoodleDetails, setLocalMoodleDetails] = useState<
    Record<string, MoodleLocalSnapshot>
  >({});
  const [localMyLibraryDetails, setLocalMyLibraryDetails] = useState<
    Record<string, MyLibraryLocalSnapshot>
  >({});
  const [localCastDetails, setLocalCastDetails] = useState<
    Record<string, CastLocalSnapshot>
  >({});
  const [localCastAlumniDetails, setLocalCastAlumniDetails] = useState<
    Record<string, CastAlumniLocalSnapshot>
  >({});
  const [libraryPreviews, setLibraryPreviews] = useState<
    Record<string, Extract<LibraryActionPreviewResponse, { status: "ready" }>>
  >({});
  const [libraryPreviewInputs, setLibraryPreviewInputs] = useState<
    Record<string, LibraryActionEditableInputs>
  >({});
  const [libraryPreviewStates, setLibraryPreviewStates] = useState<
    Record<string, "previewing" | "submitting" | "verified" | "unavailable">
  >({});
  const [libraryPreviewErrors, setLibraryPreviewErrors] = useState<
    Record<string, string>
  >({});
  const sensitiveApproval = useRef(new Set<string>());

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

  function clientTools(message: string) {
    const tools: Array<{
      name:
        | "scombz_page_summary"
        | "scombz_read"
        | "google_calendar_availability"
        | "syllabus_search"
        | "browser_read_url"
        | "sitrus_read"
        | "moodle_read"
        | "my_library_read"
        | "cast_read"
        | "cast_alumni_read"
        | "library_catalog_search"
        | "library_item_read"
        | "library_catalog_browse"
        | "library_discovery_search"
        | "library_action_options";
      version: 1;
    }> = [];
    if (projectScombzRead(pageContext)) {
      tools.push({ name: "scombz_read", version: 1 });
    }
    if (calendarState.status === "connected" && calendarState.snapshot) {
      tools.push({ name: "google_calendar_availability", version: 1 });
    }
    tools.push({ name: "syllabus_search", version: 1 });
    tools.push({ name: "browser_read_url", version: 1 });
    if (isSitrusGradeUrl(pageContext?.url)) {
      tools.push({ name: "sitrus_read", version: 1 });
    }
    tools.push({ name: "moodle_read", version: 1 });
    tools.push({ name: "my_library_read", version: 1 });
    tools.push({ name: "cast_read", version: 1 });
    tools.push({ name: "cast_alumni_read", version: 1 });
    if (requestsLibraryTools(message)) {
      tools.push({ name: "library_catalog_search", version: 1 });
      tools.push({ name: "library_item_read", version: 1 });
      tools.push({ name: "library_catalog_browse", version: 1 });
      tools.push({ name: "library_discovery_search", version: 1 });
      tools.push({ name: "library_action_options", version: 1 });
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
    const argumentsObject = call.arguments ?? {};
    if (call.version !== 1 || typeof argumentsObject !== "object") {
      throw new Error("AgentのTool引数を検証できません。");
    }
    if (
      call.name !== "scombz_page_summary" &&
      call.name !== "scombz_read" &&
      call.name !== "google_calendar_availability" &&
      call.name !== "syllabus_search" &&
      call.name !== "browser_read_url" &&
      call.name !== "sitrus_read" &&
      call.name !== "moodle_read" &&
      call.name !== "my_library_read" &&
      call.name !== "cast_read" &&
      call.name !== "cast_alumni_read" &&
      call.name !== "library_catalog_search" &&
      call.name !== "library_item_read" &&
      call.name !== "library_catalog_browse" &&
      call.name !== "library_discovery_search" &&
      call.name !== "library_action_options"
    ) {
      throw new Error("このChatではまだ対応していないToolです。");
    }
    if (
      (call.name === "scombz_page_summary" ||
        call.name === "scombz_read" ||
        call.name === "google_calendar_availability" ||
        call.name === "sitrus_read" ||
        call.name === "moodle_read" ||
        call.name === "cast_read" ||
        call.name === "cast_alumni_read") &&
      Object.keys(argumentsObject).length > 0
    ) {
      throw new Error("このToolには引数を指定できません。");
    }
    if (
      call.name === "syllabus_search" &&
      (typeof argumentsObject.query !== "string" ||
        argumentsObject.query.trim().length === 0 ||
        argumentsObject.query.length > 200 ||
        Object.keys(argumentsObject).some(
          (key) => !["query", "year", "faculty"].includes(key),
        ))
    ) {
      throw new Error("シラバス検索の引数を検証できません。");
    }
    if (
      call.name === "my_library_read" &&
      (Object.keys(argumentsObject).some(
        (key) => !["scope", "query", "offset", "limit"].includes(key),
      ) ||
        (argumentsObject.scope !== undefined &&
          ![
            "current_loans",
            "reservations",
            "loan_history",
            "purchase_requests",
            "interlibrary_requests",
          ].includes(argumentsObject.scope as string)) ||
        (argumentsObject.query !== undefined &&
          argumentsObject.query !== null &&
          (typeof argumentsObject.query !== "string" ||
            argumentsObject.query.length > 200)) ||
        (argumentsObject.offset !== undefined &&
          (typeof argumentsObject.offset !== "number" ||
            !Number.isInteger(argumentsObject.offset) ||
            argumentsObject.offset < 0 ||
            argumentsObject.offset > 1000)) ||
        (argumentsObject.limit !== undefined &&
          (typeof argumentsObject.limit !== "number" ||
            !Number.isInteger(argumentsObject.limit) ||
            argumentsObject.limit < 1 ||
            argumentsObject.limit > 20)))
    ) {
      throw new Error("My Libraryのscope・ページ引数を検証できません。");
    }
    if (
      call.name === "syllabus_search" &&
      argumentsObject.year !== undefined &&
      argumentsObject.year !== null &&
      (typeof argumentsObject.year !== "number" ||
        !Number.isInteger(argumentsObject.year) ||
        argumentsObject.year < 2000 ||
        argumentsObject.year > 2100)
    ) {
      throw new Error("シラバス検索の年度を検証できません。");
    }
    if (
      call.name === "syllabus_search" &&
      argumentsObject.faculty !== undefined &&
      argumentsObject.faculty !== null &&
      (typeof argumentsObject.faculty !== "string" ||
        argumentsObject.faculty.length > 200)
    ) {
      throw new Error("シラバス検索の学部を検証できません。");
    }
    if (
      call.name === "browser_read_url" &&
      (typeof argumentsObject.url !== "string" ||
        Object.keys(argumentsObject).length !== 1)
    ) {
      throw new Error("参照先URLを検証できません。");
    }
    if (
      call.name === "library_catalog_search" &&
      (typeof argumentsObject.query !== "string" ||
        !argumentsObject.query.trim() ||
        argumentsObject.query.length > 200 ||
        Object.keys(argumentsObject).some(
          (key) =>
            ![
              "query",
              "author",
              "subject",
              "isbn",
              "pub_year",
              "campus",
              "format",
              "limit",
            ].includes(key),
        ) ||
        (argumentsObject.author !== undefined &&
          argumentsObject.author !== null &&
          (typeof argumentsObject.author !== "string" ||
            argumentsObject.author.length > 200)) ||
        (argumentsObject.subject !== undefined &&
          argumentsObject.subject !== null &&
          (typeof argumentsObject.subject !== "string" ||
            argumentsObject.subject.length > 200)) ||
        (argumentsObject.isbn !== undefined &&
          argumentsObject.isbn !== null &&
          (typeof argumentsObject.isbn !== "string" ||
            argumentsObject.isbn.length > 32)) ||
        (argumentsObject.pub_year !== undefined &&
          argumentsObject.pub_year !== null &&
          (typeof argumentsObject.pub_year !== "number" ||
            !Number.isInteger(argumentsObject.pub_year) ||
            argumentsObject.pub_year < 1000 ||
            argumentsObject.pub_year > 2100)) ||
        (argumentsObject.campus !== undefined &&
          !["toyosu", "omiya", "any"].includes(
            argumentsObject.campus as string,
          )) ||
        (argumentsObject.format !== undefined &&
          !["book", "journal", "ebook", "any"].includes(
            argumentsObject.format as string,
          )) ||
        (argumentsObject.limit !== undefined &&
          (typeof argumentsObject.limit !== "number" ||
            !Number.isInteger(argumentsObject.limit) ||
            argumentsObject.limit < 1 ||
            argumentsObject.limit > 10)))
    ) {
      throw new Error("OPAC検索の引数を検証できません。");
    }
    if (
      call.name === "library_item_read" &&
      (Object.keys(argumentsObject).length !== 1 ||
        typeof argumentsObject.resource_ref !== "string" ||
        !/^orbit-library:\/\/record\/[A-Za-z0-9_-]{16,128}$/u.test(
          argumentsObject.resource_ref,
        ))
    ) {
      throw new Error("OPAC書誌参照の引数を検証できません。");
    }
    if (
      call.name === "library_catalog_browse" &&
      (Object.keys(argumentsObject).some(
        (key) => !["kind", "campus", "limit"].includes(key),
      ) ||
        !["new_books", "loan_ranking"].includes(
          argumentsObject.kind as string,
        ) ||
        (argumentsObject.campus !== undefined &&
          !["toyosu", "omiya", "any"].includes(
            argumentsObject.campus as string,
          )) ||
        (argumentsObject.limit !== undefined &&
          (typeof argumentsObject.limit !== "number" ||
            !Number.isInteger(argumentsObject.limit) ||
            argumentsObject.limit < 1 ||
            argumentsObject.limit > 10)))
    ) {
      throw new Error("OPAC一覧の引数を検証できません。");
    }
    if (
      call.name === "library_discovery_search" &&
      (Object.keys(argumentsObject).some(
        (key) => !["query", "limit"].includes(key),
      ) ||
        typeof argumentsObject.query !== "string" ||
        !argumentsObject.query.trim() ||
        argumentsObject.query.length > 200 ||
        (argumentsObject.limit !== undefined &&
          (typeof argumentsObject.limit !== "number" ||
            !Number.isInteger(argumentsObject.limit) ||
            argumentsObject.limit < 1 ||
            argumentsObject.limit > 10)))
    ) {
      throw new Error("SIT Searchの引数を検証できません。");
    }
    if (
      call.name === "library_action_options" &&
      (Object.keys(argumentsObject).length !== 1 ||
        typeof argumentsObject.resource_ref !== "string" ||
        !/^orbit-library:\/\/record\/[A-Za-z0-9_-]{16,128}$/u.test(
          argumentsObject.resource_ref,
        ))
    ) {
      throw new Error("図書館操作可否の引数を検証できません。");
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
    } else if (call.name === "scombz_read") {
      const readResult = projectScombzRead(pageContext);
      if (!readResult) {
        throw new Error("表示中のSCombZページを読み取れません。");
      }
      if (readResult.restricted_present && pageContext) {
        const access = hostAccessRequest(pageContext.url);
        if (access && !sensitiveApproval.current.has(pageContext.url)) {
          throw new BrowserAccessRequiredError(
            pageContext.url,
            access.origin,
            access.pattern,
          );
        }
      }
      request = toolResultRequest(call.tool_call_id, call.name, readResult);
    } else if (call.name === "google_calendar_availability") {
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
    } else if (call.name === "syllabus_search") {
      const syllabus = await sendExtensionMessage<SyllabusSearchResult>({
        type: "syllabus-search",
        tool_call_id: call.tool_call_id,
        query: argumentsObject.query as string,
        year:
          typeof argumentsObject.year === "number"
            ? argumentsObject.year
            : null,
        faculty:
          typeof argumentsObject.faculty === "string"
            ? argumentsObject.faculty
            : null,
      });
      if (!isSyllabusSearchResult(syllabus)) {
        throw new Error("シラバス検索結果を検証できません。");
      }
      request = toolResultRequest(call.tool_call_id, call.name, syllabus);
    } else if (call.name === "library_catalog_search") {
      const approvalKey = `${response.run_id}:${call.tool_call_id}:library-catalog-search`;
      if (!sensitiveApproval.current.has(approvalKey)) {
        throw new BrowserAccessRequiredError(
          LIBRARY_OPAC_ORIGIN,
          LIBRARY_OPAC_ORIGIN,
          LIBRARY_OPAC_PERMISSION_PATTERN,
          approvalKey,
          LIBRARY_SEARCH_PERMISSION_DISCLOSURE,
        );
      }
      const library = await sendExtensionMessage<LibraryCatalogSearchResponse>({
        type: "library-catalog-search",
        tool_call_id: call.tool_call_id,
        query: argumentsObject.query as string,
        author:
          typeof argumentsObject.author === "string"
            ? argumentsObject.author
            : null,
        subject:
          typeof argumentsObject.subject === "string"
            ? argumentsObject.subject
            : null,
        isbn:
          typeof argumentsObject.isbn === "string"
            ? argumentsObject.isbn
            : null,
        pub_year:
          typeof argumentsObject.pub_year === "number"
            ? argumentsObject.pub_year
            : null,
        campus:
          typeof argumentsObject.campus === "string"
            ? (argumentsObject.campus as "toyosu" | "omiya" | "any")
            : "any",
        format:
          typeof argumentsObject.format === "string"
            ? (argumentsObject.format as "book" | "journal" | "ebook" | "any")
            : "any",
        limit:
          typeof argumentsObject.limit === "number"
            ? argumentsObject.limit
            : 10,
      });
      if (library.status === "permission_required") {
        throw new BrowserAccessRequiredError(
          library.origin,
          library.origin,
          library.pattern,
          approvalKey,
          LIBRARY_SEARCH_PERMISSION_DISCLOSURE,
        );
      }
      if (library.status === "unavailable") {
        request = toolResultRequest(call.tool_call_id, call.name, {
          schema_version: "v1",
          status: "unavailable",
          query: argumentsObject.query as string,
          items: [],
          reason_code: library.reason_code,
        });
      } else if (!isLibraryCatalogSearchResult(library.projection)) {
        throw new Error("OPAC検索結果を検証できませんでした。");
      } else {
        request = toolResultRequest(
          call.tool_call_id,
          call.name,
          library.projection,
        );
      }
    } else if (call.name === "library_item_read") {
      const library = await sendExtensionMessage<LibraryItemReadResponse>({
        type: "library-item-read",
        tool_call_id: call.tool_call_id,
        resource_ref: argumentsObject.resource_ref as string,
      });
      if (library.status === "permission_required") {
        throw new BrowserAccessRequiredError(
          library.origin,
          library.origin,
          library.pattern,
        );
      }
      if (library.status === "unavailable") {
        request = toolResultRequest(call.tool_call_id, call.name, {
          schema_version: "v1",
          status: "unavailable",
          resource_ref: argumentsObject.resource_ref as string,
          item: null,
          reason_code: library.reason_code,
        });
      } else if (!isLibraryItemReadResult(library.projection)) {
        throw new Error("OPAC書誌詳細を検証できませんでした。");
      } else {
        request = toolResultRequest(
          call.tool_call_id,
          call.name,
          library.projection,
        );
      }
    } else if (call.name === "library_action_options") {
      const approvalKey = `${response.run_id}:${call.tool_call_id}:library-action-options`;
      const library = await sendExtensionMessage<LibraryActionOptionsResponse>({
        type: MESSAGE_TYPES.libraryActionOptions,
        tool_call_id: call.tool_call_id,
        resource_ref: argumentsObject.resource_ref as string,
      });
      if (library.status === "permission_required") {
        throw new BrowserAccessRequiredError(
          library.origin,
          library.origin,
          library.pattern,
          approvalKey,
          "図書館の現在の表示を端末内で再確認し、操作可否だけを選択中のAgentへ送ります。予約・延長・申請の送信は行いません。",
        );
      }
      if (library.status === "reauth_required") {
        throw new Error(
          "図書館のログイン状態を確認できません。公式ページでログイン後、もう一度お試しください。",
        );
      }
      const projection = library.status === "known" ? library.projection : null;
      if (!projection || !isLibraryActionOptionsResult(projection)) {
        throw new Error("図書館の操作可否を検証できませんでした。");
      }
      if (projection.data_classification === "personal") {
        const capabilities = await apiClient.capabilities();
        if (
          capabilities.agent_backend !== "azure_openai" ||
          !capabilities.my_library_personal_context
        ) {
          throw new Error(
            "My Library由来の操作可否は、明示同意済みのAzure Agentだけに送信できます。",
          );
        }
        if (
          !(await hasMyLibrarySessionConsent()) &&
          !sensitiveApproval.current.has(approvalKey)
        ) {
          throw new BrowserAccessRequiredError(
            MY_LIBRARY_ENTRY_URL,
            MY_LIBRARY_ORIGIN,
            `${MY_LIBRARY_ORIGIN}/*`,
            approvalKey,
            "My Libraryの現在の表示を端末内で再確認し、対象refと操作可否だけを明示同意済みのAzure Agentへ送ります。書名・ID・フォーム値は送信しません。",
          );
        }
      }
      request = toolResultRequest(call.tool_call_id, call.name, projection);
    } else if (call.name === "library_catalog_browse") {
      const library = await sendExtensionMessage<LibraryCatalogBrowseResponse>({
        type: "library-catalog-browse",
        tool_call_id: call.tool_call_id,
        kind: argumentsObject.kind as "new_books" | "loan_ranking",
        campus:
          typeof argumentsObject.campus === "string"
            ? (argumentsObject.campus as "toyosu" | "omiya" | "any")
            : "any",
        limit:
          typeof argumentsObject.limit === "number"
            ? argumentsObject.limit
            : 10,
      });
      if (library.status === "permission_required") {
        throw new BrowserAccessRequiredError(
          library.origin,
          library.origin,
          library.pattern,
        );
      }
      if (library.status === "unavailable") {
        request = toolResultRequest(call.tool_call_id, call.name, {
          schema_version: "v1",
          status: "unavailable",
          kind: argumentsObject.kind as "new_books" | "loan_ranking",
          campus:
            typeof argumentsObject.campus === "string"
              ? (argumentsObject.campus as "toyosu" | "omiya" | "any")
              : "any",
          items: [],
          reason_code: library.reason_code,
        });
      } else if (!isLibraryCatalogBrowseResult(library.projection)) {
        throw new Error("OPAC一覧結果を検証できませんでした。");
      } else {
        request = toolResultRequest(
          call.tool_call_id,
          call.name,
          library.projection,
        );
      }
    } else if (call.name === "library_discovery_search") {
      const approvalKey = `${response.run_id}:${call.tool_call_id}:library-discovery-search`;
      if (!sensitiveApproval.current.has(approvalKey)) {
        throw new BrowserAccessRequiredError(
          LIBRARY_SIT_SEARCH_ORIGIN,
          LIBRARY_SIT_SEARCH_ORIGIN,
          LIBRARY_SIT_SEARCH_PERMISSION_PATTERN,
          approvalKey,
          LIBRARY_SEARCH_PERMISSION_DISCLOSURE,
        );
      }
      const library =
        await sendExtensionMessage<LibraryDiscoverySearchResponse>({
          type: "library-discovery-search",
          tool_call_id: call.tool_call_id,
          query: argumentsObject.query as string,
          limit:
            typeof argumentsObject.limit === "number"
              ? argumentsObject.limit
              : 10,
        });
      if (library.status === "permission_required") {
        throw new BrowserAccessRequiredError(
          library.origin,
          library.origin,
          library.pattern,
          approvalKey,
          LIBRARY_SEARCH_PERMISSION_DISCLOSURE,
        );
      }
      if (library.status === "unavailable") {
        request = toolResultRequest(call.tool_call_id, call.name, {
          schema_version: "v1",
          status: "unavailable",
          query: argumentsObject.query as string,
          items: [],
          reason_code: library.reason_code,
        });
      } else if (!isLibraryDiscoverySearchResult(library.projection)) {
        throw new Error("SIT Search結果を検証できませんでした。");
      } else {
        request = toolResultRequest(
          call.tool_call_id,
          call.name,
          library.projection,
        );
      }
    } else if (call.name === "sitrus_read") {
      if (!pageContext || !isSitrusGradeUrl(pageContext.url)) {
        throw new Error("表示中のSITRUS成績ページを読み取れません。");
      }
      const access = hostAccessRequest(pageContext.url);
      if (!access) throw new Error("SITRUSの参照先URLを検証できません。");
      await containsOriginPermission(access.pattern);
      if (!sensitiveApproval.current.has(pageContext.url)) {
        throw new BrowserAccessRequiredError(
          pageContext.url,
          access.origin,
          access.pattern,
        );
      }
      const sitrus = await sendExtensionMessage<SitrusReadResponse>({
        type: "sitrus-read",
        tool_call_id: call.tool_call_id,
        page_url: pageContext.url,
      });
      if (sitrus.status === "permission_required") {
        throw new BrowserAccessRequiredError(
          pageContext.url,
          sitrus.origin,
          sitrus.pattern,
        );
      }
      if (
        sitrus.status !== "known" ||
        !isSitrusGradeResult(sitrus.projection)
      ) {
        throw new Error("SITRUSの成績を読み取れませんでした。");
      }
      request = toolResultRequest(
        call.tool_call_id,
        call.name,
        sitrus.projection,
      );
    } else if (call.name === "moodle_read") {
      const access = hostAccessRequest(MOODLE_DASHBOARD_URL);
      if (!access) throw new Error("Moodleの参照先URLを検証できません。");
      const approvalKey = `${response.run_id}:${call.tool_call_id}:moodle-derived`;
      if (!sensitiveApproval.current.has(approvalKey)) {
        throw new BrowserAccessRequiredError(
          MOODLE_DASHBOARD_URL,
          access.origin,
          access.pattern,
          approvalKey,
          "Moodleの表示内容を端末内で読み取り、コース数・課題件数・延滞件数・最短期限・未読件数だけを選択中のAIへ送ります。コース名や課題名は送信しません。",
        );
      }
      const moodle = await sendExtensionMessage<MoodleReadResponse>({
        type: "moodle-read",
        tool_call_id: call.tool_call_id,
      });
      if (moodle.status === "permission_required") {
        throw new BrowserAccessRequiredError(
          MOODLE_DASHBOARD_URL,
          moodle.origin,
          moodle.pattern,
          approvalKey,
          "Moodleの表示内容を端末内で読み取り、コース数・課題件数・延滞件数・最短期限・未読件数だけを選択中のAIへ送ります。コース名や課題名は送信しません。",
        );
      }
      if (moodle.status === "reauth_required") {
        throw new Error(
          "Moodleのログインページを開きました。ログイン後、もう一度質問してください。",
        );
      }
      if (moodle.status !== "known" || !isMoodleReadResult(moodle.projection)) {
        throw new Error("Moodleのダッシュボードを読み取れませんでした。");
      }
      setLocalMoodleDetails((items) => ({
        ...items,
        [activity.id]: moodle.detail,
      }));
      request = toolResultRequest(
        call.tool_call_id,
        call.name,
        moodle.projection,
      );
      sensitiveApproval.current.delete(approvalKey);
    } else if (call.name === "my_library_read") {
      const access = hostAccessRequest(MY_LIBRARY_ENTRY_URL);
      if (!access) throw new Error("My Libraryの参照先URLを検証できません。");
      const approvalKey = `${response.run_id}:${call.tool_call_id}:my-library-derived`;
      const disclosure =
        "指定scopeのMy Library表示を端末内で読み取り、opaque参照・書名・著者・状態・期限など許可された最小項目だけを選択中のAzure Agentへ送ります。Agent回答に現れた書名はローカルChat履歴へ保存され、履歴の削除操作で消せます。Full access権限だけではこの同意になりません。";
      const sessionConsented = await hasMyLibrarySessionConsent();
      if (!sessionConsented && !sensitiveApproval.current.has(approvalKey)) {
        throw new BrowserAccessRequiredError(
          MY_LIBRARY_ENTRY_URL,
          access.origin,
          access.pattern,
          approvalKey,
          disclosure,
        );
      }
      const requestedScope =
        typeof argumentsObject.scope === "string"
          ? (argumentsObject.scope as
              | "current_loans"
              | "reservations"
              | "loan_history"
              | "purchase_requests"
              | "interlibrary_requests")
          : "current_loans";
      const requestedOffset =
        typeof argumentsObject.offset === "number" ? argumentsObject.offset : 0;
      const requestedLimit =
        typeof argumentsObject.limit === "number" ? argumentsObject.limit : 20;
      const capabilities = await apiClient.capabilities();
      if (
        capabilities.agent_backend !== "azure_openai" ||
        !capabilities.my_library_personal_context
      ) {
        throw new Error(
          "My Libraryの個人情報はAzure OpenAI Agentに接続している場合だけ送信できます。",
        );
      }
      const library = await sendExtensionMessage<MyLibraryReadResponse>({
        type: "my-library-read",
        tool_call_id: call.tool_call_id,
        scope: requestedScope,
        query:
          typeof argumentsObject.query === "string"
            ? argumentsObject.query
            : null,
        offset: requestedOffset,
        limit: requestedLimit,
      });
      if (library.status === "permission_required") {
        throw new BrowserAccessRequiredError(
          MY_LIBRARY_ENTRY_URL,
          library.origin,
          library.pattern,
          approvalKey,
          disclosure,
        );
      }
      if (library.status === "reauth_required") {
        throw new Error(
          "My Libraryを開きました。ログイン後、もう一度質問してください。",
        );
      }
      const projection = library.status === "known" ? library.projection : null;
      if (
        library.status !== "known" ||
        !isMyLibraryReadResult(projection) ||
        !("scope" in projection) ||
        projection.scope !== requestedScope
      ) {
        throw new Error("My Libraryの利用状況を読み取れませんでした。");
      }
      const expectedItemCount = Math.min(
        requestedLimit,
        Math.max(projection.total_count - requestedOffset, 0),
      );
      const expectedNextOffset =
        requestedOffset + expectedItemCount < projection.total_count
          ? requestedOffset + expectedItemCount
          : null;
      if (
        projection.items.length !== expectedItemCount ||
        projection.next_offset !== expectedNextOffset
      ) {
        throw new Error("My Libraryの利用状況を読み取れませんでした。");
      }
      setLocalMyLibraryDetails((items) => ({
        ...items,
        [activity.id]: library.detail,
      }));
      request = toolResultRequest(call.tool_call_id, call.name, projection);
      sensitiveApproval.current.delete(approvalKey);
    } else if (call.name === "cast_read") {
      const access = hostAccessRequest(CAST_ENTRY_URL);
      if (!access) throw new Error("CASTの参照先URLを検証できません。");
      const approvalKey = `${response.run_id}:${call.tool_call_id}:cast-derived`;
      const disclosure =
        "CASTのトップ画面を端末内で読み取り、お知らせ件数・新着求人件数・新着インターン件数・新着説明会件数・相談予約の有無・直近掲載日だけを選択中のAIへ送ります。お知らせ本文、進路希望、応募履歴、氏名は送信しません。";
      if (!sensitiveApproval.current.has(approvalKey)) {
        throw new BrowserAccessRequiredError(
          CAST_ENTRY_URL,
          access.origin,
          access.pattern,
          approvalKey,
          disclosure,
        );
      }
      const cast = await sendExtensionMessage<CastReadResponse>({
        type: "cast-read",
        tool_call_id: call.tool_call_id,
      });
      if (cast.status === "permission_required") {
        throw new BrowserAccessRequiredError(
          CAST_ENTRY_URL,
          cast.origin,
          cast.pattern,
          approvalKey,
          disclosure,
        );
      }
      if (cast.status === "reauth_required") {
        throw new Error(
          "CASTを開きました。ログイン後、もう一度質問してください。",
        );
      }
      if (cast.status !== "known" || !isCastReadResult(cast.projection)) {
        throw new Error("CASTのトップ画面を読み取れませんでした。");
      }
      setLocalCastDetails((items) => ({
        ...items,
        [activity.id]: cast.detail,
      }));
      request = toolResultRequest(
        call.tool_call_id,
        call.name,
        cast.projection,
      );
      sensitiveApproval.current.delete(approvalKey);
    } else if (call.name === "cast_alumni_read") {
      const access = hostAccessRequest(CAST_ENTRY_URL);
      if (!access) throw new Error("CASTの参照先URLを検証できません。");
      const approvalKey = `${response.run_id}:${call.tool_call_id}:cast-alumni-derived`;
      const disclosure =
        "認証済みCAST画面を端末内で読み取り、回答可能テーマ・面談可能頻度・面談形式・匿名共有可能な知見のカテゴリと件数だけを選択中のAIへ送ります。氏名・連絡先・CAST内部ID・本文・ログイン情報は端末外へ送信しません。";
      if (!sensitiveApproval.current.has(approvalKey)) {
        throw new BrowserAccessRequiredError(
          CAST_ENTRY_URL,
          access.origin,
          access.pattern,
          approvalKey,
          disclosure,
        );
      }
      const alumni = await sendExtensionMessage<CastAlumniReadResponse>({
        type: "cast-alumni-read",
        tool_call_id: call.tool_call_id,
      });
      if (alumni.status === "permission_required") {
        throw new BrowserAccessRequiredError(
          CAST_ENTRY_URL,
          alumni.origin,
          alumni.pattern,
          approvalKey,
          disclosure,
        );
      }
      if (alumni.status === "reauth_required") {
        throw new Error(
          "CASTの就活サポーター画面を開いてログイン後、もう一度質問してください。",
        );
      }
      if (
        alumni.status !== "known" ||
        !isCastAlumniReadResult(alumni.projection)
      ) {
        throw new Error("CASTの就活サポーター情報を読み取れませんでした。");
      }
      setLocalCastAlumniDetails((items) => ({
        ...items,
        [activity.id]: alumni.detail,
      }));
      request = toolResultRequest(
        call.tool_call_id,
        call.name,
        alumni.projection,
      );
      sensitiveApproval.current.delete(approvalKey);
    } else {
      const url = argumentsObject.url as string;
      const access = hostAccessRequest(url);
      if (!access) throw new Error("参照先URLを検証できません。");
      const hasPermission = await containsOriginPermission(access.pattern);
      const allowedOrigins = hasPermission
        ? new Set([access.origin])
        : new Set<string>();
      if (
        requiresHostConfirmation(accessMode, access, allowedOrigins) &&
        !sensitiveApproval.current.has(url)
      ) {
        throw new BrowserAccessRequiredError(
          url,
          access.origin,
          access.pattern,
        );
      }
      const browser = await sendExtensionMessage<BrowserReadResponse>({
        type: "browser-read",
        tool_call_id: call.tool_call_id,
        url,
        access_mode: accessMode,
      });
      if (browser.status === "permission_required") {
        throw new BrowserAccessRequiredError(
          url,
          browser.origin,
          browser.pattern,
        );
      }
      if (
        browser.status !== "known" ||
        !isBrowserReadResult(browser.projection)
      ) {
        throw new Error("Webページを読み取れませんでした。");
      }
      request = toolResultRequest(
        call.tool_call_id,
        call.name,
        browser.projection,
      );
    }
    const nextResponse = await apiClient.submitChatToolResult(
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

  async function finishResponse(
    initialResponse: ChatRunResponse,
    initialConversation: ChatConversation,
    initialSeenCallIds = new Set<string>(),
  ): Promise<void> {
    let response = initialResponse;
    let current = initialConversation;
    const seenCallIds = initialSeenCallIds;
    try {
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
      if (
        caught instanceof BrowserAccessRequiredError &&
        response.status === "tool_required"
      ) {
        // The call is marked as seen before runTool() so a successful tool
        // response cannot be replayed accidentally. Permission checks throw
        // before the tool is executed, however, so remove this pending call
        // from the retry set and let the explicit permission action resume it.
        const retrySeenCallIds = new Set(seenCallIds);
        const pendingCall = response.calls[0];
        if (pendingCall) retrySeenCallIds.delete(pendingCall.tool_call_id);
        setPermissionPrompt({
          url: caught.url,
          origin: caught.origin,
          pattern: caught.pattern,
          response,
          conversation: current,
          seenCallIds: [...retrySeenCallIds],
          approvalKey: caught.approvalKey,
          disclosure: caught.disclosure,
        });
        setError("このサイトを読む前に、Chat内でアクセスを許可してください。");
        return;
      }
      throw caught;
    }
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
    const current = withUser;
    try {
      const response = await apiClient.startChat({
        conversation_id: withUser.conversationId,
        message,
        history: toChatHistory(beforeSend.messages),
        client_tools: clientTools(message),
      });
      await finishResponse(response, current);
    } catch (caught) {
      if (caught instanceof BrowserAccessRequiredError) return;
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

  async function continueWithPermission(remember: boolean): Promise<void> {
    const pending = permissionPrompt;
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    try {
      const granted = await requestOriginPermission(pending.pattern);
      if (!granted) {
        setError("サイトの読み取り許可が得られませんでした。");
        return;
      }
      const pendingTool = pending.response.calls[0]?.name;
      if (
        pendingTool === "my_library_read" ||
        (pendingTool === "library_action_options" &&
          pending.origin === MY_LIBRARY_ORIGIN)
      ) {
        const stored = await grantMyLibrarySessionConsent();
        if (!stored) {
          setError("My Libraryのsession consentを保存できませんでした。");
          return;
        }
      }
      sensitiveApproval.current.add(pending.approvalKey);
      setPermissionPrompt(null);
      await finishResponse(
        pending.response,
        pending.conversation,
        new Set(pending.seenCallIds),
      );
      // SCombZ is a required host permission so Chrome rejects removing it.
      // The sensitive approval itself is still scoped to this URL and is
      // cleared below, which keeps the next sensitive read confirmation-based.
      if (
        !remember &&
        pendingTool !== "my_library_read" &&
        (pendingTool === "browser_read_url" ||
          pendingTool === "library_catalog_search" ||
          pendingTool === "library_item_read" ||
          pendingTool === "library_catalog_browse" ||
          pendingTool === "library_discovery_search" ||
          pending.disclosure !== null) &&
        typeof chrome.permissions?.remove === "function"
      ) {
        await chrome.permissions.remove({ origins: [pending.pattern] });
      }
      sensitiveApproval.current.delete(pending.approvalKey);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "許可後のTool実行に失敗しました。",
      );
    } finally {
      setBusy(false);
    }
  }

  async function enableFullAccess(): Promise<void> {
    if (busy || disabled) return;
    const granted = await Promise.all([
      requestOriginPermission("https://*/*"),
      requestOriginPermission("http://*/*"),
    ]);
    if (!granted.every(Boolean)) {
      setError(
        "Full accessの権限を付与できませんでした。都度確認を使用します。",
      );
      setAccessMode("ask");
      globalThis.localStorage?.setItem("sit-orbit-access-mode", "ask");
      return;
    }
    setAccessMode("full");
    globalThis.localStorage?.setItem("sit-orbit-access-mode", "full");
  }

  function useAskMode(): void {
    setAccessMode("ask");
    globalThis.localStorage?.setItem("sit-orbit-access-mode", "ask");
  }

  async function disconnectMyLibrary(): Promise<void> {
    await clearMyLibrarySessionConsent();
    await sendExtensionMessage<{ ok: boolean }>({
      type: MESSAGE_TYPES.myLibraryDisconnect,
    });
    sensitiveApproval.current.clear();
    setError("My Libraryの共有同意を解除しました。次回は再確認が必要です。");
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

  async function requestLibraryActionPreview(
    messageId: string,
    proposal: ActionProposal,
  ): Promise<void> {
    const operation = proposal.operation;
    if (!operation) return;
    setLibraryPreviewStates((states) => ({
      ...states,
      [messageId]: "previewing",
    }));
    setLibraryPreviewErrors((errors) => {
      const next = { ...errors };
      delete next[messageId];
      return next;
    });
    try {
      const result = await sendExtensionMessage<LibraryActionPreviewResponse>({
        type: MESSAGE_TYPES.libraryActionPreview,
        tool_call_id: `proposal-${messageId}`,
        operation,
      });
      if (result.status !== "ready") {
        setLibraryPreviewStates((states) => ({
          ...states,
          [messageId]: "unavailable",
        }));
        setLibraryPreviewErrors((errors) => ({
          ...errors,
          [messageId]:
            result.status === "permission_required"
              ? "公式ページの権限が必要です。"
              : result.reason_code,
        }));
        return;
      }
      setLibraryPreviews((previews) => ({ ...previews, [messageId]: result }));
      setLibraryPreviewInputs((values) => ({
        ...values,
        [messageId]: result.inputs,
      }));
      setLibraryPreviewStates((states) => ({
        ...states,
        [messageId]: "previewing",
      }));
    } catch {
      setLibraryPreviewStates((states) => ({
        ...states,
        [messageId]: "unavailable",
      }));
      setLibraryPreviewErrors((errors) => ({
        ...errors,
        [messageId]: "公式ページを再確認できませんでした。",
      }));
    }
  }

  function updateLibraryPreviewInput(
    messageId: string,
    key:
      | "pickup_campus"
      | "reason"
      | "receiver"
      | "payment"
      | "fee"
      | "page_range",
    value: string,
  ): void {
    const current = libraryPreviewInputs[messageId];
    if (!current) return;
    switch (current.action_type) {
      case "reserve":
      case "intercampus_transfer":
        if (key !== "pickup_campus") return;
        setLibraryPreviewInputs((values) => ({
          ...values,
          [messageId]: {
            action_type: current.action_type,
            values: { pickup_campus: value as "omiya" | "toyosu" },
          },
        }));
        return;
      case "purchase_request":
        if (key !== "reason") return;
        setLibraryPreviewInputs((values) => ({
          ...values,
          [messageId]: {
            action_type: current.action_type,
            values: { reason: value },
          },
        }));
        return;
      case "ill_loan":
        if (key !== "receiver" && key !== "payment" && key !== "fee") return;
        setLibraryPreviewInputs((values) => ({
          ...values,
          [messageId]: {
            action_type: "ill_loan",
            values: {
              ...current.values,
              [key]: value,
            },
          },
        }));
        return;
      case "ill_copy":
        if (
          key !== "receiver" &&
          key !== "payment" &&
          key !== "fee" &&
          key !== "page_range"
        )
          return;
        setLibraryPreviewInputs((values) => ({
          ...values,
          [messageId]: {
            action_type: "ill_copy",
            values: {
              ...current.values,
              [key]: value,
            },
          },
        }));
        return;
      case "visit_shelf":
      case "open_online":
      case "renew":
        return;
    }
  }

  async function submitLibraryAction(
    messageId: string,
    preview: Extract<LibraryActionPreviewResponse, { status: "ready" }>,
  ): Promise<void> {
    if (libraryPreviewStates[messageId] === "submitting") return;
    const inputs = libraryPreviewInputs[messageId] ?? preview.inputs;
    setLibraryPreviewStates((states) => ({
      ...states,
      [messageId]: "submitting",
    }));
    try {
      const result = await sendExtensionMessage<LibraryActionSubmitResponse>({
        type: MESSAGE_TYPES.libraryActionSubmit,
        tool_call_id: `proposal-${messageId}`,
        preview_id: preview.preview_id,
        inputs,
        confirmation_label:
          preview.action_type === "visit_shelf" ||
          preview.action_type === "open_online"
            ? "公式ページを開く"
            : "この内容で送信",
      });
      if (result.status !== "verified") {
        setLibraryPreviewStates((states) => ({
          ...states,
          [messageId]: "unavailable",
        }));
        setLibraryPreviewErrors((errors) => ({
          ...errors,
          [messageId]: result.reason_code,
        }));
        return;
      }
      setLibraryPreviewStates((states) => ({
        ...states,
        [messageId]: "verified",
      }));
    } catch {
      setLibraryPreviewStates((states) => ({
        ...states,
        [messageId]: "unavailable",
      }));
      setLibraryPreviewErrors((errors) => ({
        ...errors,
        [messageId]: "公式ページの状態を再確認できませんでした。",
      }));
    }
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
    if (state === "approved") {
      const approved = conversation.messages.find(
        (message) => message.id === messageId,
      );
      if (approved?.proposal?.operation) {
        await requestLibraryActionPreview(messageId, approved.proposal);
      }
    }
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
            onClick={useAskMode}
          >
            都度確認
          </button>
          <button
            type="button"
            aria-pressed={accessMode === "full"}
            onClick={() => void enableFullAccess()}
          >
            Full access
          </button>
        </div>
        <small>
          {accessMode === "ask" ? "読み取り前に確認します" : "読み取り専用"}
        </small>
        <small>
          一般Web検索を使う場合、公開情報の検索語はGrounding with
          Bingへ送信され、Azureの通常の地理・DPA境界外で処理されます。
        </small>
        <details className="chat-connection-settings">
          <summary>My Library接続設定</summary>
          <p>
            My
            Libraryでは、明示的な接続・許可後に、opaque参照、書名、著者、状態、
            返却期限、延長可否、活動日、申請種別だけをAzure
            Agentへ共有できます。 raw snapshotは端末メモリだけに置きます。
          </p>
          <p>
            Agent回答に現れた書名はローカルChat履歴へ残ります。会話ごとの削除または
            「すべて削除」で削除できます。Full accessだけではMy
            Libraryへの共有同意に
            ならず、切断またはセッション終了で同意は無効になります。
          </p>
          <button
            type="button"
            className="text-button"
            onClick={() => void disconnectMyLibrary()}
          >
            My Libraryの共有同意を解除
          </button>
        </details>
      </fieldset>

      {permissionPrompt ? (
        <aside className="chat-permission-prompt" role="alert">
          <strong>サイトの読み取り許可</strong>
          {permissionPrompt.disclosure ? (
            <p>
              {permissionPrompt.origin}
              {permissionPrompt.response.calls[0]?.name === "my_library_read"
                ? "をこのブラウザセッション中、必要なTool実行で参照します。"
                : "を今回のTool実行で参照します。"}
              {permissionPrompt.disclosure}
            </p>
          ) : (
            <p>
              {permissionPrompt.origin}
              を今回のTool実行で参照します。ページの表示情報だけを使い、送信・変更は行いません。
            </p>
          )}
          <div className="button-row">
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void continueWithPermission(false)}
            >
              {permissionPrompt.response.calls[0]?.name === "my_library_read"
                ? "このセッションで許可"
                : "今回だけ許可"}
            </button>
            {!permissionPrompt.disclosure ? (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void continueWithPermission(true)}
              >
                このサイトを常に許可
              </button>
            ) : null}
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => {
                setPermissionPrompt(null);
                setError("サイトの読み取りを拒否しました。");
              }}
            >
              拒否
            </button>
          </div>
        </aside>
      ) : null}

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
              {message.role === "tool" && localMoodleDetails[message.id] ? (
                <div className="chat-local-detail">
                  <strong>端末内のMoodle詳細</strong>
                  <p>
                    コース:{" "}
                    {localMoodleDetails[message.id]?.courses.join("、") ||
                      "なし"}
                  </p>
                  <ul>
                    {localMoodleDetails[message.id]?.upcoming.map((item) => (
                      <li key={`${item.title}-${item.due_at ?? "none"}`}>
                        {item.course ? `${item.course}: ` : ""}
                        {item.title}
                        {item.due_at ? `（期限: ${item.due_at}）` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {message.role === "tool" && localMyLibraryDetails[message.id] ? (
                <div className="chat-local-detail">
                  <strong>端末内のMy Library詳細</strong>
                  <ul>
                    {localMyLibraryDetails[message.id]?.loans.map((loan) => (
                      <li key={`${loan.title}-${loan.due_date ?? "none"}`}>
                        貸出: {loan.title}
                        {loan.author ? ` / ${loan.author}` : ""}
                        {loan.due_date ? `（返却期限: ${loan.due_date}）` : ""}
                        {loan.overdue ? "（延滞）" : ""}
                      </li>
                    ))}
                    {localMyLibraryDetails[message.id]?.reservations.map(
                      (reservation) => (
                        <li
                          key={`${reservation.title}-${reservation.hold_until ?? "none"}`}
                        >
                          予約: {reservation.title}
                          {reservation.author ? ` / ${reservation.author}` : ""}
                          {reservation.status
                            ? `（${reservation.status}）`
                            : ""}
                          {reservation.hold_until
                            ? `（取置期限: ${reservation.hold_until}）`
                            : ""}
                        </li>
                      ),
                    )}
                    {(
                      [
                        [
                          "貸出履歴",
                          localMyLibraryDetails[message.id]?.loan_history ?? [],
                        ],
                        [
                          "購入依頼",
                          localMyLibraryDetails[message.id]
                            ?.purchase_requests ?? [],
                        ],
                        [
                          "ILL依頼",
                          localMyLibraryDetails[message.id]
                            ?.interlibrary_requests ?? [],
                        ],
                      ] as const
                    ).map(([label, items]) =>
                      items.length > 0 ? (
                        <li key={label}>
                          <strong>{label}</strong>
                          <ul>
                            {items.map((item) => (
                              <li
                                key={`${item.title}-${item.activity_date ?? item.due_date ?? "none"}`}
                              >
                                {item.title}
                                {item.author ? ` / ${item.author}` : ""}
                                {item.status ? `（${item.status}）` : ""}
                                {item.activity_date
                                  ? `（日付: ${item.activity_date}）`
                                  : ""}
                                {item.due_date
                                  ? `（期限: ${item.due_date}）`
                                  : ""}
                              </li>
                            ))}
                          </ul>
                        </li>
                      ) : null,
                    )}
                  </ul>
                </div>
              ) : null}
              {message.role === "tool" && localCastDetails[message.id] ? (
                <div className="chat-local-detail">
                  <strong>端末内のCAST詳細</strong>
                  <ul>
                    {localCastDetails[message.id]?.notices.map((notice) => (
                      <li
                        key={`${notice.title}-${notice.published_date ?? "none"}`}
                      >
                        {notice.published_date
                          ? `${notice.published_date}: `
                          : ""}
                        {notice.title}
                      </li>
                    ))}
                  </ul>
                  <p>
                    新着求人: {localCastDetails[message.id]?.new_job_count}件 /
                    インターン:
                    {localCastDetails[message.id]?.new_internship_count}件 /
                    説明会: {localCastDetails[message.id]?.new_event_count}件
                  </p>
                  <p>
                    相談予約:
                    {localCastDetails[message.id]?.has_counseling_reservation
                      ? "あり"
                      : "なし"}
                  </p>
                </div>
              ) : null}
              {message.role === "tool" && localCastAlumniDetails[message.id] ? (
                <div className="chat-local-detail">
                  <strong>端末内のCAST就活サポーター詳細</strong>
                  <p>
                    参照ページ: {localCastAlumniDetails[message.id]?.page_path}
                  </p>
                  <ul>
                    {localCastAlumniDetails[message.id]?.profiles.map(
                      (profile) => (
                        <li key={profile.local_id}>
                          {profile.display_name ?? "氏名は端末内でマスク"}
                          {profile.answerable_topics.length > 0
                            ? ` / テーマ: ${profile.answerable_topics.join(", ")}`
                            : ""}
                          {profile.availability_frequency !== "unknown"
                            ? ` / 頻度: ${profile.availability_frequency}`
                            : ""}
                          {profile.meeting_modes.length > 0
                            ? ` / 形式: ${profile.meeting_modes.join(", ")}`
                            : ""}
                          {profile.shareable_insights.length > 0
                            ? ` / 知見: ${profile.shareable_insights.join(", ")}`
                            : ""}
                          {profile.contact_present
                            ? " / 連絡先あり（値は非表示）"
                            : ""}
                        </li>
                      ),
                    )}
                  </ul>
                  {(localCastAlumniDetails[message.id]?.discovered_links
                    .length ?? 0) > 0 ? (
                    <p>
                      CAST上の関連リンクを検出しました。リンク先を開いてから、再度確認できます。
                    </p>
                  ) : null}
                </div>
              ) : null}
              {message.evidence && message.evidence.length > 0 ? (
                <div className="chat-citations">
                  <strong>参照</strong>
                  <ul>
                    {message.evidence.map((item) => (
                      <li key={item.evidence_id}>
                        {item.source_type === "web" &&
                        /^https?:\/\//.test(item.locator) ? (
                          <a
                            href={item.locator}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {item.title}
                          </a>
                        ) : (
                          item.title
                        )}
                      </li>
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
                  {message.proposalState === "approved" &&
                  message.proposal.operation ? (
                    <div className="library-action-confirmation">
                      {libraryPreviewStates[message.id] === "previewing" &&
                      !libraryPreviews[message.id] ? (
                        <p className="state-message">
                          公式ページを再確認してプレビューを作成中…
                        </p>
                      ) : null}
                      {libraryPreviewErrors[message.id] ? (
                        <p className="state-message" role="alert">
                          送信不可: {libraryPreviewErrors[message.id]}
                        </p>
                      ) : null}
                      {libraryPreviews[message.id] ? (
                        <>
                          <strong>公式ページで確認した内容</strong>
                          {libraryPreviews[message.id]?.official.title ? (
                            <p>
                              資料:{" "}
                              {libraryPreviews[message.id]?.official.title}
                            </p>
                          ) : null}
                          {(libraryPreviews[message.id]?.official.holdings
                            .length ?? 0) > 0 ? (
                            <ul>
                              {libraryPreviews[
                                message.id
                              ]?.official.holdings.map((holding) => (
                                <li
                                  key={`${holding.campus}-${holding.location ?? ""}-${holding.call_number ?? ""}`}
                                >
                                  {holding.campus} ·{" "}
                                  {holding.location ?? "場所不明"} ·{" "}
                                  {holding.call_number ?? "請求記号不明"}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          {libraryPreviewInputs[message.id]?.action_type ===
                            "reserve" ||
                          libraryPreviewInputs[message.id]?.action_type ===
                            "intercampus_transfer" ? (
                            <label>
                              受取キャンパス
                              <select
                                value={editableInputValue(
                                  libraryPreviewInputs[message.id],
                                  "pickup_campus",
                                )}
                                onChange={(event) => {
                                  const current =
                                    libraryPreviewInputs[message.id];
                                  if (
                                    !current ||
                                    (current.action_type !== "reserve" &&
                                      current.action_type !==
                                        "intercampus_transfer")
                                  ) {
                                    return;
                                  }
                                  updateLibraryPreviewInput(
                                    message.id,
                                    "pickup_campus",
                                    event.target.value,
                                  );
                                }}
                              >
                                <option value="omiya">大宮</option>
                                <option value="toyosu">豊洲</option>
                              </select>
                            </label>
                          ) : null}
                          {libraryPreviewInputs[message.id]?.action_type ===
                          "purchase_request" ? (
                            <label>
                              購入理由
                              <textarea
                                maxLength={500}
                                value={editableInputValue(
                                  libraryPreviewInputs[message.id],
                                  "reason",
                                )}
                                onChange={(event) => {
                                  const current =
                                    libraryPreviewInputs[message.id];
                                  if (
                                    current?.action_type !== "purchase_request"
                                  )
                                    return;
                                  updateLibraryPreviewInput(
                                    message.id,
                                    "reason",
                                    event.target.value,
                                  );
                                }}
                              />
                            </label>
                          ) : null}
                          {libraryPreviewInputs[message.id]?.action_type ===
                            "ill_loan" ||
                          libraryPreviewInputs[message.id]?.action_type ===
                            "ill_copy" ? (
                            <>
                              <label>
                                受取人
                                <input
                                  maxLength={200}
                                  value={editableInputValue(
                                    libraryPreviewInputs[message.id],
                                    "receiver",
                                  )}
                                  onChange={(event) => {
                                    const current =
                                      libraryPreviewInputs[message.id];
                                    if (
                                      !current ||
                                      (current.action_type !== "ill_loan" &&
                                        current.action_type !== "ill_copy")
                                    )
                                      return;
                                    updateLibraryPreviewInput(
                                      message.id,
                                      "receiver",
                                      event.target.value,
                                    );
                                  }}
                                />
                              </label>
                              <label>
                                支払方法
                                <input
                                  maxLength={100}
                                  value={editableInputValue(
                                    libraryPreviewInputs[message.id],
                                    "payment",
                                  )}
                                  onChange={(event) => {
                                    const current =
                                      libraryPreviewInputs[message.id];
                                    if (
                                      !current ||
                                      (current.action_type !== "ill_loan" &&
                                        current.action_type !== "ill_copy")
                                    )
                                      return;
                                    updateLibraryPreviewInput(
                                      message.id,
                                      "payment",
                                      event.target.value,
                                    );
                                  }}
                                />
                              </label>
                              <label>
                                手数料（不明なら空欄）
                                <input
                                  maxLength={100}
                                  value={editableInputValue(
                                    libraryPreviewInputs[message.id],
                                    "fee",
                                  )}
                                  onChange={(event) => {
                                    const current =
                                      libraryPreviewInputs[message.id];
                                    if (
                                      !current ||
                                      (current.action_type !== "ill_loan" &&
                                        current.action_type !== "ill_copy")
                                    )
                                      return;
                                    updateLibraryPreviewInput(
                                      message.id,
                                      "fee",
                                      event.target.value,
                                    );
                                  }}
                                />
                              </label>
                              {libraryPreviewInputs[message.id]?.action_type ===
                              "ill_copy" ? (
                                <label>
                                  ページ範囲
                                  <input
                                    maxLength={100}
                                    value={editableInputValue(
                                      libraryPreviewInputs[message.id],
                                      "page_range",
                                    )}
                                    onChange={(event) => {
                                      const current =
                                        libraryPreviewInputs[message.id];
                                      if (current?.action_type !== "ill_copy")
                                        return;
                                      updateLibraryPreviewInput(
                                        message.id,
                                        "page_range",
                                        event.target.value,
                                      );
                                    }}
                                  />
                                </label>
                              ) : null}
                            </>
                          ) : null}
                          {libraryPreviewStates[message.id] === "verified" ? (
                            <p className="state-message success-message">
                              公式ページを開きました。
                            </p>
                          ) : (
                            <button
                              type="button"
                              className="primary-button"
                              disabled={
                                libraryPreviewStates[message.id] ===
                                "submitting"
                              }
                              onClick={() => {
                                const preview = libraryPreviews[message.id];
                                if (preview) {
                                  void submitLibraryAction(message.id, preview);
                                }
                              }}
                            >
                              {libraryPreviewStates[message.id] === "submitting"
                                ? "確認中…"
                                : libraryPreviews[message.id]?.action_type ===
                                      "visit_shelf" ||
                                    libraryPreviews[message.id]?.action_type ===
                                      "open_online"
                                  ? "公式ページを開く"
                                  : "この内容で送信"}
                            </button>
                          )}
                        </>
                      ) : null}
                    </div>
                  ) : null}
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
