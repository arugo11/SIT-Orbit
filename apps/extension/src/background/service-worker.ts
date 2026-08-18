import {
  type CalendarConnectorResult,
  GoogleCalendarConnector,
} from "../connectors/google-calendar";
import {
  type DriveConnectorResult,
  GoogleDriveConnector,
} from "../connectors/google-drive";
import {
  SYLLABUS_SEARCH_ORIGIN,
  searchOfficialSyllabus,
} from "../connectors/syllabus-search";
import { isScombzUrl, type PageContext } from "../content/page-context";
import {
  type BrowserReadResponse,
  type CalendarCommandMessage,
  type DriveCommandMessage,
  isBrowserReadMessage,
  isCalendarCommandMessage,
  isDriveCommandMessage,
  isGetPageContextMessage,
  isGetWorkspaceSessionMessage,
  isGetWorkspaceStatusMessage,
  isOpenWorkspaceMessage,
  isPageContext,
  isPageContextUpdatedMessage,
  isSyllabusSearchMessage,
  isUpdateWorkspaceSessionMessage,
  MESSAGE_TYPES,
  type OpenWorkspaceMessage,
  type OpenWorkspaceResponse,
  type UpdateWorkspaceSessionMessage,
  type WorkspaceSessionResponse,
  type WorkspaceStatusResponse,
} from "../shared/messages";
import {
  isWorkspaceSessionId,
  type WorkspaceSession,
  workspaceSessionKey,
  workspaceSourceKey,
} from "../shared/workspace-session";

const googleCalendarConnector = new GoogleCalendarConnector();
const googleDriveConnector = new GoogleDriveConnector();

const BUILT_IN_ORIGINS = new Set([
  "https://scombz.shibaura-it.ac.jp",
  "https://syllabus.sic.shibaura-it.ac.jp",
  "http://localhost:8000",
]);

function browserOrigin(
  value: string,
): { origin: string; pattern: string } | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return { origin: url.origin, pattern: `${url.origin}/*` };
  } catch {
    return null;
  }
}

async function hasBrowserPermission(
  pattern: string,
  origin: string,
): Promise<boolean> {
  if (BUILT_IN_ORIGINS.has(origin)) return true;
  if (typeof chrome.permissions?.contains !== "function") return false;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

function unavailableBrowser(reason_code: string): BrowserReadResponse {
  return { status: "unavailable", reason_code };
}

async function waitForTabReady(tabId: number): Promise<void> {
  try {
    const current = await chrome.tabs.get(tabId);
    const status = (current as chrome.tabs.Tab & { status?: string }).status;
    if (status !== "loading") {
      return;
    }
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener?.(listener);
      resolve();
    };
    const listener = (
      updatedTabId: number,
      changeInfo: { status?: string },
    ) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, 8000);
  });
}

async function handleBrowserRead(
  message: import("../shared/messages").BrowserReadMessage,
): Promise<BrowserReadResponse> {
  const target = browserOrigin(message.url);
  if (!target) return unavailableBrowser("invalid_url");
  if (!(await hasBrowserPermission(target.pattern, target.origin))) {
    return { status: "permission_required", ...target };
  }

  const classification =
    target.origin === SYLLABUS_SEARCH_ORIGIN ? "public" : "personal";
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: message.url, active: false });
    tabId = tab.id;
    if (tabId === undefined) return unavailableBrowser("tab_create_failed");
    await waitForTabReady(tabId);
    if (typeof chrome.scripting?.executeScript !== "function") {
      return unavailableBrowser("scripting_unavailable");
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["browser-reader.js"],
    });
    const projection = await chrome.tabs.sendMessage(tabId, {
      type: "orbit-extract-browser-document",
      tool_call_id: message.tool_call_id,
      data_classification: classification,
    });
    if (
      typeof projection !== "object" ||
      projection === null ||
      (projection as { schema_version?: unknown }).schema_version !== "v1" ||
      (projection as { status?: unknown }).status !== "known" ||
      typeof (projection as { text?: unknown }).text !== "string" ||
      !Array.isArray((projection as { links?: unknown }).links)
    ) {
      return unavailableBrowser("invalid_projection");
    }
    return { status: "known", projection } as BrowserReadResponse;
  } catch {
    return unavailableBrowser("read_failed");
  } finally {
    if (tabId !== undefined) {
      try {
        await chrome.tabs.remove?.(tabId);
      } catch {
        // The temporary tab may already have been closed by the user.
      }
    }
  }
}

