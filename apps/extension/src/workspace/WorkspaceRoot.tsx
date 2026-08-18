import { useEffect, useState } from "react";
import {
  MESSAGE_TYPES,
  type WorkspaceSessionResponse,
} from "../shared/messages";
import { isWorkspaceSessionId } from "../shared/workspace-session";
import { App } from "../sidepanel/App";

function requestSession(sessionId: string): Promise<WorkspaceSessionResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: MESSAGE_TYPES.getWorkspaceSession,
        session_id: sessionId,
      },
      (response: WorkspaceSessionResponse | undefined) => {
        if (chrome.runtime.lastError || !response) {
          resolve({ ok: false, error: "全画面セッションを読み込めません。" });
          return;
        }
        resolve(response);
      },
    );
  });
}

export function WorkspaceRoot() {
  const [result, setResult] = useState<WorkspaceSessionResponse | null>(null);

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get(
      "session",
    );
    if (!isWorkspaceSessionId(sessionId)) {
      setResult({ ok: false, error: "全画面セッションIDが不正です。" });
      return;
    }
    void requestSession(sessionId).then(setResult);
  }, []);

  if (result === null) {
    return (
      <main className="workspace-loading" aria-busy="true">
        <p className="eyebrow">SIT ORBIT</p>
        <h1>ワークスペースを準備しています…</h1>
      </main>
    );
  }

  if (!result.ok) {
    return (
      <main className="workspace-loading">
        <p className="eyebrow">SIT ORBIT</p>
        <h1>ワークスペースを開けませんでした</h1>
        <p className="error-message" role="alert">
          {result.error}
        </p>
        <p className="footer-note">
          ScombZのSide Panelから、もう一度「全画面で開く」を押してください。
        </p>
      </main>
    );
  }

  return <App mode="workspace" workspaceSession={result.session} />;
}
