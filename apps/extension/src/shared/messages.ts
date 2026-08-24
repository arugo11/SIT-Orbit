import type {
  LibraryCatalogBrowseResult,
  LibraryCatalogSearchResult,
  LibraryDiscoverySearchResult,
  LibraryItemReadResult,
} from "../api/client";
import { isLibraryOperation, type LibraryOperation } from "../api/client";
import { isOpaqueDriveSelectionId } from "../connectors/google-drive";
import {
  isLibraryActionEditableInputs,
  type LibraryActionEditableInputs,
  type LibraryActionPreviewOfficial,
} from "../connectors/library-actions";
import type {
  LibraryCatalogBrowseArguments,
  LibraryCatalogSearchArguments,
  LibraryDiscoverySearchArguments,
} from "../connectors/library-discovery";
import { isLibraryResourceRef } from "../connectors/library-discovery";
import {
  type CastSearchAgentProjection,
  type CastSearchLocalKnownResult,
  type CastSearchLocalResult,
  type CastSearchRequest,
  isCastSearchRequest,
} from "../content/cast-search-api";
import type { MyLibraryScope } from "../content/my-library-reader";
import {
  classifyPageKind,
  type PageContext,
  type ScombzAnnouncement,
  type ScombzCalendar,
  type ScombzCourse,
  type ScombzLink,
  type ScombzPageData,
  type ScombzRoute,
  type ScombzTask,
  type ScombzTimetableItem,
} from "../content/page-context";
import type { StableAgentLoopSnapshot } from "../sidepanel/loop-state";
import type { WorkspaceSession, WorkspaceStatus } from "./workspace-session";

export const MESSAGE_TYPES = {
  getPageContext: "get-page-context",
  requestPageContext: "request-page-context",
  pageContextUpdated: "page-context-updated",
  calendarConnect: "calendar-connect",
  calendarRefresh: "calendar-refresh",
  calendarReauthenticate: "calendar-reauthenticate",
  calendarDisconnect: "calendar-disconnect",
  driveSelect: "drive-select",
  driveRead: "drive-read",
  driveDeselect: "drive-deselect",
  driveRefresh: "drive-refresh",
  openWorkspace: "open-workspace",
  getWorkspaceSession: "get-workspace-session",
  updateWorkspaceSession: "update-workspace-session",
  getWorkspaceStatus: "get-workspace-status",
  workspaceOwnershipChanged: "workspace-ownership-changed",
  workspaceSourceUnavailable: "workspace-source-unavailable",
  browserRead: "browser-read",
  syllabusSearch: "syllabus-search",
  sitrusRead: "sitrus-read",
  moodleRead: "moodle-read",
  moodleOpen: "moodle-open",
  myLibraryRead: "my-library-read",
  myLibraryDisconnect: "my-library-disconnect",
  myLibraryOpen: "my-library-open",
  castRead: "cast-read",
  castOpen: "cast-open",
  castAlumniRead: "cast-alumni-read",
  castSearch: "cast-search",
  libraryCatalogSearch: "library-catalog-search",
  libraryItemRead: "library-item-read",
  libraryCatalogBrowse: "library-catalog-browse",
  libraryDiscoverySearch: "library-discovery-search",
  libraryActionOptions: "library-action-options",
  libraryActionPreview: "library-action-preview",
  libraryActionSubmit: "library-action-submit",
} as const;

export interface OpenWorkspaceMessage {
  type: typeof MESSAGE_TYPES.openWorkspace;
  stable_state: StableAgentLoopSnapshot;
}

export interface GetWorkspaceSessionMessage {
  type: typeof MESSAGE_TYPES.getWorkspaceSession;
  session_id: string;
}

export interface UpdateWorkspaceSessionMessage {
  type: typeof MESSAGE_TYPES.updateWorkspaceSession;
  session_id: string;
  stable_state: StableAgentLoopSnapshot;
}

export interface GetWorkspaceStatusMessage {
  type: typeof MESSAGE_TYPES.getWorkspaceStatus;
}

export interface WorkspaceOwnershipChangedMessage {
  type: typeof MESSAGE_TYPES.workspaceOwnershipChanged;
  active: boolean;
  session: WorkspaceSession;
}

