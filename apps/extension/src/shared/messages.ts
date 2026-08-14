import type { PageContext } from "../content/page-context";

export const MESSAGE_TYPES = {
  getPageContext: "get-page-context",
  requestPageContext: "request-page-context",
  pageContextUpdated: "page-context-updated",
} as const;

export type ExtensionMessage =
  | { type: typeof MESSAGE_TYPES.getPageContext }
  | { type: typeof MESSAGE_TYPES.requestPageContext }
  | { type: typeof MESSAGE_TYPES.pageContextUpdated; context: PageContext };

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
  context: PageContext;
} {
  if (!isRecord(message) || message.type !== MESSAGE_TYPES.pageContextUpdated) {
    return false;
  }

  return isPageContext(message.context);
}

export function isPageContext(value: unknown): value is PageContext {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.title === "string" &&
    typeof value.url === "string" &&
    typeof value.kind === "string"
  );
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
