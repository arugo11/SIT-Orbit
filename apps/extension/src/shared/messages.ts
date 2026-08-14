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

export type ExtensionMessage =
  | { type: typeof MESSAGE_TYPES.getPageContext }
  | { type: typeof MESSAGE_TYPES.requestPageContext }
  | {
      type: typeof MESSAGE_TYPES.pageContextUpdated;
      context: PageContext | null;
    }
  | CalendarCommandMessage;

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