export interface WorkspaceSourceUnavailableMessage {
  type: typeof MESSAGE_TYPES.workspaceSourceUnavailable;
  session_id: string;
}

export interface BrowserReadMessage {
  type: typeof MESSAGE_TYPES.browserRead;
  tool_call_id: string;
  url: string;
}

export type BrowserReadResponse =
  | {
      status: "known";
      projection: import("../content/browser-reader").BrowserReadProjection;
    }
  | {
      status: "permission_required";
      origin: string;
      pattern: string;
    }
  | {
      status: "unavailable";
      reason_code: string;
    };

export interface SyllabusSearchMessage {
  type: typeof MESSAGE_TYPES.syllabusSearch;
  tool_call_id: string;
  query: string;
  year?: number | null;
  faculty?: string | null;
}

export interface SitrusReadMessage {
  type: typeof MESSAGE_TYPES.sitrusRead;
  tool_call_id: string;
  page_url: string;
}

export type SitrusReadResponse =
  | { status: "known"; projection: unknown }
  | { status: "permission_required"; origin: string; pattern: string }
  | { status: "unavailable"; reason_code: string };

export interface MoodleReadMessage {
  type: typeof MESSAGE_TYPES.moodleRead;
  tool_call_id: string;
}

export interface MoodleOpenMessage {
  type: typeof MESSAGE_TYPES.moodleOpen;
}

export type MoodleReadResponse =
  | {
      status: "known";
      projection: unknown;
      detail: import("../content/moodle-reader").MoodleLocalSnapshot;
    }
  | { status: "permission_required"; origin: string; pattern: string }
  | { status: "reauth_required"; reason_code: string }
  | { status: "unavailable"; reason_code: string };

export interface MyLibraryReadMessage {
  type: typeof MESSAGE_TYPES.myLibraryRead;
  tool_call_id: string;
  /** Optional for the legacy aggregate call; new calls always provide scope. */
  scope?: MyLibraryScope;
  query?: string | null;
  offset?: number;
  limit?: number;
}

export interface MyLibraryOpenMessage {
  type: typeof MESSAGE_TYPES.myLibraryOpen;
}

export interface MyLibraryDisconnectMessage {
  type: typeof MESSAGE_TYPES.myLibraryDisconnect;
}

export type MyLibraryReadResponse =
  | {
      status: "known";
      projection: unknown;
      detail: import("../content/my-library-reader").MyLibraryLocalSnapshot;
    }
  | { status: "permission_required"; origin: string; pattern: string }
  | { status: "reauth_required"; reason_code: string }
  | { status: "unavailable"; reason_code: string };

export interface CastReadMessage {
  type: typeof MESSAGE_TYPES.castRead;
  tool_call_id: string;
}

export interface CastOpenMessage {
  type: typeof MESSAGE_TYPES.castOpen;
}

export interface CastAlumniReadMessage {
  type: typeof MESSAGE_TYPES.castAlumniRead;
  tool_call_id: string;
}

export interface CastSearchMessage extends CastSearchRequest {
  type: typeof MESSAGE_TYPES.castSearch;
  tool_call_id: string;
}

export type CastSearchResponse =
  | {
      status: "known";
      local: CastSearchLocalKnownResult;
      projection: CastSearchAgentProjection;
    }
  | Exclude<CastSearchLocalResult, { status: "known" }>;

export interface LibraryCatalogSearchMessage
  extends Omit<LibraryCatalogSearchArguments, "limit"> {
  type: typeof MESSAGE_TYPES.libraryCatalogSearch;
  tool_call_id: string;
  limit?: number;
}

export interface LibraryItemReadMessage {
  type: typeof MESSAGE_TYPES.libraryItemRead;
  tool_call_id: string;
  resource_ref: string;
  /**
   * Public OPAC record URL carried by the local Context Manifest.  It lets a
   * restarted service worker re-derive and verify the opaque reference
   * without persisting the internal record id.
   */
  record_url?: string;
}

export interface LibraryCatalogBrowseMessage
  extends LibraryCatalogBrowseArguments {
  type: typeof MESSAGE_TYPES.libraryCatalogBrowse;
  tool_call_id: string;
}

