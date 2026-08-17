import { useEffect, useReducer, useState } from "react";
import {
  type ActionProposal,
  AgentApiClient,
  DEFAULT_AGENT_API_BASE,
  type OrbitEvent,
} from "../api/client";
import {
  type CalendarConnector,
  type CalendarConnectorResult,
  type CalendarEventView,
  formatAvailabilitySummary,
} from "../connectors/google-calendar";
import type {
  DriveConnector,
  DriveConnectorResult,
  DriveSelectionView,
} from "../connectors/google-drive";
import {
  createFixtureDriveConnector,
  type DriveSelectionCandidate,
} from "../connectors/google-drive";
import type { PageContext, PageKind } from "../content/page-context";
import {
  type CalendarCommand,
  calendarCommandMessage,
  type DriveCommand,
  driveCommandMessage,
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

const DRIVE_FIXTURE_CANDIDATE: DriveSelectionCandidate = {
  fileId: "fixture-drive-note",
  name: "合成ノート.md",
  mimeType: "text/markdown",
  sizeBytes: 512,
  modifiedTime: "2026-08-17T09:00:00+09:00",
  trashed: false,
  canDownload: true,
  isFolder: false,
  isShortcut: false,
  dataClassification: "synthetic",
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

function requestCalendarCommand(
  command: CalendarCommand,
): Promise<CalendarConnectorResult> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      calendarCommandMessage(command),
      (response: unknown) => {
        if (chrome.runtime.lastError || !isCalendarResult(response)) {
          reject(new Error("Calendar connector response was unavailable."));
          return;
        }
        resolve(response);
      },
    );
  });
}

export function requestDriveCommand(
  command: DriveCommand,
  selectionId?: string,
): Promise<DriveConnectorResult> {
  return new Promise((resolve, reject) => {
    let message: ReturnType<typeof driveCommandMessage>;
    try {
      message = driveCommandMessage(command, selectionId);
    } catch {
      reject(new Error("Drive connector command was invalid."));
      return;
    }
    chrome.runtime.sendMessage(message, (response: unknown) => {
      if (chrome.runtime.lastError || !isDriveResult(response)) {
        reject(new Error("Drive connector response was unavailable."));
        return;
      }
      resolve(response);
    });
  });
}

function isCalendarResult(value: unknown): value is CalendarConnectorResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.status === "not_connected" ||
    candidate.status === "connected" ||
    candidate.status === "reauth_required" ||
    candidate.status === "unavailable"
  );
}

function isDriveResult(value: unknown): value is DriveConnectorResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.status === "not_connected" ||
      candidate.status === "connected" ||
      candidate.status === "reauth_required" ||
      candidate.status === "unavailable") &&
    Array.isArray(candidate.selections) &&
    candidate.selections.every(isDriveSelectionView)
  );
}

function isDriveSelectionView(value: unknown): value is DriveSelectionView {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.selectionId === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.mimeType === "string" &&
    (candidate.sizeBytes === null || typeof candidate.sizeBytes === "number") &&
    (candidate.modifiedTime === null ||
      typeof candidate.modifiedTime === "string") &&
    (candidate.status === "selected" || candidate.status === "read") &&
    (candidate.evidence === undefined || isDriveEvidence(candidate.evidence))
  );
}

function isDriveEvidence(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.evidence_id === "string" &&
    typeof candidate.title === "string" &&
    candidate.source_type === "google_drive" &&
    typeof candidate.locator === "string" &&
    typeof candidate.data_classification === "string"
  );
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

export interface AppProps {
  /** Test-only seam; production uses the typed service-worker request below. */
  calendarConnector?: CalendarConnector;
  calendarRequest?: (
    command: CalendarCommand,
  ) => Promise<CalendarConnectorResult>;
  /** Test-only seam; production uses the typed service-worker request below. */
  driveConnector?: DriveConnector;
  driveRequest?: (
    command: DriveCommand,
    selectionId?: string,
  ) => Promise<DriveConnectorResult>;
}

