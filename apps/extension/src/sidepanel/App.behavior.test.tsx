import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ActionProposal,
  AZURE_DEMO_AGENT_API_BASE,
  type OrbitEvent,
} from "../api/client";
import type {
  CalendarConnector,
  CalendarConnectorResult,
} from "../connectors/google-calendar";
import {
  isCalendarCommandMessage,
  isDriveCommandMessage,
  MESSAGE_TYPES,
} from "../shared/messages";
import { App } from "./App";
import {
  buttonByName,
  click,
  type MountedSidePanel,
  mountSidePanel,
  unmountSidePanel,
  waitFor,
} from "./ui-test-helpers";

const API_BASE = AZURE_DEMO_AGENT_API_BASE;

const validEvidence: ActionProposal["evidence"][number] = {
  evidence_id: "ev-assignment-calculus-01",
  title: "微分積分学の課題は明日締切",
  source_type: "assignment",
  locator: "demo://scombz/assignments/calculus-01",
  data_classification: "synthetic",
};

const validProposal: ActionProposal = {
  action_id: "act-b1-omiya",
  title: "合成関数の微分を2問確認する",
  reason: "明日の課題と利用可能時間に合うためです。",
  duration_minutes: 12,
  evidence: [validEvidence],
  external_action: "checklist_update",
  requires_confirmation: true,
  prompt_version: "fixture-b1-omiya-v1",
};

const completedRun = {
  status: "completed" as const,
  proposal: validProposal,
};

const validCompletionEvent: OrbitEvent = {
  event_id: "evt-b1-omiya-completed",
  event_type: "action_completed",
  scenario_id: "b1-omiya-calculus",
  occurred_at: "2026-08-12T14:40:00+09:00",
  campus: "omiya",
  data_classification: "synthetic",
  payload: {
    action_id: validProposal.action_id,
    approved: true,
    completed: true,
    notes: "",
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function nonJsonResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => {
      throw new SyntaxError("Unexpected token");
    }),
  } as unknown as Response;
}

function responseSequence(
  responses: Array<Response | Error>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error("Unexpected extra request in test.");
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  });
}