export interface LibraryDiscoverySearchMessage
  extends LibraryDiscoverySearchArguments {
  type: typeof MESSAGE_TYPES.libraryDiscoverySearch;
  tool_call_id: string;
}

export interface LibraryActionOptionsMessage {
  type: typeof MESSAGE_TYPES.libraryActionOptions;
  tool_call_id: string;
  resource_ref: string;
}

export interface LibraryActionPreviewMessage {
  type: typeof MESSAGE_TYPES.libraryActionPreview;
  tool_call_id: string;
  operation: LibraryOperation;
}

export interface LibraryActionSubmitMessage {
  type: typeof MESSAGE_TYPES.libraryActionSubmit;
  tool_call_id: string;
  preview_id: string;
  inputs: LibraryActionEditableInputs;
  confirmation_label: "この内容で送信" | "公式ページを開く";
}

export type LibraryCatalogSearchResponse =
  | { status: "known"; projection: LibraryCatalogSearchResult }
  | { status: "permission_required"; origin: string; pattern: string }
  | { status: "unavailable"; reason_code: string };

export type LibraryItemReadResponse =
  | { status: "known"; projection: LibraryItemReadResult }
  | { status: "permission_required"; origin: string; pattern: string }
  | { status: "unavailable"; reason_code: string };

export type LibraryCatalogBrowseResponse =
  | { status: "known"; projection: LibraryCatalogBrowseResult }
  | { status: "permission_required"; origin: string; pattern: string }
  | { status: "unavailable"; reason_code: string };

export type LibraryDiscoverySearchResponse =
  | { status: "known"; projection: LibraryDiscoverySearchResult }
  | { status: "permission_required"; origin: string; pattern: string }
  | { status: "unavailable"; reason_code: string };

export type LibraryActionOptionsResponse =
  | {
      status: "known";
      projection: import("../api/client").LibraryActionOptionsResult;
    }
  | { status: "permission_required"; origin: string; pattern: string }
  | { status: "reauth_required"; reason_code: string }
  | { status: "unavailable"; reason_code: string };

export type LibraryActionPreviewResponse =
  | {
      status: "ready";
      preview_id: string;
      action_type: LibraryOperation["action_type"];
      official: LibraryActionPreviewOfficial;
      inputs: LibraryActionEditableInputs;
    }
  | { status: "reauth_required"; reason_code: string }
  | { status: "permission_required"; origin: string; pattern: string }
  | { status: "unavailable"; reason_code: string };

export type LibraryActionSubmitResponse =
  | { status: "verified"; action_type: LibraryOperation["action_type"] }
  | { status: "expired"; reason_code: string }
  | { status: "unavailable"; reason_code: string };

export type CastReadResponse =
  | {
      status: "known";
      projection: unknown;
      detail: import("../content/cast-reader").CastLocalSnapshot;
    }
  | { status: "permission_required"; origin: string; pattern: string }
  | { status: "reauth_required"; reason_code: string }
  | { status: "unavailable"; reason_code: string };

export type CastAlumniReadResponse =
  | {
      status: "known";
      projection: import("../content/cast-alumni-reader").CastAlumniAgentProjection;
      detail: import("../content/cast-alumni-reader").CastAlumniLocalSnapshot;
    }
  | { status: "permission_required"; origin: string; pattern: string }
  | { status: "reauth_required"; reason_code: string }
  | { status: "unavailable"; reason_code: string };

export interface OpenWorkspaceResponse {
  ok: boolean;
  session?: WorkspaceSession;
  error?: string;
}

export type WorkspaceSessionResponse =
  | { ok: true; session: WorkspaceSession }
  | { ok: false; error: string };

export type WorkspaceStatusResponse = WorkspaceStatus;

export type CalendarCommand =
  | "connect"
  | "refresh"
  | "reauthenticate"
  | "disconnect";

export type CalendarCommandMessage =
  | { type: typeof MESSAGE_TYPES.calendarConnect }
  | { type: typeof MESSAGE_TYPES.calendarRefresh }
  | { type: typeof MESSAGE_TYPES.calendarReauthenticate }
  | { type: typeof MESSAGE_TYPES.calendarDisconnect };

export type DriveCommand = "select" | "read" | "deselect" | "refresh";

