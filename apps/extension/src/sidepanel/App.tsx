import { useEffect, useReducer, useState } from "react";
import {
  type ActionProposal,
  AgentApiClient,
  DEFAULT_AGENT_API_BASE,
  type OrbitEvent,
} from "../api/client";
import type { PageContext, PageKind } from "../content/page-context";
import {
  isPageContext,
  isPageContextUpdatedMessage,
  MESSAGE_TYPES,
} from "../shared/messages";
import {
  B1_OMIYA_CONTEXT,
  B1_OMIYA_EVENT,
  isSafeB1Proposal,
  isSyntheticOrPublic,
} from "./b1-fixture";
import { agentLoopReducer, initialAgentLoopState } from "./loop-state";

const PAGE_KIND_LABEL: Record<PageKind, string> = {
  scombz: "ScombZページ",
  other: "その他",
};

const LOCAL_FIXTURE = {
  campus: "B1 大宮",
  event: "campus_entered",
  evidence: "微分積分学の課題は明日締切",
  available: "次の授業まで18分",
};

const agentApiClient = new AgentApiClient({
  baseUrl: DEFAULT_AGENT_API_BASE,
});

function requestPageContext(): Promise<PageContext | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: MESSAGE_TYPES.getPageContext },
      (response: unknown) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(isPageContext(response) ? response : null);
      },
    );
  });
}

function describeError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Agent APIとの通信に失敗しました。";
}

