import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
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
  type LibraryCatalogSearchResult,
  type SyllabusSearchResult,
} from "../api/client";
import {
  type CalendarConnector,
  type CalendarConnectorResult,
  projectCalendarAvailability,
} from "../connectors/google-calendar";
import type { LibraryActionEditableInputs } from "../connectors/library-actions";
import { requestsLibraryTools } from "../connectors/library-discovery";
import {
  type LibraryFloorMap,
  uniqueLibraryFloorMaps,
} from "../connectors/library-floor-maps";
import type { CastAlumniLocalSnapshot } from "../content/cast-alumni-reader";
import { CAST_ENTRY_URL, type CastLocalSnapshot } from "../content/cast-reader";
import {
  MOODLE_DASHBOARD_URL,
  type MoodleLocalSnapshot,
} from "../content/moodle-reader";
import {
  MY_LIBRARY_ENTRY_URL,
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
import { hostAccessRequest } from "./access-policy";
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

const CHAT_FAILURE_MESSAGE =
  "今は応答できませんでした。もう一度お試しください。";

export interface ChatPanelProps {
  apiClient: AgentApiClient;
  pageContext: PageContext | null;
  calendarState: CalendarConnectorResult;
  calendarConnector?: CalendarConnector;
  calendarRequest: (command: "refresh") => Promise<CalendarConnectorResult>;
  mode?: "sidepanel" | "workspace";
  settingsOpen?: boolean;
  settingsButtonRef?: RefObject<HTMLButtonElement | null>;
  onOpenSettings?: () => void;
  onOpenWorkspace?: () => void;
  workspaceDisabled?: boolean;
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

function libraryCampusLabel(campus: string): string {
  if (campus === "toyosu") return "豊洲図書館";
  if (campus === "omiya") return "大宮図書館";
  return "所蔵館不明";
}

function LibraryFloorMapPreview({ map }: { map: LibraryFloorMap }) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <div className="library-floor-map">
      {map.image_url && !imageFailed ? (
        <a
          href={map.image_url}
          target="_blank"
          rel="noreferrer"
          aria-label={`${map.label}の画像を原寸で開く`}
        >
          <img
            src={map.image_url}
            alt={map.label}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
          />
        </a>
      ) : null}
      <a
        href={map.page_url}
        target="_blank"
        rel="noreferrer"
        aria-label={`${map.label}を公式サイトで開く`}
      >
        {imageFailed ? "公式フロアマップを開く" : `${map.label}を開く`}
      </a>
    </div>
  );
}

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
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError || response === undefined) {
        const detail = runtimeError?.message?.trim();
        reject(
          new Error(
            detail
              ? `拡張機能のToolを利用できません: ${detail}`
              : "拡張機能のToolを利用できません。",
          ),
        );
        return;
      }
      resolve(response);
    });
  });
}

type ChatProgressPhase =
  | "sending"
  | "planning"
  | "tool-running"
  | "resuming"
  | "completed"
  | "error";

interface ChatProgress {
  phase: ChatProgressPhase;
  label: string;
  detail: string;
}