export type DriveCommandMessage =
  | { type: typeof MESSAGE_TYPES.driveSelect }
  | {
      type: typeof MESSAGE_TYPES.driveRead;
      selection_id: string;
    }
  | {
      type: typeof MESSAGE_TYPES.driveDeselect;
      selection_id: string;
    }
  | { type: typeof MESSAGE_TYPES.driveRefresh };

export type ExtensionMessage =
  | { type: typeof MESSAGE_TYPES.getPageContext }
  | { type: typeof MESSAGE_TYPES.requestPageContext }
  | {
      type: typeof MESSAGE_TYPES.pageContextUpdated;
      context: PageContext | null;
    }
  | CalendarCommandMessage
  | DriveCommandMessage
  | OpenWorkspaceMessage
  | GetWorkspaceSessionMessage
  | UpdateWorkspaceSessionMessage
  | GetWorkspaceStatusMessage
  | WorkspaceOwnershipChangedMessage
  | WorkspaceSourceUnavailableMessage
  | BrowserReadMessage
  | SyllabusSearchMessage
  | SitrusReadMessage
  | MoodleReadMessage
  | MoodleOpenMessage
  | MyLibraryReadMessage
  | MyLibraryDisconnectMessage
  | MyLibraryOpenMessage
  | CastReadMessage
  | CastOpenMessage
  | CastAlumniReadMessage
  | CastSearchMessage
  | LibraryCatalogSearchMessage
  | LibraryItemReadMessage
  | LibraryCatalogBrowseMessage
  | LibraryDiscoverySearchMessage
  | LibraryActionOptionsMessage
  | LibraryActionPreviewMessage
  | LibraryActionSubmitMessage;

export function isBrowserReadMessage(
  message: unknown,
): message is BrowserReadMessage {
  return (
    isRecord(message) &&
    message.type === MESSAGE_TYPES.browserRead &&
    typeof message.tool_call_id === "string" &&
    message.tool_call_id.length > 0 &&
    typeof message.url === "string"
  );
}

export function isSyllabusSearchMessage(
  message: unknown,
): message is SyllabusSearchMessage {
  return (
    isRecord(message) &&
    message.type === MESSAGE_TYPES.syllabusSearch &&
    typeof message.tool_call_id === "string" &&
    message.tool_call_id.length > 0 &&
    typeof message.query === "string" &&
    message.query.trim().length > 0 &&
    (message.year === undefined ||
      message.year === null ||
      typeof message.year === "number") &&
    (message.faculty === undefined ||
      message.faculty === null ||
      typeof message.faculty === "string")
  );
}

export function isSitrusReadMessage(
  message: unknown,
): message is SitrusReadMessage {
  return (
    isRecord(message) &&
    message.type === MESSAGE_TYPES.sitrusRead &&
    typeof message.tool_call_id === "string" &&
    message.tool_call_id.length > 0 &&
    typeof message.page_url === "string" &&
    /^https:\/\/sitrus\.sic\.shibaura-it\.ac\.jp\/SITRUS\/login\/(?:SeisekiTsutiSho|ShutokuTaniShukei)\.html(?:\?|#|$)/u.test(
      message.page_url,
    )
  );
}

export function isMoodleReadMessage(
  message: unknown,
): message is MoodleReadMessage {
  return (
    isRecord(message) &&
    message.type === MESSAGE_TYPES.moodleRead &&
    typeof message.tool_call_id === "string" &&
    message.tool_call_id.length > 0
  );
}

export function isMoodleOpenMessage(
  message: unknown,
): message is MoodleOpenMessage {
  return isMessageType(message, MESSAGE_TYPES.moodleOpen);
}

