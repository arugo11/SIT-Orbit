import { afterEach, describe, expect, it, vi } from "vitest";
import { type ActionProposal, AZURE_DEMO_AGENT_API_BASE } from "../api/client";
import type {
  CalendarConnector,
  CalendarConnectorResult,
} from "../connectors/google-calendar";
import type { PageContext } from "../content/page-context";
import { MESSAGE_TYPES } from "../shared/messages";
import { App } from "./App";
import { B1_OMIYA_CONTEXT } from "./b1-fixture";
import {
  buttonByName,
  click,
  type MountedSidePanel,
  mountSidePanel,
  unmountSidePanel,
  waitFor,
} from "./ui-test-helpers";

const API_BASE = AZURE_DEMO_AGENT_API_BASE;
const PRIVATE_TITLE = "私的なScombZ課題タイトル";
const PRIVATE_URL = "https://scombz.shibaura-it.ac.jp/lms/task/private-1";

const parsedScombzContext: PageContext = {
  title: "私的なScombZページのタイトル",
  url: PRIVATE_URL,
  kind: "scombz",
  scombz: {
    route: "tasks",
    tasks: [
      {
        course: "私的な授業名",
        title: PRIVATE_TITLE,
        deadline: "2026-08-20",
        url: "https://scombz.shibaura-it.ac.jp/task/private-1",
      },
    ],
    announcements: [],
    calendar: {
      googleCalendarUrl: null,
      icsUrl: null,
    },
    currentCourse: {
      name: "私的な授業名",
      url: "https://scombz.shibaura-it.ac.jp/course/private-1",
    },
    relatedLinks: [],
  },
};

const [b1Evidence] = B1_OMIYA_CONTEXT;
if (!b1Evidence) {
  throw new Error("B1 fixture evidence is missing.");
}

const connectedCalendar: CalendarConnectorResult = {
  status: "connected",
  snapshot: {
    timeZone: "Asia/Tokyo",
    timeMin: "2026-08-15T00:00:00+09:00",
    timeMax: "2026-08-22T00:00:00+09:00",
    events: [
      {
        id: "private-event-id",
        status: "confirmed",
        summary: "private event title",
        start: "2026-08-15T09:00:00+09:00",
        end: "2026-08-15T10:00:00+09:00",
        allDay: false,
        endTimeUnspecified: false,
        transparency: "opaque",
        eventType: "default",
      },
    ],
    availability: {
      status: "known",
      availableMinutes: 10020,
      busyMinutes: 60,
      intervals: [
        {
          start: "2026-08-15T00:00:00+09:00",
          end: "2026-08-15T09:00:00+09:00",
        },
      ],
    },
    truncated: false,
    fetchedAt: "2026-08-15T03:00:00.000Z",
  },
};

