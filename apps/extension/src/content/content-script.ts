import { isRequestPageContextMessage, MESSAGE_TYPES } from "../shared/messages";
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