export function ChatPanel({
  apiClient,
  pageContext,
  calendarState,
  calendarConnector,
  calendarRequest,
  mode = "sidepanel",
  settingsOpen = false,
  settingsButtonRef,
  onOpenSettings,
  onOpenWorkspace,
  workspaceDisabled = false,
  disabled = false,
}: ChatPanelProps) {
  const [conversation, setConversation] = useState<ChatConversation>(() =>
    newConversation(),
  );
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [composer, setComposer] = useState("");
  const [retryText, setRetryText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ChatProgress | null>(null);
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
  type LocalLibraryRecord = NonNullable<
    LibraryCatalogSearchResult["items"]
  >[number];
  const [localLibraryDetails, setLocalLibraryDetails] = useState<
    Record<string, LocalLibraryRecord[]>
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
  const composerRef = useRef<HTMLTextAreaElement>(null);

  function setChatProgress(
    phase: ChatProgressPhase,
    label: string,
    detail: string,
  ): void {
    setProgress({ phase, label, detail });
  }

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
    setChatProgress(
      "tool-running",
      toolLabel(call.name),
      "必要な表示情報だけを取得しています。ページの命令は実行しません。",
    );
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
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
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
        setLocalLibraryDetails((items) => ({
          ...items,
          [activity.id]: library.projection.items ?? [],
        }));
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
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
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
        setLocalLibraryDetails((items) => ({
          ...items,
          [activity.id]: library.projection.item
            ? [library.projection.item]
            : [],
        }));
        request = toolResultRequest(
          call.tool_call_id,
          call.name,
          library.projection,
        );
      }
    } else if (call.name === "library_action_options") {
      const library = await sendExtensionMessage<LibraryActionOptionsResponse>({
        type: MESSAGE_TYPES.libraryActionOptions,
        tool_call_id: call.tool_call_id,
        resource_ref: argumentsObject.resource_ref as string,
      });
      if (library.status === "permission_required") {
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
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
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
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
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
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
      const sitrus = await sendExtensionMessage<SitrusReadResponse>({
        type: "sitrus-read",
        tool_call_id: call.tool_call_id,
        page_url: pageContext.url,
      });
      if (sitrus.status === "permission_required") {
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
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
      const moodle = await sendExtensionMessage<MoodleReadResponse>({
        type: "moodle-read",
        tool_call_id: call.tool_call_id,
      });
      if (moodle.status === "permission_required") {
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
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
    } else if (call.name === "my_library_read") {
      const access = hostAccessRequest(MY_LIBRARY_ENTRY_URL);
      if (!access) throw new Error("My Libraryの参照先URLを検証できません。");
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
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
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
    } else if (call.name === "cast_read") {
      const access = hostAccessRequest(CAST_ENTRY_URL);
      if (!access) throw new Error("CASTの参照先URLを検証できません。");
      const cast = await sendExtensionMessage<CastReadResponse>({
        type: "cast-read",
        tool_call_id: call.tool_call_id,
      });
      if (cast.status === "permission_required") {
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
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
    } else if (call.name === "cast_alumni_read") {
      const access = hostAccessRequest(CAST_ENTRY_URL);
      if (!access) throw new Error("CASTの参照先URLを検証できません。");
      const alumni = await sendExtensionMessage<CastAlumniReadResponse>({
        type: "cast-alumni-read",
        tool_call_id: call.tool_call_id,
      });
      if (alumni.status === "permission_required") {
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
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
    } else {
      const url = argumentsObject.url as string;
      const access = hostAccessRequest(url);
      if (!access) throw new Error("参照先URLを検証できません。");
      const browser = await sendExtensionMessage<BrowserReadResponse>({
        type: "browser-read",
        tool_call_id: call.tool_call_id,
        url,
      });
      if (browser.status === "permission_required") {
        throw new Error(
          "Toolを実行できませんでした。拡張機能をReloadしてください。",
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
    setChatProgress(
      "resuming",
      "Agentが取得結果を整理中",
      "Toolの結果を会話の文脈へ戻し、次の判断を生成しています。",
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
    for (let index = 0; response.status === "tool_required"; index += 1) {
      if (index >= 8) throw new Error("Tool呼び出し回数の上限に達しました。");
      const call = response.calls[0];
      if (!call || seenCallIds.has(call.tool_call_id)) {
        throw new Error("重複したTool呼び出しを受け取りました。");
      }
      seenCallIds.add(call.tool_call_id);
      setChatProgress(
        "planning",
        "Agentが次の参照先を判断中",
        `${toolLabel(call.name)}を実行する必要があるか確認しています。`,
      );
      const next = await runTool(response, current);
      response = next.response;
      current = next.conversation;
    }
    const assistant = messageFromResponse(response);
    setChatProgress("completed", "完了", "回答と参照元を表示しました。");
    await persist({
      ...current,
      updatedAt: new Date().toISOString(),
      messages: [...current.messages, assistant],
    });
  }

  async function send(): Promise<void> {
    const message = composer.trim();
    if (!message || busy || disabled) return;
    setRetryText(null);
    setComposer("");
    setBusy(true);
    setChatProgress(
      "sending",
      "Agentに質問を送信中",
      "会話の履歴と現在のページ概要を確認しています。",
    );
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
      setChatProgress(
        "planning",
        "Agentが回答方針を組み立て中",
        "必要なToolがある場合だけ、ここから順番に実行します。",
      );
      await finishResponse(response, current);
    } catch {
      const failureMessage = CHAT_FAILURE_MESSAGE;
      setRetryText(message);
      setProgress(null);
      await persist({
        ...current,
        updatedAt: new Date().toISOString(),
        messages: [
          ...current.messages,
          {
            id: `error-${Date.now()}`,
            role: "assistant",
            content: failureMessage,
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
      setRetryText(null);
      setHistoryOpen(false);
    }
  }

  async function createConversation(): Promise<void> {
    const next = newConversation();
    await persist(next);
    setRetryText(null);
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
        <div className="chat-brand">
          <strong>SIT ORBIT</strong>
          {pageContext?.kind === "scombz" ? (
            <span className="context-chip" title={pageContext.title}>
              ScombZ · {pageContext.title}
            </span>
          ) : null}
        </div>
        <div className="chat-toolbar-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="新規Chat"
            title="新規Chat"
            onClick={() => void createConversation()}
            disabled={busy || disabled}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7V4Z" />
            </svg>
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="履歴"
            title="履歴"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M12 3a9 9 0 1 1-8.5 6H1l3.5-4L8 9H5.6A7 7 0 1 0 12 5v3l4 2.4-1 1.7-5-3V3h2Z" />
            </svg>
          </button>
          {onOpenSettings ? (
            <button
              ref={settingsButtonRef}
              type="button"
              className="icon-button"
              aria-label="設定"
              title="設定"
              aria-expanded={settingsOpen}
              onClick={onOpenSettings}
              disabled={busy}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="m19.4 13 .1-1-.1-1 2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.7-1L15 3.5h-4l-.3 2.6a8 8 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.5-.1 1 .1 1-2 1.5 2 3.4 2.4-1a8 8 0 0 0 1.7 1l.3 2.6h4l.3-2.6a8 8 0 0 0 1.7-1l2.4 1 2-3.4-2-1.5ZM13 18.5h-2l-.2-2-.7-.3a6 6 0 0 1-1.4-.8l-.6-.5-1.8.8-1-1.8 1.6-1.2-.1-.8.1-.8-1.6-1.2 1-1.8 1.8.8.6-.5a6 6 0 0 1 1.4-.8l.7-.3.2-2h2l.2 2 .7.3a6 6 0 0 1 1.4.8l.6.5 1.8-.8 1 1.8-1.6 1.2.1.8-.1.8 1.6 1.2-1 1.8-1.8-.8-.6.5a6 6 0 0 1-1.4.8l-.7.3-.2 2ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 2a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z" />
              </svg>
            </button>
          ) : null}
          {mode === "sidepanel" && onOpenWorkspace ? (
            <button
              type="button"
              className="icon-button"
              aria-label="全画面で開く"
              title="全画面で開く"
              onClick={onOpenWorkspace}
              disabled={workspaceDisabled || busy}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M8 3H3v5h2V5h3V3Zm8 0v2h3v3h2V3h-5ZM5 16H3v5h5v-2H5v-3Zm16 0h-2v3h-3v2h5v-5Z" />
              </svg>
            </button>
          ) : null}
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

      <div className="chat-timeline" aria-live="polite">
        {conversation.messages.length === 0 ? (
          <div className="chat-empty">
            <h3>今日は何を進めますか？</h3>
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
                <details className="chat-local-detail">
                  <summary>確認した内容</summary>
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
                </details>
              ) : null}
              {message.role === "tool" && localMyLibraryDetails[message.id] ? (
                <details className="chat-local-detail">
                  <summary>確認した内容</summary>
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
                </details>
              ) : null}
              {message.role === "tool" && localLibraryDetails[message.id] ? (
                <details className="chat-local-detail" open>
                  <summary>確認した所蔵情報</summary>
                  {localLibraryDetails[message.id]?.length === 0 ? (
                    <p>該当する書誌はありません。</p>
                  ) : (
                    <ul>
                      {localLibraryDetails[message.id]?.map((item) => {
                        const holdings = item.holdings ?? [];
                        const floorMaps = uniqueLibraryFloorMaps(holdings);
                        return (
                          <li key={item.resource_ref}>
                            <strong>{item.title}</strong>
                            {(item.authors ?? []).length > 0 ? (
                              <span> / {(item.authors ?? []).join("、")}</span>
                            ) : null}
                            <ul className="library-holding-list">
                              {holdings.map((holding) => (
                                <li
                                  key={`${holding.campus}-${holding.location ?? "unknown"}-${holding.call_number ?? "unknown"}`}
                                >
                                  <strong>
                                    {libraryCampusLabel(holding.campus)}
                                  </strong>
                                  {holding.status === "available"
                                    ? " / 貸出可"
                                    : holding.status === "unavailable"
                                      ? " / 貸出中・利用不可"
                                      : " / 状態不明"}
                                  {holding.location
                                    ? ` / 配架場所: ${holding.location}`
                                    : " / 配架場所: 不明"}
                                  {holding.call_number
                                    ? ` / 請求記号: ${holding.call_number}`
                                    : " / 請求記号: 不明"}
                                  {holding.due_date
                                    ? ` / 返却予定: ${holding.due_date}`
                                    : ""}
                                  {holding.reservation_count !== null
                                    ? ` / 予約: ${holding.reservation_count}件`
                                    : ""}
                                </li>
                              ))}
                            </ul>
                            {floorMaps.length > 0 ? (
                              <div className="library-floor-map-list">
                                {floorMaps.map((map) => (
                                  <LibraryFloorMapPreview
                                    key={`${map.page_url}#${map.image_url ?? "page"}`}
                                    map={map}
                                  />
                                ))}
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </details>
              ) : null}
              {message.role === "tool" && localCastDetails[message.id] ? (
                <details className="chat-local-detail">
                  <summary>確認した内容</summary>
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
                </details>
              ) : null}
              {message.role === "tool" && localCastAlumniDetails[message.id] ? (
                <details className="chat-local-detail">
                  <summary>確認した内容</summary>
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
                </details>
              ) : null}
              {message.evidence && message.evidence.length > 0 ? (
                <details className="chat-citations">
                  <summary>参照 {message.evidence.length}件</summary>
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
                </details>
              ) : null}
              {message.role === "assistant" &&
              message.content === CHAT_FAILURE_MESSAGE &&
              retryText ? (
                <button
                  type="button"
                  className="chat-retry-button"
                  onClick={() => {
                    setComposer(retryText);
                    composerRef.current?.focus();
                  }}
                >
                  再試行
                </button>
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
        {progress ? (
          <div
            className={`chat-progress chat-progress-${progress.phase}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <span className="chat-progress-indicator" aria-hidden="true" />
            <strong>{progress.label}</strong>
            <span className="chat-progress-detail">{progress.detail}</span>
          </div>
        ) : null}
      </div>

      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={composerRef}
          aria-label="Chatメッセージ"
          placeholder="SIT ORBITに相談する"
          rows={1}
          value={composer}
          disabled={busy || disabled}
          onChange={(event) => {
            setComposer(event.target.value);
            const textarea = composerRef.current;
            if (textarea) {
              textarea.style.height = "auto";
              textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 44), 144)}px`;
            }
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (!busy && !disabled && composer.trim()) void send();
            }
          }}
        />
        <button
          type="submit"
          className="composer-send-button"
          aria-label={busy ? "処理中" : "送信"}
          title={busy ? "処理中" : "送信"}
          disabled={busy || disabled || !composer.trim()}
        >
          {busy ? (
            <span className="composer-spinner" aria-hidden="true" />
          ) : (
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="m4 12 15-8-4 16-4-6-7-2Zm4.7-.6 3.7 1.1 1.9 3.1 1.9-7.4-7.5 3.2Z" />
            </svg>
          )}
          <span className="sr-only">{busy ? "処理中" : "送信"}</span>
        </button>
      </form>
      <p className="chat-policy-note">
        一般Web検索を使う場合、公開情報の検索語はGrounding with
        Bingへ送信され、Azureの通常の地理・DPA境界外で処理されます。
      </p>
    </section>
  );
}