function formatCalendarEventTime(
  event: CalendarEventView,
  timeZone: string,
): string {
  if (event.allDay) {
    return `${event.start}〜${event.end}（終日）`;
  }

  const formatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    dateStyle: "short",
    timeStyle: "short",
  });
  const start = new Date(event.start);
  const end = new Date(event.end);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return "時刻を表示できません";
  }
  if (event.endTimeUnspecified) {
    return formatter.format(start);
  }
  return `${formatter.format(start)}〜${formatter.format(end)}`;
}

function CalendarCard({
  state,
  busy,
  onConnect,
  onRefresh,
  onReauthenticate,
  onDisconnect,
}: {
  state: CalendarConnectorResult;
  busy: boolean;
  onConnect: () => void;
  onRefresh: () => void;
  onReauthenticate: () => void;
  onDisconnect: () => void;
}) {
  const snapshot = state.snapshot;
  return (
    <section
      className="calendar-card"
      aria-labelledby="calendar-title"
      data-calendar-status={state.status}
    >
      <div className="section-heading">
        <h2 id="calendar-title">Google Calendar</h2>
        <span className="calendar-status-badge">
          {state.status === "not_connected"
            ? "未接続"
            : state.status === "connected"
              ? "接続済み"
              : state.status === "reauth_required"
                ? "再認証が必要"
                : "利用できません"}
        </span>
      </div>

      {state.status === "not_connected" ? (
        <>
          <p className="connector-description">
            接続ボタンを押すまで、Google Calendarには接続しません。
          </p>
          <button
            type="button"
            className="primary-button"
            data-testid="calendar-connect"
            onClick={onConnect}
            disabled={busy}
          >
            {busy ? "接続中…" : "Google Calendarを接続"}
          </button>
        </>
      ) : null}

      {state.status === "reauth_required" ? (
        <>
          <p className="connector-description">
            {state.message ?? "Google Calendarの再認証が必要です。"}
          </p>
          <div className="button-row">
            <button
              type="button"
              className="primary-button"
              data-testid="calendar-reauth"
              onClick={onReauthenticate}
              disabled={busy}
            >
              {busy ? "再認証中…" : "再認証する"}
            </button>
            <button
              type="button"
              className="secondary-button"
              data-testid="calendar-disconnect"
              onClick={onDisconnect}
              disabled={busy}
            >
              切断
            </button>
          </div>
        </>
      ) : null}

      {state.status === "unavailable" ? (
        <>
          <p className="connector-description" role="alert">
            {state.message ?? "Google Calendarを利用できません。"}
          </p>
          <div className="button-row">
            <button
              type="button"
              className="primary-button"
              data-testid="calendar-connect"
              onClick={onConnect}
              disabled={busy}
            >
              {busy ? "再試行中…" : "再試行"}
            </button>
            <button
              type="button"
              className="secondary-button"
              data-testid="calendar-disconnect"
              onClick={onDisconnect}
              disabled={busy}
            >
              切断
            </button>
          </div>
        </>
      ) : null}

      {state.status === "connected" && snapshot ? (
        <>
          <p className="connector-description">
            {snapshot.timeZone} · 今日から7日間（終了時刻は含みません）
          </p>
          <div className="calendar-availability">
            <strong>ローカルの空き時間</strong>
            <span>{formatAvailabilitySummary(snapshot.availability)}</span>
            {snapshot.truncated ? (
              <small>
                予定が上限に達したため、空き時間は確定していません。
              </small>
            ) : null}
          </div>
          <div className="calendar-events-block">
            <h3>予定</h3>
            {snapshot.events.length > 0 ? (
              <ul className="calendar-event-list">
                {snapshot.events.map((event) => (
                  <li key={event.id}>
                    <span>{event.summary}</span>
                    <small>
                      {formatCalendarEventTime(event, snapshot.timeZone)}
                      {event.transparency === "transparent"
                        ? " · 空き時間として扱います"
                        : ""}
                    </small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-state">範囲内の予定はありません。</p>
            )}
          </div>
          <div className="button-row calendar-controls">
            <button
              type="button"
              className="primary-button"
              data-testid="calendar-refresh"
              onClick={onRefresh}
              disabled={busy}
            >
              {busy ? "更新中…" : "更新"}
            </button>
            <button
              type="button"
              className="secondary-button"
              data-testid="calendar-reauth"
              onClick={onReauthenticate}
              disabled={busy}
            >
              再認証
            </button>
            <button
              type="button"
              className="secondary-button"
              data-testid="calendar-disconnect"
              onClick={onDisconnect}
              disabled={busy}
            >
              切断
            </button>
          </div>
        </>
      ) : null}

      {state.message && state.status === "not_connected" ? (
        <p className="connector-description">{state.message}</p>
      ) : null}
    </section>
  );
}

function driveStatusLabel(status: DriveConnectorResult["status"]): string {
  switch (status) {
    case "not_connected":
      return "未接続";
    case "connected":
      return "接続済み";
    case "reauth_required":
      return "再認証が必要";
    case "unavailable":
      return "利用できません";
  }
}

function DriveCard({
  state,
  busy,
  onSelect,
  onRead,
  onDeselect,
}: {
  state: DriveConnectorResult;
  busy: boolean;
  onSelect: () => void;
  onRead: (selectionId: string) => void;
  onDeselect: (selectionId: string) => void;
}) {
  return (
    <section
      className="drive-card"
      aria-labelledby="drive-title"
      data-drive-status={state.status}
    >
      <div className="section-heading">
        <h2 id="drive-title">Google Drive</h2>
        <span className="drive-status-badge">
          {driveStatusLabel(state.status)}
        </span>
      </div>

      <p className="connector-description">
        選択したファイルのメタデータだけを、このブラウザのセッション中に扱います。
      </p>

      {state.status === "unavailable" ? (
        <p className="connector-description" role="alert">
          {state.message ?? "Google Driveのファイル選択は利用できません。"}
        </p>
      ) : null}

      {state.status === "not_connected" ? (
        <p className="connector-description">
          ライブProviderには接続していません。選択操作を行ったときだけ確認します。
        </p>
      ) : null}

      {state.selections.length > 0 ? (
        <div className="drive-selection-block">
          <h3>選択済みファイル</h3>
          <ul className="drive-selection-list">
            {state.selections.map((selection) => (
              <li key={selection.selectionId}>
                <div className="drive-selection-metadata">
                  <strong>{selection.name}</strong>
                  <small>
                    {selection.mimeType} ·{" "}
                    {selection.modifiedTime ?? "更新日時不明"}
                    {" · "}
                    {selection.sizeBytes === null
                      ? "サイズ不明"
                      : `${selection.sizeBytes.toLocaleString()} bytes`}
                  </small>
                  <small>
                    {selection.status === "read"
                      ? "読み取り済み"
                      : "未読み取り"}
                    {selection.evidence
                      ? ` · ${selection.evidence.locator}`
                      : ""}
                  </small>
                </div>
                <div className="button-row">
                  <button
                    type="button"
                    className="primary-button"
                    data-testid={`drive-read-${selection.selectionId}`}
                    onClick={() => onRead(selection.selectionId)}
                    disabled={busy}
                  >
                    {busy ? "読み取り中…" : "読み取る"}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    data-testid={`drive-deselect-${selection.selectionId}`}
                    onClick={() => onDeselect(selection.selectionId)}
                    disabled={busy}
                  >
                    選択解除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="button-row drive-controls">
        <button
          type="button"
          className="primary-button"
          data-testid="drive-select"
          onClick={onSelect}
          disabled={
            busy ||
            (state.status === "unavailable" && state.retryable === false)
          }
        >
          {busy ? "確認中…" : "Google Driveから選ぶ"}
        </button>
      </div>

      {state.message && state.status !== "unavailable" ? (
        <p className="connector-description">{state.message}</p>
      ) : null}
    </section>
  );
}

function DriveFixtureCard({
  state,
  busy,
  onSelect,
  onRead,
  onDeselect,
}: {
  state: DriveConnectorResult;
  busy: boolean;
  onSelect: () => void;
  onRead: (selectionId: string) => void;
  onDeselect: (selectionId: string) => void;
}) {
  const selection = state.selections[0];
  return (
    <section
      className="drive-fixture-card"
      aria-labelledby="drive-fixture-title"
      data-drive-fixture-status={state.status}
    >
      <div className="section-heading">
        <h2 id="drive-fixture-title">合成Drive fixture</h2>
        <span className="fixture-label">合成データ</span>
      </div>
      <p className="fixture-disclaimer">
        Google Driveではありません。Agent
        APIや外部サービスへ接続しない、ローカルの操作確認です。
      </p>
      {selection ? (
        <dl className="drive-fixture-list">
          <div>
            <dt>ファイル</dt>
            <dd>{selection.name}</dd>
          </div>
          <div>
            <dt>形式</dt>
            <dd>{selection.mimeType}</dd>
          </div>
          <div>
            <dt>状態</dt>
            <dd>
              {selection.status === "read" ? "読み取り済み" : "未読み取り"}
            </dd>
          </div>
          {selection.evidence ? (
            <div>
              <dt>EvidenceLink</dt>
              <dd>{selection.evidence.locator}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="empty-state">合成ファイルはまだ選択されていません。</p>
      )}
      <div className="button-row drive-fixture-controls">
        <button
          type="button"
          className="primary-button"
          data-testid="drive-fixture-select"
          onClick={onSelect}
          disabled={busy || selection !== undefined}
        >
          {busy ? "処理中…" : "合成ファイルを選ぶ"}
        </button>
        {selection ? (
          <>
            <button
              type="button"
              className="primary-button"
              data-testid="drive-fixture-read"
              onClick={() => onRead(selection.selectionId)}
              disabled={busy}
            >
              読み取る
            </button>
            <button
              type="button"
              className="secondary-button"
              data-testid="drive-fixture-deselect"
              onClick={() => onDeselect(selection.selectionId)}
              disabled={busy}
            >
              選択解除
            </button>
          </>
        ) : null}
      </div>
      {state.message ? (
        <p className="connector-description">{state.message}</p>
      ) : null}
    </section>
  );
}

export function App({
  calendarConnector,
  calendarRequest = requestCalendarCommand,
  driveConnector,
  driveRequest = requestDriveCommand,
}: AppProps) {
  const [pageContext, setPageContext] = useState<PageContext | null>(null);
  const [loopState, dispatch] = useReducer(
    agentLoopReducer,
    initialAgentLoopState,
  );
  const [calendarState, setCalendarState] = useState<CalendarConnectorResult>({
    status: "not_connected",
  });
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [driveState, setDriveState] = useState<DriveConnectorResult>({
    status: "unavailable",
    selections: [],
    message:
      "Google Driveのファイル選択はまだ利用できません。ライブProviderは未設定です。",
    retryable: false,
  });
  const [driveBusy, setDriveBusy] = useState(false);
  const [driveFixtureConnector] = useState(() =>
    createFixtureDriveConnector({
      candidates: DRIVE_FIXTURE_CANDIDATE,
      selectionIdFactory: () => "sel_fixture_drive_1",
    }),
  );
  const [driveFixtureState, setDriveFixtureState] =
    useState<DriveConnectorResult>({
      status: "not_connected",
      selections: [],
    });
  const [driveFixtureBusy, setDriveFixtureBusy] = useState(false);

  const runCalendarAction = async (
    action: "connect" | "refresh" | "reauthenticate" | "disconnect",
  ): Promise<void> => {
    setCalendarBusy(true);
    try {
      const result = calendarConnector
        ? await calendarConnector[action]()
        : await calendarRequest(action);
      setCalendarState(result);
    } catch {
      setCalendarState({
        status: action === "disconnect" ? "not_connected" : "unavailable",
        message:
          action === "disconnect"
            ? "Google Calendarを切断しました。"
            : "Google Calendarを利用できません。時間をおいて再試行してください。",
      });
    } finally {
      setCalendarBusy(false);
    }
  };

  const runDriveAction = async (
    action: "select" | "read" | "deselect",
    selectionId?: string,
  ): Promise<void> => {
    setDriveBusy(true);
    try {
      const result = driveConnector
        ? action === "select"
          ? await driveConnector.select()
          : action === "read"
            ? await driveConnector.read(selectionId ?? "")
            : await driveConnector.deselect(selectionId ?? "")
        : await driveRequest(action, selectionId);
      setDriveState(result);
    } catch {
      setDriveState((current) => ({
        status: "unavailable",
        selections: current.selections,
        message:
          "Google Driveを利用できません。時間をおいて再試行してください。",
        retryable: true,
      }));
    } finally {
      setDriveBusy(false);
    }
  };

  const runDriveFixtureAction = async (
    action: "select" | "read" | "deselect",
    selectionId?: string,
  ): Promise<void> => {
    setDriveFixtureBusy(true);
    try {
      const result =
        action === "select"
          ? await driveFixtureConnector.select()
          : action === "read"
            ? await driveFixtureConnector.read(selectionId ?? "")
            : await driveFixtureConnector.deselect(selectionId ?? "");
      setDriveFixtureState(result);
    } catch {
      setDriveFixtureState((current) => ({
        status: "unavailable",
        selections: current.selections,
        message: "合成Drive fixtureを利用できません。",
        retryable: false,
      }));
    } finally {
      setDriveFixtureBusy(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    const hydrateDrive = async (): Promise<void> => {
      try {
        const result = driveConnector
          ? await driveConnector.refresh()
          : await driveRequest("refresh");
        if (mounted) {
          setDriveState(result);
        }
      } catch {
        if (mounted) {
          setDriveState((current) => ({
            status: "unavailable",
            selections: current.selections,
            message:
              "Google Driveのセッション状態を確認できません。時間をおいて再試行してください。",
            retryable: true,
          }));
        }
      }
    };
    void hydrateDrive();
    return () => {
      mounted = false;
    };
  }, [driveConnector, driveRequest]);

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
      const fixtureEvidence = driveFixtureState.selections
        .filter(
          (selection) =>
            selection.status === "read" &&
            selection.evidence !== undefined &&
            isSyntheticOrPublic(selection.evidence.data_classification),
        )
        .map((selection) => selection.evidence)
        .filter((evidence): evidence is NonNullable<typeof evidence> =>
          Boolean(evidence),
        );
      const proposal = await agentApiClient.propose({
        event: B1_OMIYA_EVENT,
        context: [...B1_OMIYA_CONTEXT, ...fixtureEvidence],
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

      <CalendarCard
        state={calendarState}
        busy={calendarBusy}
        onConnect={() => void runCalendarAction("connect")}
        onRefresh={() => void runCalendarAction("refresh")}
        onReauthenticate={() => void runCalendarAction("reauthenticate")}
        onDisconnect={() => void runCalendarAction("disconnect")}
      />

      <DriveCard
        state={driveState}
        busy={driveBusy}
        onSelect={() => void runDriveAction("select")}
        onRead={(selectionId) => void runDriveAction("read", selectionId)}
        onDeselect={(selectionId) =>
          void runDriveAction("deselect", selectionId)
        }
      />

      <DriveFixtureCard
        state={driveFixtureState}
        busy={driveFixtureBusy}
        onSelect={() => void runDriveFixtureAction("select")}
        onRead={(selectionId) =>
          void runDriveFixtureAction("read", selectionId)
        }
        onDeselect={(selectionId) =>
          void runDriveFixtureAction("deselect", selectionId)
        }
      />

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
