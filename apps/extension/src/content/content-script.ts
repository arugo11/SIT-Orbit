import { isRequestPageContextMessage, MESSAGE_TYPES } from "../shared/messages";
import {
  CAST_ALUMNI_INTERNAL_MESSAGE,
  extractCastAlumniPage,
} from "./cast-alumni-reader";
import { parseScombzPageContext } from "./page-context";

function readPageContext() {
  return parseScombzPageContext(
    {
      title: document.title,
      url: window.location.href,
    },
    document,
  );
}

function reportPageContext(): void {
  const message = {
    type: MESSAGE_TYPES.pageContextUpdated,
    context: readPageContext(),
  } as const;

  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

function reportPageContextAfterNavigation(): void {
  // The Navigation API fires before the new URL is observable from location.
  window.setTimeout(reportPageContext, 0);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === CAST_ALUMNI_INTERNAL_MESSAGE
  ) {
    sendResponse(extractCastAlumniPage(document, window.location.href));
    return;
  }
  if (!isRequestPageContextMessage(message)) {
    return;
  }

  sendResponse(readPageContext());
});

reportPageContext();

window.addEventListener("hashchange", reportPageContext);
window.addEventListener("popstate", reportPageContext);

const navigation = (window as Window & { navigation?: EventTarget }).navigation;
navigation?.addEventListener("navigate", reportPageContextAfterNavigation);
