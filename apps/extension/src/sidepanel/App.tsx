import { useEffect, useReducer, useRef, useState } from "react";
import {
  type ActionProposal,
  AgentApiClient,
  type AgentRunResponse,
  type AgentToolResultRequest,
  DEFAULT_AGENT_API_BASE,
  type OrbitEvent,
} from "../api/client";
import { requestOriginPermission } from "../chat/access-policy";
import { ChatPanel } from "../chat/ChatPanel";
import {
  type CalendarConnector,
  type CalendarConnectorResult,
  type CalendarEventView,
  formatAvailabilitySummary,
  projectCalendarAvailability,
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
import {
  type PageContext,
  type PageKind,
  projectScombzPageSummary,
} from "../content/page-context";
import {
  type CalendarCommand,
  calendarCommandMessage,
  type DriveCommand,
  driveCommandMessage,
  isPageContext,
  isPageContextUpdatedMessage,
  isWorkspaceOwnershipChangedMessage,
  isWorkspaceSourceUnavailableMessage,
  MESSAGE_TYPES,
  type MoodleReadResponse,
  type MyLibraryReadResponse,
  type OpenWorkspaceResponse,
  type WorkspaceStatusResponse,
} from "../shared/messages";
import type { WorkspaceSession } from "../shared/workspace-session";
import {
  B1_OMIYA_CONTEXT,
  B1_OMIYA_EVENT,
  isSafeB1Proposal,
  isSyntheticOrPublic,
} from "./b1-fixture";
import {
  agentLoopReducer,
  hydrateAgentLoopState,
  initialAgentLoopState,
  toStableAgentLoopSnapshot,
} from "./loop-state";

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

type CampusServiceConnectionStatus =
  | "not_connected"
  | "connected"
  | "reauth_required"
  | "unavailable";

function CampusServiceCard({
  id,
  title,
  description,
  status,
  busy,
  message,
  onOpen,
  onRefresh,
}: {
  id: string;
  title: string;
  description: string;
  status: CampusServiceConnectionStatus;
  busy: boolean;
  message: string | null;
  onOpen: () => void;
  onRefresh: () => void;
}) {
  const label = {
    not_connected: "未接続",
    connected: "接続済み",
    reauth_required: "再認証が必要",
    unavailable: "利用できません",
  }[status];
  return (
    <section className="connector-card" aria-labelledby={id}>
      <div className="section-heading">
        <h2 id={id}>{title}</h2>
        <span className="section-note">{label}</span>
      </div>
      <p className="connector-description">{message ?? description}</p>
      <div className="button-row">
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={onOpen}
        >
          開く
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={onRefresh}
        >
          {busy ? "確認中…" : "再確認"}
        </button>
      </div>
    </section>
  );
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

function toolDisplayName(
  toolName: "scombz_page_summary" | "google_calendar_availability" | null,
): string {
  return toolName === "scombz_page_summary"
    ? "ScombZページ概要"
    : toolName === "google_calendar_availability"
      ? "Google Calendar"
      : "Agent Tool";
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
  mode?: "sidepanel" | "workspace";
  workspaceSession?: WorkspaceSession;
}

function openWorkspace(
  stableState: NonNullable<ReturnType<typeof toStableAgentLoopSnapshot>>,
): Promise<OpenWorkspaceResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: MESSAGE_TYPES.openWorkspace, stable_state: stableState },
      (response: OpenWorkspaceResponse | undefined) => {
        if (chrome.runtime.lastError || !response) {
          resolve({ ok: false, error: "全画面タブを開けませんでした。" });
          return;
        }
        resolve(response);
      },
    );
  });
}