export function isMyLibraryReadMessage(
  message: unknown,
): message is MyLibraryReadMessage {
  if (
    !isRecord(message) ||
    message.type !== MESSAGE_TYPES.myLibraryRead ||
    typeof message.tool_call_id !== "string" ||
    message.tool_call_id.length === 0 ||
    Object.keys(message).some(
      (key) =>
        !["type", "tool_call_id", "scope", "query", "offset", "limit"].includes(
          key,
        ),
    )
  ) {
    return false;
  }
  if (
    message.scope !== undefined &&
    message.scope !== "current_loans" &&
    message.scope !== "reservations" &&
    message.scope !== "loan_history" &&
    message.scope !== "purchase_requests" &&
    message.scope !== "interlibrary_requests"
  ) {
    return false;
  }
  if (
    message.query !== undefined &&
    message.query !== null &&
    (typeof message.query !== "string" || message.query.length > 200)
  ) {
    return false;
  }
  if (
    message.offset !== undefined &&
    (typeof message.offset !== "number" ||
      !Number.isInteger(message.offset) ||
      message.offset < 0 ||
      message.offset > 1000)
  ) {
    return false;
  }
  return (
    message.limit === undefined ||
    (typeof message.limit === "number" &&
      Number.isInteger(message.limit) &&
      message.limit >= 1 &&
      message.limit <= 20)
  );
}

export function isMyLibraryOpenMessage(
  message: unknown,
): message is MyLibraryOpenMessage {
  return isMessageType(message, MESSAGE_TYPES.myLibraryOpen);
}

export function isMyLibraryDisconnectMessage(
  message: unknown,
): message is MyLibraryDisconnectMessage {
  return isMessageType(message, MESSAGE_TYPES.myLibraryDisconnect);
}

export function isCastReadMessage(
  message: unknown,
): message is CastReadMessage {
  return (
    isRecord(message) &&
    message.type === MESSAGE_TYPES.castRead &&
    typeof message.tool_call_id === "string" &&
    message.tool_call_id.length > 0
  );
}

export function isCastOpenMessage(
  message: unknown,
): message is CastOpenMessage {
  return isMessageType(message, MESSAGE_TYPES.castOpen);
}

export function isCastAlumniReadMessage(
  message: unknown,
): message is CastAlumniReadMessage {
  return (
    isRecord(message) &&
    message.type === MESSAGE_TYPES.castAlumniRead &&
    typeof message.tool_call_id === "string" &&
    message.tool_call_id.length > 0
  );
}

export function isCastSearchMessage(
  message: unknown,
): message is CastSearchMessage {
  if (!isRecord(message) || message.type !== MESSAGE_TYPES.castSearch)
    return false;
  if (
    typeof message.tool_call_id !== "string" ||
    message.tool_call_id.length === 0
  )
    return false;
  if (
    Object.keys(message).some(
      (key) =>
        ![
          "type",
          "tool_call_id",
          "kind",
          "filters",
          "sort",
          "cursor",
          "exhaustive",
        ].includes(key),
    )
  ) {
    return false;
  }
  const request = {
    kind: message.kind,
    filters: message.filters,
    sort: message.sort,
    cursor: message.cursor,
    exhaustive: message.exhaustive,
  };
  return isCastSearchRequest(request);
}

export function isLibraryCatalogSearchMessage(
  message: unknown,
): message is LibraryCatalogSearchMessage {
  if (
    !isRecord(message) ||
    message.type !== MESSAGE_TYPES.libraryCatalogSearch ||
    typeof message.tool_call_id !== "string" ||
    !message.tool_call_id ||
    typeof message.query !== "string" ||
    !message.query.trim() ||
    message.query.length > 200
  ) {
    return false;
  }
  if (
    message.author !== undefined &&
    message.author !== null &&
    (typeof message.author !== "string" || message.author.length > 200)
  ) {
    return false;
  }
  if (
    message.subject !== undefined &&
    message.subject !== null &&
    (typeof message.subject !== "string" || message.subject.length > 200)
  ) {
    return false;
  }
  if (
    message.isbn !== undefined &&
    message.isbn !== null &&
    (typeof message.isbn !== "string" || message.isbn.length > 32)
  ) {
    return false;
  }
  if (
    message.pub_year !== undefined &&
    message.pub_year !== null &&
    (typeof message.pub_year !== "number" ||
      !Number.isInteger(message.pub_year) ||
      message.pub_year < 1000 ||
      message.pub_year > 2100)
  ) {
    return false;
  }
  if (
    message.campus !== undefined &&
    message.campus !== "toyosu" &&
    message.campus !== "omiya" &&
    message.campus !== "any"
  ) {
    return false;
  }
  if (
    message.format !== undefined &&
    message.format !== "book" &&
    message.format !== "journal" &&
    message.format !== "ebook" &&
    message.format !== "any"
  ) {
    return false;
  }
  return (
    message.limit === undefined ||
    (typeof message.limit === "number" &&
      Number.isInteger(message.limit) &&
      message.limit >= 1 &&
      message.limit <= 10)
  );
}

