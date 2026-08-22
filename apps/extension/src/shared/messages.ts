import { isOpaqueDriveSelectionId } from "../connectors/google-drive";
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
  access_mode: "ask" | "full";
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
  | MoodleOpenMessage;

export function isBrowserReadMessage(
  message: unknown,
): message is BrowserReadMessage {
  return (
    isRecord(message) &&
    message.type === MESSAGE_TYPES.browserRead &&
    typeof message.tool_call_id === "string" &&
    message.tool_call_id.length > 0 &&
    typeof message.url === "string" &&
    (message.access_mode === "ask" || message.access_mode === "full")
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
