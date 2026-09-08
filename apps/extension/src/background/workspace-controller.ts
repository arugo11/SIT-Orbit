import { isScombzUrl, type PageContext } from "../content/page-context";
import {
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

function isTabId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStoredWorkspaceSession(
  value: unknown,
  expectedSessionId?: string,
): value is WorkspaceSession {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WorkspaceSession>;
  return (
    isWorkspaceSessionId(candidate.sessionId) &&
    (expectedSessionId === undefined ||
      candidate.sessionId === expectedSessionId) &&
    isTabId(candidate.sourceTabId) &&
    isTabId(candidate.sourceWindowId) &&
    (candidate.workspaceTabId === null || isTabId(candidate.workspaceTabId)) &&
    typeof candidate.sourceAvailable === "boolean" &&
    typeof candidate.updatedAt === "string"
  );
}

function isWorkspaceTabForSession(
  tab: chrome.tabs.Tab,
  sessionId: string,
): boolean {
  if (tab.id === undefined || typeof tab.url !== "string") return false;
  try {
    return (
      tab.url ===
      `${chrome.runtime.getURL("workspace.html")}?session=${encodeURIComponent(sessionId)}`
    );
  } catch {
    return false;
  }
}

export class WorkspaceSessionController {
  constructor(
    private readonly requestPageContextForTab: (
      tabId: number,
    ) => Promise<PageContext | null>,
  ) {}

  private async read(sessionId: string): Promise<WorkspaceSession | null> {
    if (!isWorkspaceSessionId(sessionId)) return null;
    const key = workspaceSessionKey(sessionId);
    const stored = await chrome.storage.session.get(key);
    const value = stored[key];
    return isStoredWorkspaceSession(value, sessionId) ? value : null;
  }

  private async readStoredSessions(): Promise<WorkspaceSession[]> {
    const stored = await chrome.storage.session.get(null);
    return Object.entries(stored)
      .filter(([key]) => key.startsWith("workspace:session:"))
      .map(([key, value]) => {
        const sessionId = key.slice("workspace:session:".length);
        return isWorkspaceSessionId(sessionId) &&
          isStoredWorkspaceSession(value, sessionId)
          ? value
          : null;
      })
      .filter((session): session is WorkspaceSession => session !== null);
  }

  private async clearStaleWorkspaceRef(
    session: WorkspaceSession,
  ): Promise<void> {
    try {
      await this.write({
        ...session,
        workspaceTabId: null,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // A service-worker restart or storage teardown can race cleanup.
    }
  }

  private async findActiveWorkspace(): Promise<{
    session: WorkspaceSession;
    tab: chrome.tabs.Tab;
  } | null> {
    let sessions: WorkspaceSession[];
    try {
      sessions = await this.readStoredSessions();
    } catch {
      return null;
    }

    for (const session of sessions) {
      if (session.workspaceTabId === null) continue;
      try {
        const tab = await chrome.tabs.get(session.workspaceTabId);
        if (isWorkspaceTabForSession(tab, session.sessionId)) {
          return { session, tab };
        }
      } catch {
        await this.clearStaleWorkspaceRef(session);
        continue;
      }
      // A tab ID can be reused by another page after the workspace closes.
      // Treat that as stale too and clear the saved ownership reference.
      await this.clearStaleWorkspaceRef(session);
    }
    return null;
  }

  private async write(session: WorkspaceSession): Promise<void> {
    await chrome.storage.session.set({
      [workspaceSessionKey(session.sessionId)]: session,
      [workspaceSourceKey(session.sourceTabId)]: session.sessionId,
    });
  }

  private async forSourceTab(
    sourceTabId: number,
  ): Promise<WorkspaceSession | null> {
    const sourceKey = workspaceSourceKey(sourceTabId);
    const stored = await chrome.storage.session.get(sourceKey);
    const sessionId = stored[sourceKey];
    return typeof sessionId === "string" ? this.read(sessionId) : null;
  }

  private async currentScombzTab(): Promise<chrome.tabs.Tab | null> {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return activeTab?.id !== undefined && isScombzUrl(activeTab.url)
      ? activeTab
      : null;
  }

  private async activateExistingWorkspace(
    session: WorkspaceSession,
    workspaceTab: chrome.tabs.Tab,
    stableState: WorkspaceSession["stableState"],
  ): Promise<OpenWorkspaceResponse> {
    const refreshed = {
      ...session,
      stableState,
      updatedAt: new Date().toISOString(),
    };
    await this.write(refreshed);
    await chrome.tabs.update(workspaceTab.id as number, { active: true });
    await chrome.windows.update(workspaceTab.windowId, { focused: true });
    await chrome.runtime
      .sendMessage({
        type: MESSAGE_TYPES.workspaceOwnershipChanged,
        active: true,
        session: refreshed,
      })
      .catch(() => undefined);
    return { ok: true, session: refreshed };
  }

  async open(message: OpenWorkspaceMessage): Promise<OpenWorkspaceResponse> {
    const activeSourceTab = await this.currentScombzTab();
    const sourceExisting =
      activeSourceTab?.id === undefined
        ? null
        : await this.forSourceTab(activeSourceTab.id);
    if (!sourceExisting) {
      const activeWorkspace = await this.findActiveWorkspace();
      if (activeWorkspace) {
        try {
          return await this.activateExistingWorkspace(
            activeWorkspace.session,
            activeWorkspace.tab,
            message.stable_state,
          );
        } catch {
          await this.clearStaleWorkspaceRef(activeWorkspace.session);
        }
      }
    }

    const sourceTab = activeSourceTab;
    if (sourceTab?.id === undefined) {
      return { ok: false, error: "接続元のScombZタブを確認できません。" };
    }
    const pageContext = await this.requestPageContextForTab(sourceTab.id);
    if (pageContext?.kind !== "scombz") {
      return { ok: false, error: "ScombZページの情報を取得できません。" };
    }

    const existing = sourceExisting;
    if (
      existing?.workspaceTabId !== null &&
      existing?.workspaceTabId !== undefined
    ) {
      try {
        const workspaceTab = await chrome.tabs.get(existing.workspaceTabId);
        if (!isWorkspaceTabForSession(workspaceTab, existing.sessionId)) {
          throw new Error("保存済みworkspaceタブのURLが一致しません。");
        }
        const refreshed = {
          ...existing,
          pageContext,
          sourceAvailable: true,
          updatedAt: new Date().toISOString(),
        };
        await this.write(refreshed);
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
    await this.write(session);

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
    await this.write(opened);
    try {
      await chrome.tabs.update(workspaceTab.id, {
        url: workspaceUrl,
        active: true,
      });
    } catch {
      await this.write({
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

  async get(sessionId: string): Promise<WorkspaceSessionResponse> {
    const session = await this.read(sessionId);
    return session
      ? { ok: true, session }
      : { ok: false, error: "全画面セッションが見つかりません。" };
  }

  async status(): Promise<WorkspaceStatusResponse> {
    const activeWorkspace = await this.findActiveWorkspace();
    if (!activeWorkspace) {
      return { active: false, session: null, sourceTabId: null };
    }
    return {
      active: true,
      session: activeWorkspace.session,
      // Keep the saved source binding.  The currently active tab may belong
      // to another window or may be an unrelated SCombZ page.
      sourceTabId: activeWorkspace.session.sourceTabId,
    };
  }

  async update(
    message: UpdateWorkspaceSessionMessage,
    sender: chrome.runtime.MessageSender,
  ): Promise<WorkspaceSessionResponse> {
    const session = await this.read(message.session_id);
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
    await this.write(updated);
    return { ok: true, session: updated };
  }

  async releaseWorkspaceTab(tabId: number): Promise<void> {
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
        await this.write(released);
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

  async markSourceUnavailable(tabId: number): Promise<void> {
    const session = await this.forSourceTab(tabId);
    if (!session) return;
    const unavailable = {
      ...session,
      sourceAvailable: false,
      updatedAt: new Date().toISOString(),
    };
    await this.write(unavailable);
    await chrome.runtime
      .sendMessage({
        type: MESSAGE_TYPES.workspaceSourceUnavailable,
        session_id: session.sessionId,
      })
      .catch(() => undefined);
  }
}
