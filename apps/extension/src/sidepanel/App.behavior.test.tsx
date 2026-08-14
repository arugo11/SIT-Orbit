import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionProposal, OrbitEvent } from "../api/client";
import { App } from "./App";
import {
  buttonByName,
  click,
  type MountedSidePanel,
  mountSidePanel,
  unmountSidePanel,
  waitFor,
} from "./ui-test-helpers";

const API_BASE = "http://localhost:8000";

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

  it("requests the synthetic campus_entered proposal once, only after an explicit click", async () => {
    const fetcher = responseSequence([jsonResponse(validProposal)]);
    mounted = await openProposal(fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${API_BASE}/v1/actions/propose`);
    expect(requestBody(fetcher, 0)).toMatchObject({
      event: {
        event_type: "campus_entered",
        campus: "omiya",
        data_classification: "synthetic",
      },
    });
    expect(
      (requestBody(fetcher, 0).context as Array<Record<string, unknown>>).every(
        (evidence) =>
          evidence.data_classification === "synthetic" ||
          evidence.data_classification === "public",
      ),
    ).toBe(true);
  });

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
    const fetcher = responseSequence([jsonResponse(publicProposal)]);
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
      const unsafeFetcher = responseSequence([jsonResponse(unsafeProposal)]);
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
      jsonResponse({ ...validProposal, evidence: [] }),
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
    const approveFetcher = responseSequence([jsonResponse(validProposal)]);
    mounted = await openProposal(approveFetcher);
    await click(buttonByName(mounted.document, "提案を承認する"));
    expect(approveFetcher).toHaveBeenCalledTimes(1);
    expect(mounted.document.body.textContent).toContain(
      "完了を確認して記録する",
    );
    await cleanup();

    const rejectFetcher = responseSequence([jsonResponse(validProposal)]);
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
      jsonResponse(validProposal),
      jsonResponse(validCompletionEvent),
    ]);
    mounted = await openProposal(fetcher);
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
      jsonResponse(validProposal),
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
      [new Error("connection refused"), jsonResponse(validProposal)] as Array<
        Response | Error
      >,
    ],
    [
      "HTTP failure with string detail",
      [
        jsonResponse({ detail: "validation failed" }, 422),
        jsonResponse(validProposal),
      ] as Array<Response | Error>,
    ],
    [
      "HTTP failure with object detail",
      [
        jsonResponse({ detail: [{ loc: ["body"], msg: "invalid" }] }, 422),
        jsonResponse(validProposal),
      ] as Array<Response | Error>,
    ],
    [
      "non-JSON failure",
      [nonJsonResponse(502), jsonResponse(validProposal)] as Array<
        Response | Error
      >,
    ],
    [
      "empty JSON failure",
      [jsonResponse(undefined), jsonResponse(validProposal)] as Array<
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
});