function formatPayload(payload: Record<string, unknown> | undefined): string {
  try {
    return JSON.stringify(payload ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

function isCompletionEvent(event: OrbitEvent, actionId: string): boolean {
  const payload = event.payload;
  return (
    event.event_type === "action_completed" &&
    event.scenario_id === B1_OMIYA_EVENT.scenario_id &&
    event.campus === B1_OMIYA_EVENT.campus &&
    isSyntheticOrPublic(event.data_classification) &&
    payload?.action_id === actionId &&
    payload?.approved === true &&
    payload?.completed === true
  );
}

function proposalEvidence(proposal: ActionProposal) {
  return proposal.evidence.map((evidence) => (
    <li key={evidence.evidence_id}>
      <span>{evidence.title}</span>
      <small>
        {evidence.source_type} · {evidence.data_classification} ·{" "}
        {evidence.locator}
      </small>
    </li>
  ));
}

export function App() {
  const [pageContext, setPageContext] = useState<PageContext | null>(null);
  const [loopState, dispatch] = useReducer(
    agentLoopReducer,
    initialAgentLoopState,
  );

  useEffect(() => {
    let mounted = true;

    const handleMessage = (message: unknown) => {
      if (mounted && isPageContextUpdatedMessage(message)) {
        setPageContext(message.context);
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    void requestPageContext().then((context) => {
      if (mounted) {
        setPageContext(context);
      }
    });

    return () => {
      mounted = false;
      chrome.runtime.onMessage.removeListener(handleMessage);
    };
  }, []);

  const requestProposal = async (): Promise<void> => {
    dispatch({ type: "propose-started" });
    try {
      const proposal = await agentApiClient.propose({
        event: B1_OMIYA_EVENT,
        context: B1_OMIYA_CONTEXT,
      });
      if (!isSafeB1Proposal(proposal)) {
        throw new Error(
          "synthetic または public の根拠だけを表示できる提案ではありません。",
        );
      }
      dispatch({ type: "proposal-received", proposal });
    } catch (error) {
      dispatch({ type: "proposal-failed", error: describeError(error) });
    }
  };

  const approveProposal = (): void => {
    dispatch({ type: "approved" });
  };

  const rejectProposal = (): void => {
    dispatch({ type: "rejected" });
  };

  const verifyCompletion = async (): Promise<void> => {
    const proposal = loopState.proposal;
    if (!proposal || loopState.status !== "approved") {
      return;
    }

    dispatch({ type: "verify-started" });
    try {
      const event = await agentApiClient.verify(proposal.action_id, {
        scenario_id: B1_OMIYA_EVENT.scenario_id,
        campus: B1_OMIYA_EVENT.campus,
        approved: true,
        completed: true,
        notes: loopState.changeNote.trim(),
      });
      if (!isCompletionEvent(event, proposal.action_id)) {
        throw new Error(
          "action_completed の synthetic/public イベントを受け取れませんでした。",
        );
      }
      dispatch({ type: "verification-received", event });
    } catch (error) {
      dispatch({ type: "verification-failed", error: describeError(error) });
    }
  };

  return (
    <main className="panel-shell">
      <header className="panel-header">
        <div>
          <p className="eyebrow">SIT ORBIT</p>
          <h1>次の一歩を、軽く。</h1>
        </div>
        <span className="status-badge">ローカル表示</span>
      </header>

      <section className="context-card" aria-labelledby="page-context-title">
        <div className="section-heading">
          <h2 id="page-context-title">現在のScombZページ</h2>
          <span className="section-note">読み取りは最小限</span>
        </div>
        {pageContext ? (
          <dl className="context-list">
            <div>
              <dt>ページ種別</dt>
              <dd>{PAGE_KIND_LABEL[pageContext.kind]}</dd>
            </div>
            <div>
              <dt>タイトル</dt>
              <dd>{pageContext.title}</dd>
            </div>
            <div>
              <dt>URL</dt>
              <dd className="url-value">{pageContext.url}</dd>
            </div>
            {pageContext.scombz ? (
              <>
                <div>
                  <dt>ルート</dt>
                  <dd>{pageContext.scombz.route}</dd>
                </div>
                <div>
                  <dt>課題</dt>
                  <dd>{pageContext.scombz.tasks.length}件</dd>
                </div>
                <div>
                  <dt>お知らせ</dt>
                  <dd>{pageContext.scombz.announcements.length}件</dd>
                </div>
                <div>
                  <dt>関連リンク</dt>
                  <dd>{pageContext.scombz.relatedLinks.length}件</dd>
                </div>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="empty-state">ScombZページの情報を待っています。</p>
        )}
      </section>

      <section className="fixture-card" aria-labelledby="fixture-title">
        <div className="section-heading">
          <h2 id="fixture-title">B1 大宮のデモfixture</h2>
          <span className="fixture-label">合成データ</span>
        </div>
        <p className="fixture-disclaimer">
          これはローカルの静的表示です。Agent
          APIや大学の公式記録には接続していません。
        </p>
        <dl className="fixture-list">
          <div>
            <dt>場所</dt>
            <dd>{LOCAL_FIXTURE.campus}</dd>
          </div>
          <div>
            <dt>イベント</dt>
            <dd>{LOCAL_FIXTURE.event}</dd>
          </div>
          <div>
            <dt>根拠の例</dt>
            <dd>{LOCAL_FIXTURE.evidence}</dd>
          </div>
          <div>
            <dt>利用可能時間</dt>
            <dd>{LOCAL_FIXTURE.available}</dd>
          </div>
        </dl>
        <div className="agent-controls">
          <button
            type="button"
            className="primary-button"
            onClick={() => void requestProposal()}
            disabled={
              loopState.status === "proposing" ||
              loopState.status === "verifying"
            }
          >
            {loopState.status === "proposing"
              ? "提案を取得中…"
              : loopState.proposal
                ? "B1 大宮の提案を再取得"
                : "B1 大宮の提案を作成"}
          </button>
          <p className="action-note">
            ボタンを押したときだけ、合成データをローカル Agent API に送ります。
          </p>
        </div>
      </section>

      {loopState.error ? (
        <p className="error-message" role="alert">
          {loopState.error}
        </p>
      ) : null}

      {loopState.proposal ? (
        <section className="proposal-card" aria-labelledby="proposal-title">
          <div className="section-heading">
            <h2 id="proposal-title">Agent APIからの提案</h2>
            <span className="fixture-label">合成データ</span>
          </div>
          <dl className="proposal-list">
            <div>
              <dt>タイトル</dt>
              <dd>{loopState.proposal.title}</dd>
            </div>
            <div>
              <dt>理由</dt>
              <dd>{loopState.proposal.reason}</dd>
            </div>
            <div>
              <dt>所要時間</dt>
              <dd>{loopState.proposal.duration_minutes}分</dd>
            </div>
          </dl>
          <div className="evidence-block">
            <h3>根拠</h3>
            <ul className="evidence-list">
              {proposalEvidence(loopState.proposal)}
            </ul>
          </div>

          {loopState.status === "proposed" ? (
            <div className="approval-controls">
              <label htmlFor="change-note">
                完了時に添えるメモ（任意）
                <textarea
                  id="change-note"
                  value={loopState.changeNote}
                  maxLength={500}
                  onChange={(event) =>
                    dispatch({
                      type: "note-changed",
                      note: event.target.value,
                    })
                  }
                  rows={3}
                />
                <small>
                  提案内容は変更せず、完了イベントのnotesにだけ添付します。
                </small>
              </label>
              <div className="button-row">
                <button
                  type="button"
                  className="primary-button"
                  onClick={approveProposal}
                >
                  提案を承認する
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={rejectProposal}
                >
                  却下（APIに送信しない）
                </button>
              </div>
            </div>
          ) : null}

          {loopState.status === "rejected" ? (
            <p className="state-message">
              提案を却下しました。却下のための Agent API
              呼び出しは行っていません。
            </p>
          ) : null}

          {loopState.status === "approved" ||
          loopState.status === "verifying" ? (
            <div className="completion-controls">
              <p className="state-message">
                承認済みです。行動が完了したら、明示的に記録してください。
              </p>
              <button
                type="button"
                className="primary-button"
                onClick={() => void verifyCompletion()}
                disabled={loopState.status === "verifying"}
              >
                {loopState.status === "verifying"
                  ? "完了を記録中…"
                  : "完了を確認して記録する"}
              </button>
            </div>
          ) : null}

          {loopState.status === "completed" ? (
            <p className="state-message success-message">
              完了を記録しました。下の action_completed イベントを確認できます。
            </p>
          ) : null}
        </section>
      ) : null}

      {loopState.completionEvent ? (
        <section className="event-card" aria-labelledby="completion-title">
          <div className="section-heading">
            <h2 id="completion-title">完了イベント</h2>
            <span className="status-badge">記録済み</span>
          </div>
          <dl className="context-list">
            <div>
              <dt>イベント種別</dt>
              <dd>{loopState.completionEvent.event_type}</dd>
            </div>
            <div>
              <dt>シナリオ</dt>
              <dd>{loopState.completionEvent.scenario_id}</dd>
            </div>
            <div>
              <dt>キャンパス</dt>
              <dd>{loopState.completionEvent.campus}</dd>
            </div>
            <div>
              <dt>詳細</dt>
              <dd>
                <code className="event-payload">
                  {formatPayload(loopState.completionEvent.payload)}
                </code>
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      <p className="footer-note">
        この静的fixture自体は提案の作成や外部サービスへの書き込みは行いません。
        Agent APIへの接続は、提案作成と完了記録を押したときだけです。
      </p>
    </main>
  );
}