function requestBody(fetcher: ReturnType<typeof vi.fn>, index: number) {
  const init = fetcher.mock.calls[index]?.[1] as RequestInit | undefined;
  if (typeof init?.body !== "string") {
    throw new Error("Expected a JSON request body.");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function connectedCalendarResult(): CalendarConnectorResult {
  return {
    status: "connected",
    snapshot: {
      timeZone: "Asia/Tokyo",
      timeMin: "2026-08-15T00:00:00+09:00",
      timeMax: "2026-08-22T00:00:00+09:00",
      events: [],
      availability: {
        status: "known",
        availableMinutes: 10080,
        busyMinutes: 0,
        intervals: [],
      },
      truncated: false,
      fetchedAt: "2026-08-15T03:00:00.000Z",
    },
  };
}

function unavailableDriveRequest() {
  return vi.fn(async () => ({
    status: "unavailable" as const,
    selections: [],
    message: "Google Driveのファイル選択はまだ利用できません。",
    retryable: false,
  }));
}

async function openProposal(
  fetcher: ReturnType<typeof vi.fn>,
): Promise<MountedSidePanel> {
  vi.stubGlobal("fetch", fetcher);
  const mounted = await mountSidePanel(() => <App />);
  expect(fetcher).not.toHaveBeenCalled();

  await click(buttonByName(mounted.document, "B1 大宮の提案を作成"));
  await waitFor(() =>
    Boolean(
      mounted.document.querySelector('[aria-labelledby="proposal-title"]'),
    ),
  );
  return mounted;
}

describe("Side Panel B1 agent loop behavior", () => {
  let mounted: MountedSidePanel | undefined;

  const cleanup = async () => {
    if (mounted) {
      await unmountSidePanel(mounted.root);
      mounted = undefined;
    }
  };

  afterEach(cleanup);

  it("discloses the Azure Grounding with Bing data boundary in shared Chat UI", async () => {
    mounted = await mountSidePanel(() => <App />);

    expect(mounted.document.body.textContent).toContain(
      "一般Web検索を使う場合、公開情報の検索語はGrounding with Bingへ送信され、Azureの通常の地理・DPA境界外で処理されます。",
    );
  });

  it("keeps technical settings out of the Agent surface and restores focus after closing the drawer", async () => {
    mounted = await mountSidePanel(() => <App />);

    const chatPanel = mounted.document.querySelector(".chat-panel");
    expect(chatPanel?.textContent).not.toContain("Endpoint");
    expect(chatPanel?.textContent).not.toContain("Access token");
    expect(chatPanel?.textContent).not.toContain("B1 大宮の提案を作成");

    const settingsButton = mounted.document.querySelector(
      'button[aria-label="設定"]',
    );
    if (!(settingsButton instanceof HTMLElement)) {
      throw new Error("Settings button was not rendered.");
    }
    const closeButton = mounted.document.querySelector(
      '.settings-header button[aria-label="設定を閉じる"]',
    );
    if (!(closeButton instanceof HTMLElement)) {
      throw new Error("Settings close button was not rendered.");
    }
    const settingsFocus = vi.spyOn(settingsButton, "focus");
    const closeFocus = vi.spyOn(closeButton, "focus");
    await click(settingsButton);
    expect(
      mounted.document
        .querySelector(".settings-backdrop")
        ?.hasAttribute("hidden"),
    ).toBe(false);
    expect(closeFocus).toHaveBeenCalled();

    await click(closeButton);
    expect(
      mounted.document
        .querySelector(".settings-backdrop")
        ?.hasAttribute("hidden"),
    ).toBe(true);
    expect(settingsFocus).toHaveBeenCalled();
  });

  it("copies and clears session-only OPAC diagnostics from development settings", async () => {
    const writeText = vi.fn(async (_value: string) => undefined);
    mounted = await mountSidePanel(
      () => <App />,
      (runtime) => {
        runtime.sendMessage.mockImplementation(
          (
            message: { type?: string },
            callback?: (response: unknown) => void,
          ) => {
            if (message.type === MESSAGE_TYPES.opacDiagnosticsGet) {
              callback?.({
                schema_version: "v1",
                events: [
                  {
                    schema_version: "v1",
                    occurred_at: "2026-08-24T00:00:00.000Z",
                    operation_id: "operation-1",
                    query: "ROS 2 入門",
                    phase: "search_completed",
                    route_kind: "single_record",
                    result_count: 1,
                    duration_ms: 120,
                    status: "known",
                    reason_code: null,
                  },
                ],
              });
            } else if (message.type === MESSAGE_TYPES.opacDiagnosticsClear) {
              callback?.({ ok: true });
            } else {
              callback?.(null);
            }
          },
        );
      },
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const settingsButton = mounted.document.querySelector(
      'button[aria-label="設定"]',
    );
    if (!(settingsButton instanceof HTMLElement)) {
      throw new Error("Settings button was not rendered.");
    }
    await click(settingsButton);
    await waitFor(
      () => mounted?.document.body.textContent?.includes("現在1件") ?? false,
    );

    await click(buttonByName(mounted.document, "OPAC診断ログをコピー"));
    await waitFor(() => writeText.mock.calls.length === 1);
    expect(writeText.mock.calls[0]?.[0]).toContain("ROS 2 入門");
    expect(mounted.document.body.textContent).toContain(
      "OPAC診断ログ 1件をコピーしました。",
    );

    await click(buttonByName(mounted.document, "OPAC診断ログを消去"));
    await waitFor(
      () =>
        mounted?.document.body.textContent?.includes(
          "OPAC診断ログを消去しました。",
        ) ?? false,
    );
    expect(mounted.document.body.textContent).toContain("現在0件");
  });

  it("requests the synthetic campus_entered proposal once, only after an explicit click", async () => {
    const fetcher = responseSequence([jsonResponse(completedRun)]);
    mounted = await openProposal(fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${API_BASE}/v1/agent/runs`);
    expect(requestBody(fetcher, 0)).toMatchObject({
      event: {
        event_type: "campus_entered",
        campus: "omiya",
        data_classification: "synthetic",
      },
      client_tools: [],
    });
    expect(
      (requestBody(fetcher, 0).context as Array<Record<string, unknown>>).every(
        (evidence) =>
          evidence.data_classification === "synthetic" ||
          evidence.data_classification === "public",
      ),
    ).toBe(true);
  });

  it("advertises the Calendar tool only after an explicit connected state", async () => {
    const fetcher = responseSequence([jsonResponse(completedRun)]);
    const calendarResult = connectedCalendarResult();
    const calendarConnector: CalendarConnector = {
      connect: vi.fn(async () => calendarResult),
      refresh: vi.fn(async () => calendarResult),
      reauthenticate: vi.fn(async () => calendarResult),
      disconnect: vi.fn(async () => ({ status: "not_connected" as const })),
    };
    vi.stubGlobal("fetch", fetcher);
    mounted = await mountSidePanel(() => (
      <App
        calendarConnector={calendarConnector}
        driveRequest={unavailableDriveRequest()}
      />
    ));

    await click(buttonByName(mounted.document, "Google Calendarを接続"));
    await waitFor(
      () =>
        mounted?.document.querySelector(
          '[data-calendar-status="connected"]',
        ) !== null,
    );
    expect(mounted.document.body.textContent).toContain(
      "予定名などを除いた空き時間もAPI経由で選択中のモデルへ送ります。",
    );
    await click(buttonByName(mounted.document, "B1 大宮の提案を作成"));
    await waitFor(
      () =>
        mounted?.document.querySelector(
          '[aria-labelledby="proposal-title"]',
        ) !== null,
    );

    expect(requestBody(fetcher, 0).client_tools).toEqual([
      { name: "google_calendar_availability", version: 1 },
    ]);
  });

  it("labels proposals that include personal Calendar availability evidence", async () => {
    const calendarProposal: ActionProposal = {
      ...validProposal,
      evidence: [
        ...validProposal.evidence,
        {
          evidence_id: "calendar-availability-v1-run-1",
          title: "Calendarから導出した空き時間",
          source_type: "calendar",
          locator: "orbit-calendar://availability/run-1",
          data_classification: "personal",
        },
      ],
    };
    const fetcher = responseSequence([
      jsonResponse({ status: "completed", proposal: calendarProposal }),
    ]);
    mounted = await openProposal(fetcher);

    const proposalCard = mounted.document.querySelector(
      '[aria-labelledby="proposal-title"]',
    );
    expect(proposalCard?.textContent).toContain("合成＋Calendar空き時間");
  });

  it.each([
    ["reauth_required", "再認証が必要です。"],
    ["unavailable", "Calendar unavailable"],
  ] as const)(
    "does not resume or complete a run when Calendar is %s",
    async (status, message) => {
      const toolRequired = {
        status: "tool_required" as const,
        run_id: "run-calendar-1",
        calls: [
          {
            tool_call_id: "calendar-call-1",
            name: "google_calendar_availability" as const,
            version: 1 as const,
          },
        ],
      };
      const connected = connectedCalendarResult();
      const failure: CalendarConnectorResult =
        status === "reauth_required"
          ? { status, message }
          : { status, message, retryable: false };
      const calendarConnector: CalendarConnector = {
        connect: vi.fn(async () => connected),
        refresh: vi.fn(async () => failure),
        reauthenticate: vi.fn(async () => connected),
        disconnect: vi.fn(async () => ({ status: "not_connected" as const })),
      };
      const fetcher = responseSequence([jsonResponse(toolRequired)]);
      vi.stubGlobal("fetch", fetcher);
      mounted = await mountSidePanel(() => (
        <App
          calendarConnector={calendarConnector}
          driveRequest={unavailableDriveRequest()}
        />
      ));

      await click(buttonByName(mounted.document, "Google Calendarを接続"));
      await waitFor(
        () =>
          mounted?.document.querySelector(
            '[data-calendar-status="connected"]',
          ) !== null,
      );
      await click(buttonByName(mounted.document, "B1 大宮の提案を作成"));
      await waitFor(
        () =>
          mounted?.document.querySelector('[role="alert"]') !== null ||
          mounted?.document.querySelector(
            '[data-agent-status="reauth-required"]',
          ) !== null,
      );

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]?.[0]).toBe(`${API_BASE}/v1/agent/runs`);
      expect(
        mounted.document.querySelector('[aria-labelledby="proposal-title"]'),
      ).toBeNull();
      expect(
        fetcher.mock.calls.some(([input]) =>
          String(input).includes("tool-results"),
        ),
      ).toBe(false);
      if (status === "reauth_required") {
        expect(
          mounted.document.querySelector(
            '[data-agent-status="reauth-required"]',
          ),
        ).not.toBeNull();
      }
    },
  );

  it("renders evidence and accepts public evidence while excluding unsafe or empty evidence proposals", async () => {
    const publicProposal: ActionProposal = {
      ...validProposal,
      evidence: [
        {
          ...validEvidence,
          data_classification: "public",
          title: "公開シラバスの締切情報",
        },
      ],
    };
    const fetcher = responseSequence([
      jsonResponse({ status: "completed", proposal: publicProposal }),
    ]);
    mounted = await openProposal(fetcher);

    expect(mounted.document.body.textContent).toContain(
      "公開シラバスの締切情報",
    );
    expect(mounted.document.body.textContent).toContain("public");
    await cleanup();

    for (const dataClassification of ["personal", "restricted"] as const) {
      const unsafeProposal = {
        ...validProposal,
        evidence: [
          { ...validEvidence, data_classification: dataClassification },
        ],
      };
      const unsafeFetcher = responseSequence([
        jsonResponse({ status: "completed", proposal: unsafeProposal }),
      ]);
      vi.stubGlobal("fetch", unsafeFetcher);
      mounted = await mountSidePanel(() => <App />);
      await click(buttonByName(mounted.document, "B1 大宮の提案を作成"));
      await waitFor(() =>
        Boolean(mounted?.document.querySelector('[role="alert"]')),
      );
      expect(mounted.document.body.textContent).not.toContain(
        validProposal.title,
      );
      expect(mounted.document.querySelector('[role="alert"]')).not.toBeNull();
      await cleanup();
    }

    const emptyEvidenceFetcher = responseSequence([
      jsonResponse({
        status: "completed",
        proposal: { ...validProposal, evidence: [] },
      }),
    ]);
    vi.stubGlobal("fetch", emptyEvidenceFetcher);
    mounted = await mountSidePanel(() => <App />);
    await click(buttonByName(mounted.document, "B1 大宮の提案を作成"));
    await waitFor(
      () =>
        Boolean(mounted?.document.querySelector('[role="alert"]')) ||
        Boolean(
          mounted?.document.querySelector('[aria-labelledby="proposal-title"]'),
        ),
    );
    expect(mounted.document.body.textContent).not.toContain(
      validProposal.title,
    );
  });

  it("does not verify on approval alone and does not verify after rejection", async () => {
    const approveFetcher = responseSequence([jsonResponse(completedRun)]);
    mounted = await openProposal(approveFetcher);
    await click(buttonByName(mounted.document, "提案を承認する"));
    expect(approveFetcher).toHaveBeenCalledTimes(1);
    expect(mounted.document.body.textContent).toContain(
      "完了を確認して記録する",
    );
    await cleanup();

    const rejectFetcher = responseSequence([jsonResponse(completedRun)]);
    mounted = await openProposal(rejectFetcher);
    await click(buttonByName(mounted.document, "却下（APIに送信しない）"));
    expect(rejectFetcher).toHaveBeenCalledTimes(1);
    expect(mounted.document.body.textContent).toContain("提案を却下しました");
    expect(mounted.document.body.textContent).not.toContain(
      "完了を確認して記録する",
    );
  });

  it("verifies only after explicit completion and displays the returned completion event", async () => {
    const fetcher = responseSequence([
      jsonResponse(completedRun),
      jsonResponse(validCompletionEvent),
    ]);
    mounted = await openProposal(fetcher);
    expect(mounted.document.body.textContent).toContain(
      "完了時に添えるメモ（任意）",
    );
    await click(buttonByName(mounted.document, "提案を承認する"));
    expect(fetcher).toHaveBeenCalledTimes(1);

    await click(buttonByName(mounted.document, "完了を確認して記録する"));
    await waitFor(() =>
      Boolean(
        mounted?.document.querySelector('[aria-labelledby="completion-title"]'),
      ),
    );

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `${API_BASE}/v1/actions/${encodeURIComponent(validProposal.action_id)}/verify`,
    );
    expect(requestBody(fetcher, 1)).toEqual({
      scenario_id: "b1-omiya-calculus",
      campus: "omiya",
      approved: true,
      completed: true,
      notes: "",
    });
    expect(mounted.document.body.textContent).toContain("action_completed");
    expect(mounted.document.body.textContent).toContain("b1-omiya-calculus");
    expect(mounted.document.body.textContent).toContain(
      validProposal.action_id,
    );
  });

  it("does not accept a completion event for a different action", async () => {
    const mismatchedCompletion: OrbitEvent = {
      ...validCompletionEvent,
      payload: {
        ...validCompletionEvent.payload,
        action_id: "act-other-action",
      },
    };
    const fetcher = responseSequence([
      jsonResponse(completedRun),
      jsonResponse(mismatchedCompletion),
    ]);
    mounted = await openProposal(fetcher);
    await click(buttonByName(mounted.document, "提案を承認する"));
    await click(buttonByName(mounted.document, "完了を確認して記録する"));
    await waitFor(() =>
      Boolean(mounted?.document.querySelector('[role="alert"]')),
    );

    expect(mounted.document.body.textContent).not.toContain(
      "完了を記録しました",
    );
    expect(
      mounted.document.querySelector('[aria-labelledby="completion-title"]'),
    ).toBeNull();
  });

  it.each([
    [
      "network failure",
      [new Error("connection refused"), jsonResponse(completedRun)] as Array<
        Response | Error
      >,
    ],
    [
      "HTTP failure with string detail",
      [
        jsonResponse({ detail: "validation failed" }, 422),
        jsonResponse(completedRun),
      ] as Array<Response | Error>,
    ],
    [
      "HTTP failure with object detail",
      [
        jsonResponse({ detail: [{ loc: ["body"], msg: "invalid" }] }, 422),
        jsonResponse(completedRun),
      ] as Array<Response | Error>,
    ],
    [
      "non-JSON failure",
      [nonJsonResponse(502), jsonResponse(completedRun)] as Array<
        Response | Error
      >,
    ],
    [
      "empty JSON failure",
      [jsonResponse(undefined), jsonResponse(completedRun)] as Array<
        Response | Error
      >,
    ],
  ])(
    "does not fake success for %s and leaves proposal request retryable",
    async (_name, responses) => {
      const fetcher = responseSequence(responses);
      vi.stubGlobal("fetch", fetcher);
      mounted = await mountSidePanel(() => <App />);
      await click(buttonByName(mounted.document, "B1 大宮の提案を作成"));
      await waitFor(() =>
        Boolean(mounted?.document.querySelector('[role="alert"]')),
      );

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(mounted.document.body.textContent).not.toContain(
        validProposal.title,
      );
      expect(
        buttonByName(mounted.document, "B1 大宮の提案を作成").disabled,
      ).toBe(false);

      await click(buttonByName(mounted.document, "B1 大宮の提案を作成"));
      await waitFor(
        () =>
          mounted?.document.body.textContent?.includes(validProposal.title) ??
          false,
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["empty action_id", { action_id: "" }],
    ["empty evidence", { evidence: [] }],
    ["zero duration", { duration_minutes: 0 }],
    ["non-integer duration", { duration_minutes: "12" }],
  ])(
    "does not adopt malformed successful proposal: %s",
    async (_name, patch) => {
      const fetcher = responseSequence([
        jsonResponse({ ...validProposal, ...patch }),
      ]);
      vi.stubGlobal("fetch", fetcher);
      mounted = await mountSidePanel(() => <App />);
      await click(buttonByName(mounted.document, "B1 大宮の提案を作成"));
      await waitFor(
        () =>
          Boolean(mounted?.document.querySelector('[role="alert"]')) ||
          Boolean(
            mounted?.document.querySelector(
              '[aria-labelledby="proposal-title"]',
            ),
          ),
      );

      expect(mounted.document.body.textContent).not.toContain(
        validProposal.title,
      );
      expect(mounted.document.body.textContent).not.toContain(
        "完了を確認して記録する",
      );
    },
  );

  it("[UI-001] does not call Google or Agent API on mount", async () => {
    const token = "calendar-mount-secret";
    const apiFetcher = vi.fn(async () => {
      throw new Error("Agent API must not run on mount");
    });
    vi.stubGlobal("fetch", apiFetcher);

    mounted = await mountSidePanel(() => <App />);

    const calendarMessages = mounted.chromeRuntime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(isCalendarCommandMessage);
    expect(calendarMessages).toEqual([]);
    expect(apiFetcher).not.toHaveBeenCalled();
    expect(
      mounted.document
        .querySelector(".settings-backdrop")
        ?.hasAttribute("hidden"),
    ).toBe(true);
    expect(mounted.document.querySelector(".context-card")).toBeNull();
    expect(mounted.document.querySelector(".fixture-card")).toBeNull();
    expect(mounted.document.body.textContent).not.toContain(
      "予定名などを除いた空き時間もAPI経由で選択中のモデルへ送ります。",
    );
    expect(mounted.document.body.textContent).not.toContain(token);
  });

  it("[UI-DRIVE-001] requests one Drive session refresh on mount and keeps unavailable select disabled", async () => {
    const token = "drive-mount-secret";
    const apiFetcher = vi.fn(async () => {
      throw new Error("Agent API must not run on Drive mount");
    });
    vi.stubGlobal("fetch", apiFetcher);
    const driveRequest = vi.fn(async (command: string) => {
      if (command !== "refresh") {
        throw new Error(`Unexpected Drive command: ${command}`);
      }
      return {
        status: "unavailable" as const,
        selections: [],
        message:
          "Google Driveのファイル選択はまだ利用できません。ライブProviderは未設定です。",
        retryable: false,
      };
    });

    mounted = await mountSidePanel(() => <App driveRequest={driveRequest} />);
    await waitFor(
      () =>
        driveRequest.mock.calls.length === 1 &&
        mounted?.document.querySelector('[data-drive-status="unavailable"]') !==
          null,
    );

    const driveMessages = mounted.chromeRuntime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(isDriveCommandMessage);
    expect(driveMessages).toEqual([]);
    expect(driveRequest).toHaveBeenCalledTimes(1);
    expect(driveRequest).toHaveBeenCalledWith("refresh");
    expect(
      mounted.document.querySelector('[data-drive-status="unavailable"]'),
    ).not.toBeNull();
    const selectButton = mounted.document.querySelector(
      '[data-testid="drive-select"]',
    );
    expect(selectButton).not.toBeNull();
    expect((selectButton as HTMLButtonElement).disabled).toBe(true);
    expect(mounted.document.body.textContent).toContain(
      "Google Driveのファイル選択はまだ利用できません。ライブProviderは未設定です。",
    );
    expect(mounted.document.body.textContent).not.toContain(token);
    expect(apiFetcher).not.toHaveBeenCalled();
  });

  it("[UI-DRIVE-002] completes the synthetic Drive fixture flow through EvidenceLink and deselection", async () => {
    const apiFetcher = vi.fn(async () => {
      throw new Error("Agent API must not run for the local Drive fixture");
    });
    vi.stubGlobal("fetch", apiFetcher);
    const driveRequest = vi.fn(async (command: string) => {
      if (command !== "refresh") {
        throw new Error(`Unexpected live Drive command: ${command}`);
      }
      return {
        status: "unavailable" as const,
        selections: [],
        message:
          "Google Driveのファイル選択はまだ利用できません。ライブProviderは未設定です。",
        retryable: false,
      };
    });

    mounted = await mountSidePanel(() => <App driveRequest={driveRequest} />);
    await waitFor(() => driveRequest.mock.calls.length === 1);

    const fixtureSelect = mounted.document.querySelector(
      '[data-testid="drive-fixture-select"]',
    );
    expect(fixtureSelect).not.toBeNull();
    await click(fixtureSelect as Element);
    await waitFor(
      () =>
        mounted?.document.querySelector(
          '[data-testid="drive-fixture-read"]',
        ) !== null,
    );
    expect(mounted.document.body.textContent).toContain("合成ノート.md");
    expect(
      mounted.document.querySelector('[data-drive-fixture-status="connected"]'),
    ).not.toBeNull();
    expect(mounted.document.body.textContent).toContain("未読み取り");

    const fixtureRead = mounted.document.querySelector(
      '[data-testid="drive-fixture-read"]',
    );
    expect(fixtureRead).not.toBeNull();
    await click(fixtureRead as Element);
    await waitFor(
      () =>
        mounted?.document.body.textContent?.includes(
          "orbit-drive://sel_fixture_drive_1",
        ) ?? false,
    );
    expect(mounted.document.body.textContent).toContain("EvidenceLink");
    expect(mounted.document.body.textContent).toContain("読み取り済み");
    expect(mounted.document.body.textContent).not.toContain(
      "fixture-drive-note",
    );

    const fixtureDeselect = mounted.document.querySelector(
      '[data-testid="drive-fixture-deselect"]',
    );
    expect(fixtureDeselect).not.toBeNull();
    await click(fixtureDeselect as Element);
    await waitFor(
      () =>
        mounted?.document.querySelector(
          '[data-drive-fixture-status="not_connected"]',
        ) !== null,
    );
    expect(mounted.document.body.textContent).toContain(
      "合成ファイルはまだ選択されていません。",
    );
    expect(mounted.document.body.textContent).not.toContain("合成ノート.md");
    expect(driveRequest).toHaveBeenCalledTimes(1);
    expect(apiFetcher).not.toHaveBeenCalled();

    const reselectButton = mounted.document.querySelector(
      '[data-testid="drive-fixture-select"]',
    );
    expect(reselectButton).not.toBeNull();
    expect((reselectButton as HTMLButtonElement).disabled).toBe(false);
    await click(reselectButton as Element);
    await waitFor(
      () =>
        mounted?.document.querySelector(
          '[data-drive-fixture-status="connected"]',
        ) !== null &&
        mounted?.document.body.textContent?.includes("合成ノート.md") === true,
    );
    expect(mounted.document.body.textContent).toContain("合成ノート.md");
    expect(
      mounted.document.querySelector('[data-testid="drive-fixture-read"]'),
    ).not.toBeNull();
    expect(mounted.document.body.textContent).toContain("未読み取り");
    expect(apiFetcher).not.toHaveBeenCalled();
  });

  it("[UI-DRIVE-003] includes the read synthetic Drive EvidenceLink in the B1 proposal context", async () => {
    const apiFetcher = responseSequence([jsonResponse(completedRun)]);
    vi.stubGlobal("fetch", apiFetcher);
    const driveRequest = vi.fn(async (command: string) => {
      if (command !== "refresh") {
        throw new Error(`Unexpected live Drive command: ${command}`);
      }
      return {
        status: "unavailable" as const,
        selections: [],
        message:
          "Google Driveのファイル選択はまだ利用できません。ライブProviderは未設定です。",
        retryable: false,
      };
    });

    mounted = await mountSidePanel(() => <App driveRequest={driveRequest} />);
    await waitFor(() => driveRequest.mock.calls.length === 1);
    await click(
      mounted.document.querySelector(
        '[data-testid="drive-fixture-select"]',
      ) as Element,
    );
    await waitFor(
      () =>
        mounted?.document.querySelector(
          '[data-testid="drive-fixture-read"]',
        ) !== null,
    );
    await click(
      mounted.document.querySelector(
        '[data-testid="drive-fixture-read"]',
      ) as Element,
    );
    await waitFor(
      () =>
        mounted?.document.body.textContent?.includes(
          "orbit-drive://sel_fixture_drive_1",
        ) ?? false,
    );

    await click(buttonByName(mounted.document, "B1 大宮の提案を作成"));
    await waitFor(() => apiFetcher.mock.calls.length === 1);

    const body = requestBody(apiFetcher, 0);
    const context = body.context as Array<Record<string, unknown>>;
    expect(context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_type: "google_drive",
          evidence_id: "ev-sel_fixture_drive_1",
          title: "合成ノート.md",
          locator: "orbit-drive://sel_fixture_drive_1",
          data_classification: "synthetic",
        }),
      ]),
    );
    expect(context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source_type: "assignment" }),
      ]),
    );
    expect(JSON.stringify(body)).not.toContain("fixture-drive-note");
  });

  it("[UI-002] sends typed connect/disconnect commands and keeps token/API boundaries clean", async () => {
    const token = "calendar-runtime-secret";
    const apiFetcher = vi.fn(async () => {
      throw new Error("Agent API must not run for calendar controls");
    });
    vi.stubGlobal("fetch", apiFetcher);
    const connectedResult = {
      status: "connected" as const,
      snapshot: {
        timeZone: "Asia/Tokyo",
        timeMin: "2026-08-15T00:00:00+09:00",
        timeMax: "2026-08-22T00:00:00+09:00",
        events: [],
        availability: {
          status: "known" as const,
          availableMinutes: 10080,
          busyMinutes: 0,
          intervals: [],
        },
        truncated: false,
        fetchedAt: "2026-08-15T03:00:00.000Z",
      },
    };

    mounted = await mountSidePanel(() => <App />);
    mounted.chromeRuntime.sendMessage.mockImplementation(
      (message: unknown, callback?: (response: unknown) => void): void => {
        if (isCalendarCommandMessage(message)) {
          callback?.(
            message.type === MESSAGE_TYPES.calendarConnect
              ? connectedResult
              : { status: "not_connected" },
          );
          return;
        }
        callback?.(null);
      },
    );

    await click(buttonByName(mounted.document, "Google Calendarを接続"));
    await waitFor(
      () =>
        mounted?.document.querySelector(
          '[data-calendar-status="connected"]',
        ) !== null,
    );
    await click(buttonByName(mounted.document, "切断"));
    await waitFor(
      () =>
        mounted?.document.querySelector(
          '[data-calendar-status="not_connected"]',
        ) !== null,
    );

    const calendarMessages = mounted.chromeRuntime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(isCalendarCommandMessage);
    expect(calendarMessages).toEqual([
      { type: MESSAGE_TYPES.calendarConnect },
      { type: MESSAGE_TYPES.calendarDisconnect },
    ]);
    expect(JSON.stringify(calendarMessages)).not.toContain(token);
    expect(mounted.document.body.textContent).not.toContain(token);
    expect(apiFetcher).not.toHaveBeenCalled();
  });

  it("[UI-003] renders a generic calendar error without exposing a connector token", async () => {
    const token = "calendar-error-secret";
    const apiFetcher = vi.fn(async () => {
      throw new Error("Agent API must not run for calendar errors");
    });
    vi.stubGlobal("fetch", apiFetcher);
    const calendarRequest = vi.fn(async () => {
      throw new Error(token);
    });

    mounted = await mountSidePanel(() => (
      <App calendarRequest={calendarRequest} />
    ));
    await click(buttonByName(mounted.document, "Google Calendarを接続"));
    await waitFor(
      () => mounted?.document.querySelector('[role="alert"]') !== null,
    );

    expect(calendarRequest).toHaveBeenCalledWith("connect");
    expect(mounted.document.body.textContent).not.toContain(token);
    expect(mounted.document.body.textContent).toContain(
      "Google Calendarを利用できません。",
    );
    expect(apiFetcher).not.toHaveBeenCalled();
  });
});
