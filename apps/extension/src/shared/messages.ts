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
} from "../content/page-context";

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
} as const;

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
  | DriveCommandMessage;

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
    value.relatedLinks.every(isScombzLink)
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
