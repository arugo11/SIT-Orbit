import { isScombzUrl, type PageContext } from "../content/page-context";
import {
  isGetPageContextMessage,
  isPageContextUpdatedMessage,
  MESSAGE_TYPES,
} from "../shared/messages";

async function setTabPanelEnabled(
  tabId: number,
  url: string | undefined,
): Promise<void> {
  try {
    await chrome.sidePanel.setOptions({
      tabId,
      path: "sidepanel.html",
      enabled: isScombzUrl(url),
    });
  } catch {
    // The tab can disappear while Chrome is switching windows.
  }
}

async function updateTabPanel(tabId: number, url?: string): Promise<void> {
  if (url !== undefined) {
    await setTabPanelEnabled(tabId, url);
    return;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    await setTabPanelEnabled(tabId, tab.url);
  } catch {
    // The tab can disappear before it is read.
  }
}

async function requestActivePageContext(): Promise<PageContext | null> {
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (activeTab?.id === undefined || !isScombzUrl(activeTab.url)) {
      return null;
    }

    const context = await chrome.tabs.sendMessage(activeTab.id, {
      type: MESSAGE_TYPES.requestPageContext,
    });
    return isPageContext(context) ? context : null;
  } catch {
    return null;
  }
}

function isPageContext(value: unknown): value is PageContext {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.title === "string" &&
    typeof candidate.url === "string" &&
    typeof candidate.kind === "string"
  );
}

function configureActionClick(): void {
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => undefined);
}

configureActionClick();
chrome.runtime.onInstalled.addListener(configureActionClick);
chrome.runtime.onStartup.addListener(configureActionClick);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url !== undefined || changeInfo.status !== undefined) {
    void updateTabPanel(tabId, changeInfo.url ?? tab.url);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void updateTabPanel(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isGetPageContextMessage(message)) {
    void requestActivePageContext().then(sendResponse);
    return true;
  }

  if (isPageContextUpdatedMessage(message) && sender.tab !== undefined) {
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  }
});