function isTrustedExtensionPageSender(sender: chrome.runtime.MessageSender) {
  if (sender.id !== undefined && sender.id !== chrome.runtime.id) {
    return false;
  }
  if (sender.tab === undefined) {
    return true;
  }
  if (!sender.url) {
    return false;
  }
  try {
    const url = new URL(sender.url);
    return (
      url.protocol === "chrome-extension:" && url.hostname === chrome.runtime.id
    );
  } catch {
    return false;
  }
}

async function readWorkspaceSession(
  sessionId: string,
): Promise<WorkspaceSession | null> {
  if (!isWorkspaceSessionId(sessionId)) {
    return null;
  }
  const key = workspaceSessionKey(sessionId);
  const stored = await chrome.storage.session.get(key);
  const value = stored[key];
  return value && typeof value === "object"
    ? (value as WorkspaceSession)
    : null;
}

async function writeWorkspaceSession(session: WorkspaceSession): Promise<void> {
  await chrome.storage.session.set({
    [workspaceSessionKey(session.sessionId)]: session,
    [workspaceSourceKey(session.sourceTabId)]: session.sessionId,
  });
}

async function workspaceForSourceTab(
  sourceTabId: number,
): Promise<WorkspaceSession | null> {
  const sourceKey = workspaceSourceKey(sourceTabId);
  const stored = await chrome.storage.session.get(sourceKey);
  const sessionId = stored[sourceKey];
  return typeof sessionId === "string" ? readWorkspaceSession(sessionId) : null;
}

async function currentScombzTab(): Promise<chrome.tabs.Tab | null> {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return activeTab?.id !== undefined && isScombzUrl(activeTab.url)
    ? activeTab
    : null;
}

async function openWorkspace(
  message: OpenWorkspaceMessage,
): Promise<OpenWorkspaceResponse> {
  const sourceTab = await currentScombzTab();
  if (sourceTab?.id === undefined) {
    return { ok: false, error: "接続元のScombZタブを確認できません。" };
  }
  const pageContext = await requestPageContextForTab(sourceTab.id);
  if (pageContext?.kind !== "scombz") {
    return { ok: false, error: "ScombZページの情報を取得できません。" };
  }

  const existing = await workspaceForSourceTab(sourceTab.id);
  if (
    existing?.workspaceTabId !== null &&
    existing?.workspaceTabId !== undefined
  ) {
    try {
      const workspaceTab = await chrome.tabs.get(existing.workspaceTabId);
      const refreshed = {
        ...existing,
        pageContext,
        sourceAvailable: true,
        updatedAt: new Date().toISOString(),
      };
      await writeWorkspaceSession(refreshed);
      await chrome.tabs.update(existing.workspaceTabId, { active: true });
      await chrome.windows.update(workspaceTab.windowId, { focused: true });
      await chrome.runtime
        .sendMessage({
          type: MESSAGE_TYPES.workspaceOwnershipChanged,
          active: true,
          session: refreshed,
        })
        .catch(() => undefined);
      return { ok: true, session: refreshed };
    } catch {
      // The workspace tab disappeared without an onRemoved notification.
    }
  }

  const sessionId = existing?.sessionId ?? crypto.randomUUID();
  const session: WorkspaceSession = {
    sessionId,
    sourceTabId: sourceTab.id,
    sourceWindowId: sourceTab.windowId,
    workspaceTabId: null,
    pageContext,
    stableState: message.stable_state,
    sourceAvailable: true,
    updatedAt: new Date().toISOString(),
  };
  await writeWorkspaceSession(session);

  const workspaceUrl = chrome.runtime.getURL(
    `workspace.html?session=${encodeURIComponent(sessionId)}`,
  );
  const workspaceTab = await chrome.tabs.create({
    openerTabId: sourceTab.id,
    windowId: sourceTab.windowId,
    active: false,
  });
  if (workspaceTab.id === undefined) {
    return { ok: false, error: "全画面タブを作成できませんでした。" };
  }
  const opened = {
    ...session,
    workspaceTabId: workspaceTab.id,
    updatedAt: new Date().toISOString(),
  };
  await writeWorkspaceSession(opened);
  try {
    await chrome.tabs.update(workspaceTab.id, {
      url: workspaceUrl,
      active: true,
    });
  } catch {
    await writeWorkspaceSession({
      ...opened,
      workspaceTabId: null,
      updatedAt: new Date().toISOString(),
    });
    return { ok: false, error: "全画面タブを表示できませんでした。" };
  }
  await chrome.runtime
    .sendMessage({
      type: MESSAGE_TYPES.workspaceOwnershipChanged,
      active: true,
      session: opened,
    })
    .catch(() => undefined);
  return { ok: true, session: opened };
}