const finalProposal: ActionProposal = {
  action_id: "act-multistep",
  title: "合成関数の微分を確認する",
  reason: "ScombZの課題と空き時間に収まるためです。",
  duration_minutes: 12,
  evidence: [
    b1Evidence,
    {
      evidence_id: "scombz-page-summary-v1-run-multi",
      title: "ScombZページから導出したページ概要",
      source_type: "scombz",
      locator: "orbit-scombz://page-summary/opaque-summary-1",
      data_classification: "personal",
    },
    {
      evidence_id: "calendar-availability-v1-run-multi",
      title: "Google Calendarから導出した空き時間",
      source_type: "calendar",
      locator: "orbit-calendar://availability/opaque-calendar-1",
      data_classification: "personal",
    },
  ],
  external_action: "checklist_update",
  requires_confirmation: true,
  prompt_version: "pydantic-ai-next-action-v1",
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function responseSequence(responses: Response[]): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error("Unexpected extra request in test.");
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

function makeCalendarConnector(): CalendarConnector {
  return {
    connect: vi.fn(async () => connectedCalendar),
    refresh: vi.fn(async () => connectedCalendar),
    reauthenticate: vi.fn(async () => connectedCalendar),
    disconnect: vi.fn(async () => ({ status: "not_connected" as const })),
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

async function mountWithScombzContext(
  fetcher: ReturnType<typeof vi.fn>,
): Promise<MountedSidePanel> {
  vi.stubGlobal("fetch", fetcher);
  const calendarConnector = makeCalendarConnector();
  const mounted = await mountSidePanel(
    () => (
      <App
        calendarConnector={calendarConnector}
        driveRequest={unavailableDriveRequest()}
      />
    ),
    (runtime) => {
      runtime.sendMessage.mockImplementation(
        (message: unknown, callback?: (response: unknown) => void) => {
          if (
            typeof message === "object" &&
            message !== null &&
            (message as { type?: unknown }).type ===
              MESSAGE_TYPES.getPageContext
          ) {
            callback?.(parsedScombzContext);
            return;
          }
          callback?.(null);
        },
      );
    },
  );
  await waitFor(
    () =>
      mounted.document.body.textContent?.includes(parsedScombzContext.title) ??
      false,
  );
  await click(buttonByName(mounted.document, "Google Calendarを接続"));
  await waitFor(
    () =>
      mounted.document.querySelector('[data-calendar-status="connected"]') !==
      null,
  );
  await click(buttonByName(mounted.document, "B1 大宮の提案を作成"));
  return mounted;
}

describe("Side Panel two-stage client-tool loop", () => {
  let mounted: MountedSidePanel | undefined;

  afterEach(async () => {
    if (mounted) {
      await unmountSidePanel(mounted.root);
      mounted = undefined;
    }
  });

  it("runs ScombZ then Calendar under one run and posts only minimized results", async () => {
    const fetcher = responseSequence([
      jsonResponse({
        status: "tool_required",
        run_id: "run-multi",
        calls: [
          {
            tool_call_id: "scombz-call-1",
            name: "scombz_page_summary",
            version: 1,
          },
        ],
      }),
      jsonResponse({
        status: "tool_required",
        run_id: "run-multi",
        calls: [
          {
            tool_call_id: "calendar-call-1",
            name: "google_calendar_availability",
            version: 1,
          },
        ],
      }),
      jsonResponse({ status: "completed", proposal: finalProposal }),
    ]);

    mounted = await mountWithScombzContext(fetcher);
    await waitFor(
      () =>
        mounted?.document.querySelector(
          '[aria-labelledby="proposal-title"]',
        ) !== null,
    );

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${API_BASE}/v1/agent/runs`);
    expect(requestBody(fetcher, 0).client_tools).toEqual([
      { name: "scombz_page_summary", version: 1 },
      { name: "google_calendar_availability", version: 1 },
    ]);
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `${API_BASE}/v1/agent/runs/run-multi/tool-results`,
    );
    expect(fetcher.mock.calls[2]?.[0]).toBe(
      `${API_BASE}/v1/agent/runs/run-multi/tool-results`,
    );

    const scombzBody = requestBody(fetcher, 1);
    expect(scombzBody.result).toEqual({
      route: "tasks",
      task_count: 1,
      announcement_count: 0,
      related_link_count: 0,
      has_current_course: true,
    });
    expect(Object.keys(scombzBody.result as object)).toEqual([
      "route",
      "task_count",
      "announcement_count",
      "related_link_count",
      "has_current_course",
    ]);

    const calendarBody = requestBody(fetcher, 2);
    expect(calendarBody.result).toEqual({
      schema_version: "v1",
      status: "known",
      time_zone: "Asia/Tokyo",
      window_start: "2026-08-15T00:00:00+09:00",
      window_end: "2026-08-22T00:00:00+09:00",
      available_minutes: 10020,
      busy_minutes: 60,
      free_intervals: [
        {
          start: "2026-08-15T00:00:00+09:00",
          end: "2026-08-15T09:00:00+09:00",
        },
      ],
      reason_code: null,
    });
    const serializedRequests = JSON.stringify([
      requestBody(fetcher, 0),
      scombzBody,
      calendarBody,
    ]);
    for (const rawValue of [
      "私的なScombZページのタイトル",
      PRIVATE_URL,
      PRIVATE_TITLE,
      "私的な授業名",
      "private-event-id",
      "private event title",
      "oauth-secret",
    ]) {
      expect(serializedRequests).not.toContain(rawValue);
    }
  });

  it.each([
    {
      label: "changed run ID",
      response: {
        status: "tool_required",
        run_id: "run-other",
        calls: [
          {
            tool_call_id: "calendar-call-1",
            name: "google_calendar_availability",
            version: 1,
          },
        ],
      },
    },
    {
      label: "duplicate tool call ID",
      response: {
        status: "tool_required",
        run_id: "run-multi",
        calls: [
          {
            tool_call_id: "scombz-call-1",
            name: "scombz_page_summary",
            version: 1,
          },
        ],
      },
    },
  ])(
    "fails closed for $label during the bounded loop",
    async ({ response }) => {
      const fetcher = responseSequence([
        jsonResponse({
          status: "tool_required",
          run_id: "run-multi",
          calls: [
            {
              tool_call_id: "scombz-call-1",
              name: "scombz_page_summary",
              version: 1,
            },
          ],
        }),
        jsonResponse(response),
      ]);

      mounted = await mountWithScombzContext(fetcher);
      await waitFor(
        () => mounted?.document.querySelector('[role="alert"]') !== null,
      );

      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[0]?.[0]).toBe(`${API_BASE}/v1/agent/runs`);
      expect(fetcher.mock.calls[1]?.[0]).toBe(
        `${API_BASE}/v1/agent/runs/run-multi/tool-results`,
      );
      expect(
        mounted.document.querySelector('[aria-labelledby="proposal-title"]'),
      ).toBeNull();
    },
  );
});
