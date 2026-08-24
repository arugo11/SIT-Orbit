import {
  isCastCareerSearchMessage,
  isCastSearchMessage,
  isRequestPageContextMessage,
  isScombzSourceIdentityMessage,
  isScombzStudentReadMessage,
  MESSAGE_TYPES,
} from "../shared/messages";
import {
  CAST_ALUMNI_INTERNAL_MESSAGE,
  extractCastAlumniPage,
} from "./cast-alumni-reader";
import { handleCastCareerInternalMessage } from "./cast-career-source-runtime";
import { runCastSearch } from "./cast-search-api";
import { parseScombzPageContext } from "./page-context";
import {
  CONTENT_SCRIPT_GENERATION,
  readScombzStudent,
  ADAPTER_VERSION as SCOMBZ_ADAPTER_VERSION,
} from "./scombz-student-reader";

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

function isAuthenticatedScombzPage(): boolean {
  const pathname = window.location.pathname;
  if (/^\/login(?:\/|$)/u.test(pathname)) return false;
  if (/login|ログイン|password/iu.test(document.title)) return false;
  // The authenticated SCombZ shell exposes a Logout link.  Requiring this
  // visible, same-origin affordance keeps an audit source from being treated
  // as authenticated after a login redirect or an expired session page.
  return Boolean(
    document.querySelector(
      'a[href*="/logout"], form[action*="/logout"], [data-testid="logout"]',
    ),
  );
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
  if (isCastSearchMessage(message)) {
    const { type: _type, tool_call_id: _toolCallId, ...request } = message;
    void runCastSearch(request).then(sendResponse);
    return true;
  }
  if (isScombzSourceIdentityMessage(message)) {
    sendResponse({
      generation: CONTENT_SCRIPT_GENERATION,
      adapter_version: SCOMBZ_ADAPTER_VERSION,
      authenticated: isAuthenticatedScombzPage(),
    });
    return;
  }
  if (isScombzStudentReadMessage(message)) {
    void readScombzStudent(message).then(sendResponse);
    return true;
  }
  if (isCastCareerSearchMessage(message)) {
    const { type: _type, tool_call_id: _toolCallId, ...request } = message;
    void handleCastCareerInternalMessage(request).then(sendResponse);
    return true;
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