function requestWorkspaceStatus(): Promise<WorkspaceStatusResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: MESSAGE_TYPES.getWorkspaceStatus },
      (response: WorkspaceStatusResponse | undefined) => {
        if (chrome.runtime.lastError || !response) {
          resolve({ active: false, session: null, sourceTabId: null });
          return;
        }
        resolve(response);
      },
    );
  });
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
  mode = "sidepanel",
  workspaceSession,
}: AppProps) {
  const [pageContext, setPageContext] = useState<PageContext | null>(
    workspaceSession?.pageContext ?? null,
  );
  const [loopState, dispatch] = useReducer(
    agentLoopReducer,
    workspaceSession?.stableState,
    (snapshot) =>
      snapshot ? hydrateAgentLoopState(snapshot) : initialAgentLoopState,
  );
  const [workspaceActive, setWorkspaceActive] = useState(mode === "workspace");
  const boundSourceTabId = useRef<number | null>(
    workspaceSession?.sourceTabId ?? null,
  );
  const [workspaceSourceAvailable, setWorkspaceSourceAvailable] = useState(
    workspaceSession?.sourceAvailable ?? true,
  );
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
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
  const [moodleStatus, setMoodleStatus] =
    useState<CampusServiceConnectionStatus>("not_connected");
  const [moodleMessage, setMoodleMessage] = useState<string | null>(null);
  const [moodleBusy, setMoodleBusy] = useState(false);
  const [myLibraryStatus, setMyLibraryStatus] =
    useState<CampusServiceConnectionStatus>("not_connected");
  const [myLibraryMessage, setMyLibraryMessage] = useState<string | null>(null);
  const [myLibraryBusy, setMyLibraryBusy] = useState(false);
  const [driveFixtureConnector, setDriveFixtureConnector] = useState(() =>
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
      if (action === "deselect" && result.status === "not_connected") {
        setDriveFixtureConnector(
          createFixtureDriveConnector({
            candidates: DRIVE_FIXTURE_CANDIDATE,
            selectionIdFactory: () => "sel_fixture_drive_1",
          }),
        );
      }
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

  const runMoodleAction = async (action: "open" | "refresh"): Promise<void> => {
    setMoodleBusy(true);
    setMoodleMessage(null);
    try {
      const granted = await requestOriginPermission(
        "https://moodle.sic.shibaura-it.ac.jp/*",
      );
      if (!granted) {
        setMoodleStatus("not_connected");
        setMoodleMessage("Moodleの読み取り許可が得られませんでした。");
        return;
      }
      if (action === "open") {
        await new Promise<void>((resolve, reject) => {
          chrome.runtime.sendMessage(
            { type: MESSAGE_TYPES.moodleOpen },
            (response: { ok?: boolean } | undefined) => {
              if (chrome.runtime.lastError || !response?.ok)
                reject(new Error("open failed"));
              else resolve();
            },
          );
        });
        setMoodleStatus("reauth_required");
        setMoodleMessage(
          "Moodleを開きました。ログイン後に再確認してください。",
        );
        return;
      }
      const result = await new Promise<MoodleReadResponse>(
        (resolve, reject) => {
          chrome.runtime.sendMessage(
            {
              type: MESSAGE_TYPES.moodleRead,
              tool_call_id: "connection-check",
            },
            (response: MoodleReadResponse | undefined) => {
              if (chrome.runtime.lastError || !response)
                reject(new Error("read failed"));
              else resolve(response);
            },
          );
        },
      );
      if (result.status === "known") {
        setMoodleStatus("connected");
        setMoodleMessage(
          "ダッシュボードを読み取れます。詳細は保存していません。",
        );
      } else if (result.status === "reauth_required") {
        setMoodleStatus("reauth_required");
        setMoodleMessage("Moodleへログインしてから再確認してください。");
      } else {
        setMoodleStatus("unavailable");
        setMoodleMessage(
          "Moodleの画面構造または接続状態を確認できませんでした。",
        );
      }
    } catch {
      setMoodleStatus("unavailable");
      setMoodleMessage(
        "Moodleを利用できません。時間をおいて再試行してください。",
      );
    } finally {
      setMoodleBusy(false);
    }
  };

  const runMyLibraryAction = async (
    action: "open" | "refresh",
  ): Promise<void> => {
    setMyLibraryBusy(true);
    setMyLibraryMessage(null);
    try {
      const granted = await requestOriginPermission(
        "https://library.shibaura-it.ac.jp/*",
      );
      if (!granted) {
        setMyLibraryStatus("not_connected");
        setMyLibraryMessage("My Libraryの読み取り許可が得られませんでした。");
        return;
      }
      if (action === "open") {
        await new Promise<void>((resolve, reject) => {
          chrome.runtime.sendMessage(
            { type: MESSAGE_TYPES.myLibraryOpen },
            (response: { ok?: boolean } | undefined) => {
              if (chrome.runtime.lastError || !response?.ok)
                reject(new Error("open failed"));
              else resolve();
            },
          );
        });
        setMyLibraryStatus("reauth_required");
        setMyLibraryMessage(
          "My Libraryを開きました。ログイン後に再確認してください。",
        );
        return;
      }
      const result = await new Promise<MyLibraryReadResponse>(
        (resolve, reject) => {
          chrome.runtime.sendMessage(
            {
              type: MESSAGE_TYPES.myLibraryRead,
              tool_call_id: "connection-check",
            },
            (response: MyLibraryReadResponse | undefined) => {
              if (chrome.runtime.lastError || !response)
                reject(new Error("read failed"));
              else resolve(response);
            },
          );
        },
      );
      if (result.status === "known") {
        setMyLibraryStatus("connected");
        setMyLibraryMessage(
          "貸出・予約状況を読み取れます。詳細は保存していません。",
        );
      } else if (result.status === "reauth_required") {
        setMyLibraryStatus("reauth_required");
        setMyLibraryMessage("My Libraryへログインしてから再確認してください。");
      } else {
        setMyLibraryStatus("unavailable");
        setMyLibraryMessage(
          "My Libraryの画面構造または接続状態を確認できませんでした。",
        );
      }
    } catch {
      setMyLibraryStatus("unavailable");
      setMyLibraryMessage(
        "My Libraryを利用できません。時間をおいて再試行してください。",
      );
    } finally {
      setMyLibraryBusy(false);
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
      if (
        mounted &&
        mode === "sidepanel" &&
        isPageContextUpdatedMessage(message)
      ) {
        setPageContext(message.context);
      }
      if (
        mounted &&
        mode === "sidepanel" &&
        isWorkspaceOwnershipChangedMessage(message) &&
        boundSourceTabId.current === message.session.sourceTabId
      ) {
        setWorkspaceActive(message.active);
        setPageContext(message.session.pageContext);
        dispatch({
          type: "state-hydrated",
          state: message.session.stableState,
        });
      }
      if (
        mounted &&
        mode === "workspace" &&
        workspaceSession &&
        isWorkspaceOwnershipChangedMessage(message) &&
        message.session.sessionId === workspaceSession.sessionId
      ) {
        setPageContext(message.session.pageContext);
        setWorkspaceSourceAvailable(message.session.sourceAvailable);
      }
      if (
        mounted &&
        mode === "workspace" &&
        workspaceSession &&
        isWorkspaceSourceUnavailableMessage(message) &&
        message.session_id === workspaceSession.sessionId
      ) {
        setWorkspaceSourceAvailable(false);
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    if (mode === "sidepanel") {
      void Promise.all([requestPageContext(), requestWorkspaceStatus()]).then(
        ([context, workspaceStatus]) => {
          if (!mounted) {
            return;
          }
          setPageContext(workspaceStatus.session?.pageContext ?? context);
          setWorkspaceActive(workspaceStatus.active);
          boundSourceTabId.current = workspaceStatus.sourceTabId;
          if (workspaceStatus.session) {
            dispatch({
              type: "state-hydrated",
              state: workspaceStatus.session.stableState,
            });
          }
        },
      );
    }

    return () => {
      mounted = false;
      chrome.runtime.onMessage.removeListener(handleMessage);
    };
  }, [mode, workspaceSession]);

  useEffect(() => {
    if (mode !== "workspace" || !workspaceSession) {
      return;
    }
    const stableState = toStableAgentLoopSnapshot(loopState);
    if (!stableState) {
      return;
    }
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.updateWorkspaceSession,
      session_id: workspaceSession.sessionId,
      stable_state: stableState,
    });
  }, [loopState, mode, workspaceSession]);

  const handleOpenWorkspace = async (): Promise<void> => {
    const stableState = toStableAgentLoopSnapshot(loopState);
    if (!stableState) {
      return;
    }
    setWorkspaceError(null);
    const response = await openWorkspace(stableState);
    if (!response.ok) {
      setWorkspaceError(response.error ?? "全画面タブを開けませんでした。");
      return;
    }
    setWorkspaceActive(true);
    boundSourceTabId.current =
      response.session?.sourceTabId ?? boundSourceTabId.current;
  };

  const interactionLocked =
    (mode === "sidepanel" && workspaceActive) ||
    (mode === "workspace" && !workspaceSourceAvailable);

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
      const clientTools: Array<{
        name: "scombz_page_summary" | "google_calendar_availability";
        version: 1;
      }> = [];
      if (projectScombzPageSummary(pageContext) !== null) {
        clientTools.push({ name: "scombz_page_summary", version: 1 });
      }
      if (calendarState.status === "connected" && calendarState.snapshot) {
        clientTools.push({ name: "google_calendar_availability", version: 1 });
      }

      let runResponse: AgentRunResponse = await agentApiClient.startRun({
        event: B1_OMIYA_EVENT,
        context: [...B1_OMIYA_CONTEXT, ...fixtureEvidence],
        client_tools: clientTools,
      });
      const usedToolNames = new Set<string>();
      const seenToolCallIds = new Set<string>();
      let activeRunId: string | null = null;
      while (runResponse.status === "tool_required") {
        if (activeRunId === null) {
          activeRunId = runResponse.run_id;
        } else if (runResponse.run_id !== activeRunId) {
          throw new Error("Agent run IDが再開中に変更されました。");
        }
        const [call] = runResponse.calls;
        if (!call) {
          throw new Error("AgentからのTool呼び出しが見つかりません。");
        }
        if (
          (call.name !== "scombz_page_summary" &&
            call.name !== "google_calendar_availability") ||
          call.version !== 1 ||
          usedToolNames.has(call.name) ||
          seenToolCallIds.has(call.tool_call_id) ||
          !clientTools.some(
            (tool) => tool.name === call.name && tool.version === call.version,
          )
        ) {
          throw new Error("未広告または重複したAgent Tool呼び出しです。");
        }
        usedToolNames.add(call.name);
        seenToolCallIds.add(call.tool_call_id);
        dispatch({
          type: "tool-started",
          runId: runResponse.run_id,
          toolCallId: call.tool_call_id,
          toolName: call.name,
        });

        let toolResult: AgentToolResultRequest["result"];
        if (call.name === "scombz_page_summary") {
          const summary = projectScombzPageSummary(pageContext);
          if (summary === null) {
            throw new Error(
              "解析済みのScombZページがないため、ページ概要を送信できません。",
            );
          }
          toolResult = summary;
        } else {
          const refreshed = calendarConnector
            ? await calendarConnector.refresh()
            : await calendarRequest("refresh");
          setCalendarState(refreshed);
          if (refreshed.status === "reauth_required") {
            dispatch({
              type: "reauth-required",
              error: refreshed.message ?? "Google Calendarの再認証が必要です。",
            });
            return;
          }
          if (refreshed.status !== "connected" || !refreshed.snapshot) {
            throw new Error(
              refreshed.message ??
                "Google Calendarの空き時間を取得できなかったため、提案を続行できません。",
            );
          }
          toolResult = projectCalendarAvailability(refreshed.snapshot);
        }

        dispatch({ type: "resume-started" });
        runResponse = await agentApiClient.submitToolResult(
          runResponse.run_id,
          {
            tool_call_id: call.tool_call_id,
            name: call.name,
            version: call.version,
            result: toolResult,
          },
        );
      }
      if (runResponse.status !== "completed") {
        throw new Error("Agent Toolの線形再開が完了しませんでした。");
      }
      const proposal = runResponse.proposal;
      if (!isSafeB1Proposal(proposal)) {
        throw new Error(
          "synthetic/public または導出済みScombZ概要・Calendar空き時間だけを表示できます。",
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
    <main
      className={`panel-shell ${mode === "workspace" ? "workspace-shell" : "sidepanel-shell"}`}
      data-display-mode={mode}
    >
      <header className="panel-header">
        <div>
          <p className="eyebrow">SIT ORBIT</p>
          <h1>次の一歩を、軽く。</h1>
        </div>
        <div className="header-actions">
          <span className="status-badge">
            {mode === "workspace" ? "全画面表示" : "ローカル表示"}
          </span>
          {mode === "sidepanel" ? (
            <button
              type="button"
              className="icon-button"
              aria-label="全画面で開く"
              title="全画面で開く"
              onClick={() => void handleOpenWorkspace()}
              disabled={toStableAgentLoopSnapshot(loopState) === null}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M8 3H3v5h2V5h3V3Zm8 0v2h3v3h2V3h-5ZM5 16H3v5h5v-2H5v-3Zm16 0h-2v3h-3v2h5v-5Z" />
              </svg>
            </button>
          ) : null}
        </div>
      </header>

      {mode === "sidepanel" && workspaceActive ? (
        <p className="workspace-notice" role="status">
          全画面ワークスペースで操作中です。このSide Panelは読み取り専用です。
        </p>
      ) : null}
      {mode === "workspace" && !workspaceSourceAvailable ? (
        <p className="error-message" role="alert">
          接続元のScombZタブが閉じられたか、別ページへ移動しました。ScombZを開き直してSide
          Panelから再接続してください。
        </p>
      ) : null}
      {workspaceError ? (
        <p className="error-message" role="alert">
          {workspaceError}
        </p>
      ) : null}

      <div className="orbit-body">
        <aside className="orbit-sidebar" aria-label="接続情報">
          <section
            className="context-card"
            aria-labelledby="page-context-title"
          >
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

          <details className="connector-settings">
            <summary>接続設定</summary>
            <CalendarCard
              state={calendarState}
              busy={calendarBusy || interactionLocked}
              onConnect={() => void runCalendarAction("connect")}
              onRefresh={() => void runCalendarAction("refresh")}
              onReauthenticate={() => void runCalendarAction("reauthenticate")}
              onDisconnect={() => void runCalendarAction("disconnect")}
            />

            <DriveCard
              state={driveState}
              busy={driveBusy || interactionLocked}
              onSelect={() => void runDriveAction("select")}
              onRead={(selectionId) => void runDriveAction("read", selectionId)}
              onDeselect={(selectionId) =>
                void runDriveAction("deselect", selectionId)
              }
            />

            <CampusServiceCard
              id="moodle-title"
              title="SIT Moodle"
              description="ダッシュボードは明示的に確認したときだけ読み取ります。詳細は端末内に留めます。"
              status={moodleStatus}
              busy={moodleBusy || interactionLocked}
              message={moodleMessage}
              onOpen={() => void runMoodleAction("open")}
              onRefresh={() => void runMoodleAction("refresh")}
            />

            <CampusServiceCard
              id="my-library-title"
              title="My Library"
              description="貸出・予約状況は明示的に確認したときだけ読み取ります。書名などの詳細は端末内に留めます。"
              status={myLibraryStatus}
              busy={myLibraryBusy || interactionLocked}
              message={myLibraryMessage}
              onOpen={() => void runMyLibraryAction("open")}
              onRefresh={() => void runMyLibraryAction("refresh")}
            />

            <DriveFixtureCard
              state={driveFixtureState}
              busy={driveFixtureBusy || interactionLocked}
              onSelect={() => void runDriveFixtureAction("select")}
              onRead={(selectionId) =>
                void runDriveFixtureAction("read", selectionId)
              }
              onDeselect={(selectionId) =>
                void runDriveFixtureAction("deselect", selectionId)
              }
            />
          </details>
        </aside>
        <section className="orbit-conversation" aria-label="Agentとの対話">
          <ChatPanel
            pageContext={pageContext}
            calendarState={calendarState}
            calendarConnector={calendarConnector}
            calendarRequest={(command) => calendarRequest(command)}
            disabled={interactionLocked}
          />
          <details className="developer-demo-menu">
            <summary>開発・デモメニュー</summary>
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
                    interactionLocked ||
                    loopState.status === "proposing" ||
                    loopState.status === "tool-running" ||
                    loopState.status === "resuming" ||
                    loopState.status === "verifying"
                  }
                >
                  {loopState.status === "proposing"
                    ? "提案を取得中…"
                    : loopState.status === "tool-running"
                      ? `${toolDisplayName(loopState.pendingToolName)}を処理中…`
                      : loopState.status === "resuming"
                        ? "提案を再開中…"
                        : loopState.proposal
                          ? "B1 大宮の提案を再取得"
                          : "B1 大宮の提案を作成"}
                </button>
                <p className="action-note">
                  {projectScombzPageSummary(pageContext) !== null ||
                  (calendarState.status === "connected" &&
                    calendarState.snapshot)
                    ? "ボタンを押したときだけ、合成データと必要な最小化済みのページ概要・空き時間をローカル Agent API に送ります。予定名などを除いた空き時間もAPI経由で選択中のモデルへ送ります。"
                    : "ボタンを押したときだけ、合成データをローカル Agent API に送ります。"}
                </p>
                {loopState.status === "tool-running" ? (
                  <p className="state-message" data-agent-status="tool-running">
                    {toolDisplayName(loopState.pendingToolName)}
                    を準備しています。
                    {loopState.pendingToolName ===
                    "google_calendar_availability"
                      ? "認証画面は自動では開きません。"
                      : "表示中のページから件数だけをまとめています。"}
                  </p>
                ) : null}
                {loopState.status === "resuming" ? (
                  <p className="state-message" data-agent-status="resuming">
                    {toolDisplayName(loopState.pendingToolName)}
                    の導出結果をAgentへ渡して提案を再開しています。
                  </p>
                ) : null}
                {loopState.status === "reauth_required" ? (
                  <p
                    className="state-message"
                    data-agent-status="reauth-required"
                  >
                    Calendarの再認証が必要です。明示的に再認証してから、提案ボタンを押してください。
                  </p>
                ) : null}
              </div>
            </section>
          </details>

          {loopState.error ? (
            <p className="error-message" role="alert">
              {loopState.error}
            </p>
          ) : null}

          {loopState.proposal ? (
            <section className="proposal-card" aria-labelledby="proposal-title">
              <div className="section-heading">
                <h2 id="proposal-title">Agent APIからの提案</h2>
                <span className="fixture-label">
                  {loopState.proposal.evidence.some(
                    (evidence) =>
                      evidence.source_type === "calendar" &&
                      evidence.data_classification === "personal",
                  )
                    ? loopState.proposal.evidence.some(
                        (evidence) =>
                          evidence.source_type === "scombz" &&
                          evidence.data_classification === "personal",
                      )
                      ? "合成＋ScombZ概要＋Calendar空き時間"
                      : "合成＋Calendar空き時間"
                    : loopState.proposal.evidence.some(
                          (evidence) =>
                            evidence.source_type === "scombz" &&
                            evidence.data_classification === "personal",
                        )
                      ? "合成＋ScombZ概要"
                      : "合成データ"}
                </span>
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
                      disabled={interactionLocked}
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
                      disabled={interactionLocked}
                    >
                      提案を承認する
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={rejectProposal}
                      disabled={interactionLocked}
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
                    disabled={
                      interactionLocked || loopState.status === "verifying"
                    }
                  >
                    {loopState.status === "verifying"
                      ? "完了を記録中…"
                      : "完了を確認して記録する"}
                  </button>
                </div>
              ) : null}

              {loopState.status === "completed" ? (
                <p className="state-message success-message">
                  完了を記録しました。下の action_completed
                  イベントを確認できます。
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

          {mode === "workspace" ? (
            <section
              className="workspace-action-bar"
              aria-labelledby="workspace-action-title"
            >
              <div>
                <strong id="workspace-action-title">
                  {loopState.status === "proposed"
                    ? "提案を確認してください"
                    : loopState.status === "approved"
                      ? "行動後に完了を記録できます"
                      : loopState.status === "tool-running" ||
                          loopState.status === "resuming"
                        ? "Agent Toolを実行しています"
                        : "次の一歩をAgentに提案させます"}
                </strong>
                <small>対応している操作だけを表示しています。</small>
              </div>
              <div className="button-row">
                {loopState.status === "proposed" ? (
                  <>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={approveProposal}
                      disabled={interactionLocked}
                    >
                      提案を承認する
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={rejectProposal}
                      disabled={interactionLocked}
                    >
                      却下する
                    </button>
                  </>
                ) : loopState.status === "approved" ||
                  loopState.status === "verifying" ? (
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void verifyCompletion()}
                    disabled={
                      interactionLocked || loopState.status === "verifying"
                    }
                  >
                    {loopState.status === "verifying"
                      ? "完了を記録中…"
                      : "完了を確認して記録する"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void requestProposal()}
                    disabled={
                      interactionLocked ||
                      loopState.status === "proposing" ||
                      loopState.status === "tool-running" ||
                      loopState.status === "resuming"
                    }
                  >
                    {loopState.status === "proposing"
                      ? "提案を取得中…"
                      : loopState.status === "tool-running"
                        ? `${toolDisplayName(loopState.pendingToolName)}を処理中…`
                        : loopState.status === "resuming"
                          ? "提案を再開中…"
                          : loopState.proposal
                            ? "次の提案を作成"
                            : "次の一歩を提案"}
                  </button>
                )}
              </div>
            </section>
          ) : null}

          <p className="footer-note">
            この静的fixture自体は提案の作成や外部サービスへの書き込みは行いません。
            Agent APIへの接続は、提案作成と完了記録を押したときだけです。
          </p>
        </section>
      </div>
    </main>
  );
}
