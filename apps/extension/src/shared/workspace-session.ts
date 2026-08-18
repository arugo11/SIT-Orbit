import type { PageContext } from "../content/page-context";
import type { StableAgentLoopSnapshot } from "../sidepanel/loop-state";

export interface WorkspaceSession {
  sessionId: string;
  sourceTabId: number;
  sourceWindowId: number;
  workspaceTabId: number | null;
  pageContext: PageContext;
  stableState: StableAgentLoopSnapshot;
  sourceAvailable: boolean;
  updatedAt: string;
}

export interface WorkspaceStatus {
  active: boolean;
  session: WorkspaceSession | null;
  sourceTabId: number | null;
}

export function workspaceSessionKey(sessionId: string): string {
  return `workspace:session:${sessionId}`;
}

export function workspaceSourceKey(sourceTabId: number): string {
  return `workspace:source:${sourceTabId}`;
}

export function isWorkspaceSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}