export function isLibraryItemReadMessage(
  message: unknown,
): message is LibraryItemReadMessage {
  if (
    isRecord(message) &&
    message.type === MESSAGE_TYPES.libraryItemRead &&
    typeof message.tool_call_id === "string" &&
    message.tool_call_id.length > 0 &&
    isLibraryResourceRef(message.resource_ref)
  ) {
    if (message.record_url === undefined) return true;
    if (typeof message.record_url !== "string") return false;
    try {
      const url = new URL(message.record_url);
      return (
        url.protocol === "https:" &&
        url.origin === "https://library.shibaura-it.ac.jp" &&
        url.pathname.startsWith("/opc/recordID/catalog.bib/") &&
        url.pathname.slice("/opc/recordID/catalog.bib/".length).length > 0 &&
        url.search === "" &&
        url.hash === "" &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  }
  return false;
}

export function isLibraryCatalogBrowseMessage(
  message: unknown,
): message is LibraryCatalogBrowseMessage {
  return (
    isRecord(message) &&
    message.type === MESSAGE_TYPES.libraryCatalogBrowse &&
    typeof message.tool_call_id === "string" &&
    message.tool_call_id.length > 0 &&
    (message.kind === "new_books" || message.kind === "loan_ranking") &&
    (message.campus === undefined ||
      message.campus === "toyosu" ||
      message.campus === "omiya" ||
      message.campus === "any") &&
    (message.limit === undefined ||
      (typeof message.limit === "number" &&
        Number.isInteger(message.limit) &&
        message.limit >= 1 &&
        message.limit <= 10))
  );
}

export function isLibraryDiscoverySearchMessage(
  message: unknown,
): message is LibraryDiscoverySearchMessage {
  return (
    isRecord(message) &&
    message.type === MESSAGE_TYPES.libraryDiscoverySearch &&
    typeof message.tool_call_id === "string" &&
    message.tool_call_id.length > 0 &&
    typeof message.query === "string" &&
    message.query.trim().length > 0 &&
    message.query.length <= 200 &&
    (message.limit === undefined ||
      (typeof message.limit === "number" &&
        Number.isInteger(message.limit) &&
        message.limit >= 1 &&
        message.limit <= 10))
  );
}

export function isLibraryActionOptionsMessage(
  message: unknown,
): message is LibraryActionOptionsMessage {
  return (
    isRecord(message) &&
    message.type === MESSAGE_TYPES.libraryActionOptions &&
    typeof message.tool_call_id === "string" &&
    message.tool_call_id.length > 0 &&
    isLibraryResourceRef(message.resource_ref)
  );
}

const LIBRARY_PREVIEW_ID_PATTERN =
  /^orbit-library:\/\/preview\/[A-Za-z0-9_-]{16,128}$/u;

export function isLibraryActionPreviewMessage(
  message: unknown,
): message is LibraryActionPreviewMessage {
  return (
    isRecord(message) &&
    Object.keys(message).length === 3 &&
    Object.keys(message).every((key) =>
      ["type", "tool_call_id", "operation"].includes(key),
    ) &&
    message.type === MESSAGE_TYPES.libraryActionPreview &&
    typeof message.tool_call_id === "string" &&
    message.tool_call_id.length > 0 &&
    isLibraryOperation(message.operation)
  );
}

export function isLibraryActionSubmitMessage(
  message: unknown,
): message is LibraryActionSubmitMessage {
  return (
    isRecord(message) &&
    message.type === MESSAGE_TYPES.libraryActionSubmit &&
    typeof message.tool_call_id === "string" &&
    message.tool_call_id.length > 0 &&
    typeof message.preview_id === "string" &&
    LIBRARY_PREVIEW_ID_PATTERN.test(message.preview_id) &&
    isRecord(message.inputs) &&
    typeof message.inputs.action_type === "string" &&
    isLibraryActionEditableInputs(
      message.inputs.action_type as LibraryOperation["action_type"],
      message.inputs,
    ) &&
    (message.confirmation_label === "この内容で送信" ||
      message.confirmation_label === "公式ページを開く")
  );
}

export function isOpenWorkspaceMessage(
  message: unknown,
): message is OpenWorkspaceMessage {
  return (
    isRecord(message) &&
    message.type === MESSAGE_TYPES.openWorkspace &&
    isStableAgentLoopSnapshot(message.stable_state)
  );
}

export function isGetWorkspaceSessionMessage(
  message: unknown,
): message is GetWorkspaceSessionMessage {
  return (
    isRecord(message) &&
    message.type === MESSAGE_TYPES.getWorkspaceSession &&
    typeof message.session_id === "string"
  );
}

export function isUpdateWorkspaceSessionMessage(
  message: unknown,
): message is UpdateWorkspaceSessionMessage {
  return (
    isRecord(message) &&
    message.type === MESSAGE_TYPES.updateWorkspaceSession &&
    typeof message.session_id === "string" &&
    isStableAgentLoopSnapshot(message.stable_state)
  );
}

export function isGetWorkspaceStatusMessage(
  message: unknown,
): message is GetWorkspaceStatusMessage {
  return isMessageType(message, MESSAGE_TYPES.getWorkspaceStatus);
}

export function isWorkspaceOwnershipChangedMessage(
  message: unknown,
): message is WorkspaceOwnershipChangedMessage {
  return (
    isRecord(message) &&
    message.type === MESSAGE_TYPES.workspaceOwnershipChanged &&
    typeof message.active === "boolean" &&
    isRecord(message.session)
  );
}

export function isWorkspaceSourceUnavailableMessage(
  message: unknown,
): message is WorkspaceSourceUnavailableMessage {
  return (
    isRecord(message) &&
    message.type === MESSAGE_TYPES.workspaceSourceUnavailable &&
    typeof message.session_id === "string"
  );
}

function isStableAgentLoopSnapshot(
  value: unknown,
): value is StableAgentLoopSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.status === "idle" ||
      value.status === "proposed" ||
      value.status === "approved" ||
      value.status === "rejected" ||
      value.status === "completed" ||
      value.status === "error") &&
    (value.proposal === null || isRecord(value.proposal)) &&
    (value.completionEvent === null || isRecord(value.completionEvent)) &&
    typeof value.changeNote === "string" &&
    (value.error === null || typeof value.error === "string")
  );
}