async function getWorkspaceSession(
  sessionId: string,
): Promise<WorkspaceSessionResponse> {
  const session = await readWorkspaceSession(sessionId);
  return session
    ? { ok: true, session }
    : { ok: false, error: "全画面セッションが見つかりません。" };
}

async function getWorkspaceStatus(): Promise<WorkspaceStatusResponse> {
  const sourceTab = await currentScombzTab();
  if (sourceTab?.id === undefined) {
    return { active: false, session: null, sourceTabId: null };
  }
  const session = await workspaceForSourceTab(sourceTab.id);
  return {
    active:
      session?.workspaceTabId !== null && session?.workspaceTabId !== undefined,
    session,
    sourceTabId: sourceTab.id,
  };
}

async function updateWorkspaceSession(
  message: UpdateWorkspaceSessionMessage,
  sender: chrome.runtime.MessageSender,
): Promise<WorkspaceSessionResponse> {
  const session = await readWorkspaceSession(message.session_id);
  if (
    !session ||
    sender.tab?.id === undefined ||
    sender.tab.id !== session.workspaceTabId
  ) {
    return { ok: false, error: "全画面セッションの更新を拒否しました。" };
  }
  const updated = {
    ...session,
    stableState: message.stable_state,
    updatedAt: new Date().toISOString(),
  };
  await writeWorkspaceSession(updated);
  return { ok: true, session: updated };
}

async function releaseWorkspaceTab(tabId: number): Promise<void> {
  const stored = await chrome.storage.session.get(null);
  const sessions = Object.values(stored).filter(
    (value): value is WorkspaceSession =>
      typeof value === "object" &&
      value !== null &&
      "workspaceTabId" in value &&
      (value as WorkspaceSession).workspaceTabId === tabId,
  );
  await Promise.all(
    sessions.map(async (session) => {
      const released = {
        ...session,
        workspaceTabId: null,
        updatedAt: new Date().toISOString(),
      };
      await writeWorkspaceSession(released);
      await chrome.runtime
        .sendMessage({
          type: MESSAGE_TYPES.workspaceOwnershipChanged,
          active: false,
          session: released,
        })
        .catch(() => undefined);
    }),
  );
}

async function markSourceUnavailable(tabId: number): Promise<void> {
  const session = await workspaceForSourceTab(tabId);
  if (!session) {
    return;
  }
  const unavailable = {
    ...session,
    sourceAvailable: false,
    updatedAt: new Date().toISOString(),
  };
  await writeWorkspaceSession(unavailable);
  await chrome.runtime
    .sendMessage({
      type: MESSAGE_TYPES.workspaceSourceUnavailable,
      session_id: session.sessionId,
    })
    .catch(() => undefined);
}

function unavailableCalendarResult(): CalendarConnectorResult {
  return {
    status: "unavailable",
    message:
      "Google Calendarを利用できません。時間をおいて再試行してください。",
  };
}

function unavailableDriveResult(): DriveConnectorResult {
  return {
    status: "unavailable",
    selections: [],
    message:
      "Google Driveのファイル選択はまだ利用できません。ライブProviderは未設定です。",
    retryable: false,
  };
}

async function handleCalendarCommand(
  message: CalendarCommandMessage,
): Promise<CalendarConnectorResult> {
  try {
    switch (message.type) {
      case MESSAGE_TYPES.calendarConnect:
        return await googleCalendarConnector.connect();
      case MESSAGE_TYPES.calendarRefresh:
        return await googleCalendarConnector.refresh();
      case MESSAGE_TYPES.calendarReauthenticate:
        return await googleCalendarConnector.reauthenticate();
      case MESSAGE_TYPES.calendarDisconnect:
        return await googleCalendarConnector.disconnect();
    }
  } catch {
    return unavailableCalendarResult();
  }
}