export function isGetPageContextMessage(message: unknown): message is {
  type: typeof MESSAGE_TYPES.getPageContext;
} {
  return isMessageType(message, MESSAGE_TYPES.getPageContext);
}

export function isRequestPageContextMessage(message: unknown): message is {
  type: typeof MESSAGE_TYPES.requestPageContext;
} {
  return isMessageType(message, MESSAGE_TYPES.requestPageContext);
}

export function isPageContextUpdatedMessage(message: unknown): message is {
  type: typeof MESSAGE_TYPES.pageContextUpdated;
  context: PageContext | null;
} {
  if (!isRecord(message) || message.type !== MESSAGE_TYPES.pageContextUpdated) {
    return false;
  }

  return message.context === null || isPageContext(message.context);
}

export function isCalendarCommandMessage(
  message: unknown,
): message is CalendarCommandMessage {
  return (
    isRecord(message) &&
    (message.type === MESSAGE_TYPES.calendarConnect ||
      message.type === MESSAGE_TYPES.calendarRefresh ||
      message.type === MESSAGE_TYPES.calendarReauthenticate ||
      message.type === MESSAGE_TYPES.calendarDisconnect)
  );
}

export function isDriveCommandMessage(
  message: unknown,
): message is DriveCommandMessage {
  if (!isRecord(message) || typeof message.type !== "string") {
    return false;
  }

  switch (message.type) {
    case MESSAGE_TYPES.driveSelect:
    case MESSAGE_TYPES.driveRefresh:
      return Object.keys(message).length === 1;
    case MESSAGE_TYPES.driveRead:
    case MESSAGE_TYPES.driveDeselect:
      return (
        Object.keys(message).length === 2 &&
        isOpaqueDriveSelectionId(message.selection_id)
      );
    default:
      return false;
  }
}

export function driveCommandMessage(
  command: DriveCommand,
  selectionId?: string,
): DriveCommandMessage {
  switch (command) {
    case "select":
      return { type: MESSAGE_TYPES.driveSelect };
    case "refresh":
      return { type: MESSAGE_TYPES.driveRefresh };
    case "read":
      if (!isOpaqueDriveSelectionId(selectionId)) {
        throw new TypeError("Drive read requires an opaque selection ID.");
      }
      return { type: MESSAGE_TYPES.driveRead, selection_id: selectionId };
    case "deselect":
      if (!isOpaqueDriveSelectionId(selectionId)) {
        throw new TypeError("Drive deselect requires an opaque selection ID.");
      }
      return { type: MESSAGE_TYPES.driveDeselect, selection_id: selectionId };
  }
}

export function calendarCommandMessage(
  command: CalendarCommand,
): CalendarCommandMessage {
  switch (command) {
    case "connect":
      return { type: MESSAGE_TYPES.calendarConnect };
    case "refresh":
      return { type: MESSAGE_TYPES.calendarRefresh };
    case "reauthenticate":
      return { type: MESSAGE_TYPES.calendarReauthenticate };
    case "disconnect":
      return { type: MESSAGE_TYPES.calendarDisconnect };
  }
}

export function isPageContext(value: unknown): value is PageContext {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.title === "string" &&
    typeof value.url === "string" &&
    (value.kind === "scombz" || value.kind === "other")
  ) {
    if (classifyPageKind(value.url) !== value.kind) {
      return false;
    }

    return (
      !("scombz" in value) ||
      (value.kind === "scombz" && isScombzPageData(value.scombz))
    );
  }

  return false;
}

function isScombzPageData(value: unknown): value is ScombzPageData {
  if (!isRecord(value) || !isScombzRoute(value.route)) {
    return false;
  }

  return (
    Array.isArray(value.tasks) &&
    value.tasks.every(isScombzTask) &&
    Array.isArray(value.announcements) &&
    value.announcements.every(isScombzAnnouncement) &&
    isScombzCalendar(value.calendar) &&
    (value.currentCourse === null || isScombzCourse(value.currentCourse)) &&
    Array.isArray(value.relatedLinks) &&
    value.relatedLinks.every(isScombzLink) &&
    (value.timetable === undefined ||
      (Array.isArray(value.timetable) &&
        value.timetable.every(isScombzTimetableItem)))
  );
}

function isScombzRoute(value: unknown): value is ScombzRoute {
  return (
    value === "home" ||
    value === "tasks" ||
    value === "timetable" ||
    value === "announcements" ||
    value === "calendar" ||
    value === "course" ||
    value === "other"
  );
}

function isScombzTask(value: unknown): value is ScombzTask {
  return (
    isRecord(value) &&
    typeof value.course === "string" &&
    typeof value.title === "string" &&
    typeof value.deadline === "string" &&
    isNullableSafeHttpUrl(value.url)
  );
}

function isScombzAnnouncement(value: unknown): value is ScombzAnnouncement {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    isNullableSafeHttpUrl(value.url)
  );
}

function isScombzCalendar(value: unknown): value is ScombzCalendar {
  return (
    isRecord(value) &&
    isNullableSafeHttpUrl(value.googleCalendarUrl) &&
    isNullableSafeHttpUrl(value.icsUrl)
  );
}

function isScombzCourse(value: unknown): value is ScombzCourse {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    isSafeHttpUrl(value.url)
  );
}

function isScombzLink(value: unknown): value is ScombzLink {
  return (
    isRecord(value) &&
    typeof value.label === "string" &&
    isSafeHttpUrl(value.url)
  );
}

function isScombzTimetableItem(value: unknown): value is ScombzTimetableItem {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    (value.startsAt === null || typeof value.startsAt === "string") &&
    (value.endsAt === null || typeof value.endsAt === "string") &&
    (value.status === "class" ||
      value.status === "cancelled" ||
      value.status === "makeup" ||
      value.status === "unknown")
  );
}

function isNullableSafeHttpUrl(value: unknown): value is string | null {
  return value === null || isSafeHttpUrl(value);
}

function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isMessageType(
  message: unknown,
  type: ExtensionMessage["type"],
): boolean {
  return isRecord(message) && message.type === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