async function handleDriveCommand(
  message: DriveCommandMessage,
): Promise<DriveConnectorResult> {
  try {
    switch (message.type) {
      case MESSAGE_TYPES.driveSelect:
        return await googleDriveConnector.select();
      case MESSAGE_TYPES.driveRead:
        return await googleDriveConnector.read(message.selection_id);
      case MESSAGE_TYPES.driveDeselect:
        return await googleDriveConnector.deselect(message.selection_id);
      case MESSAGE_TYPES.driveRefresh:
        return await googleDriveConnector.refresh();
    }
  } catch {
    return unavailableDriveResult();
  }
}

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

async function requestPageContextForTab(
  tabId: number,
): Promise<PageContext | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isScombzUrl(tab.url)) {
      return null;
    }

    const context = await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE_TYPES.requestPageContext,
    });
    return isPageContext(context) ? context : null;
  } catch {
    return null;
  }
}

async function requestActivePageContext(): Promise<PageContext | null> {
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (activeTab?.id === undefined) {
      return null;
    }

    return requestPageContextForTab(activeTab.id);
  } catch {
    return null;
  }
}

async function broadcastActivePageContext(
  tabId: number,
  context: PageContext | null,
): Promise<void> {
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (activeTab?.id !== tabId) {
      return;
    }

    await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.pageContextUpdated,
      context,
    });
  } catch {
    // The active tab or side panel can disappear while Chrome is switching.
  }
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
  if (changeInfo.url !== undefined && !isScombzUrl(changeInfo.url)) {
    void markSourceUnavailable(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void releaseWorkspaceTab(tabId);
  void markSourceUnavailable(tabId);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void updateTabPanel(tabId);
  void requestPageContextForTab(tabId).then((context) =>
    broadcastActivePageContext(tabId, context),
  );
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isCalendarCommandMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse(unavailableCalendarResult());
      return true;
    }
    void handleCalendarCommand(message).then(sendResponse);
    return true;
  }

  if (isDriveCommandMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse(unavailableDriveResult());
      return true;
    }
    void handleDriveCommand(message).then(sendResponse);
    return true;
  }

  if (isBrowserReadMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse(unavailableBrowser("untrusted_sender"));
      return true;
    }
    void handleBrowserRead(message).then(sendResponse);
    return true;
  }

  if (isSyllabusSearchMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse({
        schema_version: "v1",
        status: "unavailable",
        query: message.query,
        year: message.year ?? null,
        faculty: message.faculty ?? null,
        results: [],
        reason_code: "untrusted_sender",
      });
      return true;
    }
    void searchOfficialSyllabus(
      message.query,
      message.year ?? null,
      message.faculty ?? null,
    ).then(sendResponse);
    return true;
  }

  if (isOpenWorkspaceMessage(message)) {
    if (!isTrustedExtensionPageSender(sender) || sender.tab !== undefined) {
      sendResponse({ ok: false, error: "全画面表示の開始を拒否しました。" });
      return true;
    }
    void openWorkspace(message).then(sendResponse);
    return true;
  }

  if (isGetWorkspaceSessionMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse({ ok: false, error: "全画面セッションを取得できません。" });
      return true;
    }
    void getWorkspaceSession(message.session_id).then(sendResponse);
    return true;
  }

  if (isUpdateWorkspaceSessionMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse({ ok: false, error: "全画面セッションを更新できません。" });
      return true;
    }
    void updateWorkspaceSession(message, sender).then(sendResponse);
    return true;
  }

  if (isGetWorkspaceStatusMessage(message)) {
    if (!isTrustedExtensionPageSender(sender) || sender.tab !== undefined) {
      sendResponse({ active: false, session: null, sourceTabId: null });
      return true;
    }
    void getWorkspaceStatus().then(sendResponse);
    return true;
  }

  if (isGetPageContextMessage(message)) {
    void requestActivePageContext().then(sendResponse);
    return true;
  }

  if (isPageContextUpdatedMessage(message) && sender.tab !== undefined) {
    void broadcastActivePageContext(sender.tab.id ?? -1, message.context);
  }
});
