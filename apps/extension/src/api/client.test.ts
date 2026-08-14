import { describe, expect, it, vi } from "vitest";
import { B1_OMIYA_CONTEXT, B1_OMIYA_EVENT } from "../sidepanel/b1-fixture";
import { AgentApiClient, AgentApiError, type Fetcher } from "./client";

const proposal = {
  action_id: "act-b1-omiya",
  title: "合成関数の微分を2問確認する",
  reason: "明日の課題と利用可能時間に合うためです。",
  duration_minutes: 12,
  evidence: B1_OMIYA_CONTEXT,
  external_action: "checklist_update" as const,
  requires_confirmation: true,
  prompt_version: "fixture-b1-omiya-v1",
};

const completionEvent = {
  event_id: "evt-b1-omiya-completed",
  event_type: "action_completed" as const,
  scenario_id: B1_OMIYA_EVENT.scenario_id,
  occurred_at: "2026-08-12T14:40:00+09:00",
  campus: "omiya" as const,
  data_classification: "synthetic" as const,
  payload: {
    action_id: proposal.action_id,
    approved: true,
    completed: true,
    notes: "例題を2問確認",
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function createFetcher(response: Response): Fetcher & ReturnType<typeof vi.fn> {
  return vi.fn(async () => response) as unknown as Fetcher &
    ReturnType<typeof vi.fn>;
}

describe("AgentApiClient", () => {
  it("posts the generated proposal request to the explicit API base", async () => {
    const fetcher = createFetcher(jsonResponse(proposal));
    const client = new AgentApiClient({
      baseUrl: "http://localhost:8123/",
      fetcher,
    });

    await expect(
      client.propose({ event: B1_OMIYA_EVENT, context: B1_OMIYA_CONTEXT }),
    ).resolves.toEqual(proposal);

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:8123/v1/actions/propose",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: B1_OMIYA_EVENT,
          context: B1_OMIYA_CONTEXT,
        }),
      },
    );
  });

  it("encodes the action ID and posts completion verification", async () => {
    const fetcher = createFetcher(jsonResponse(completionEvent));
    const client = new AgentApiClient({
      baseUrl: "http://localhost:8123",
      fetcher,
    });
    const request = {
      scenario_id: B1_OMIYA_EVENT.scenario_id,
      campus: "omiya" as const,
      approved: true,
      completed: true,
      notes: "例題を2問確認",
    };

    await expect(client.verify("act/b1-omiya", request)).resolves.toEqual(
      completionEvent,
    );
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:8123/v1/actions/act%2Fb1-omiya/verify",
      expect.objectContaining({ body: JSON.stringify(request) }),
    );
  });

  it("surfaces HTTP errors without retrying or falling back", async () => {
    const fetcher = createFetcher(
      jsonResponse({ detail: "invalid synthetic fixture" }, 422),
    );
    const client = new AgentApiClient({ fetcher });

    await expect(
      client.propose({ event: B1_OMIYA_EVENT, context: B1_OMIYA_CONTEXT }),
    ).rejects.toMatchObject({
      name: "AgentApiError",
      status: 422,
      body: { detail: "invalid synthetic fixture" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("wraps network errors and rejects empty responses", async () => {
    const failingFetcher = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as Fetcher;
    const client = new AgentApiClient({ fetcher: failingFetcher });

    await expect(
      client.propose({ event: B1_OMIYA_EVENT, context: B1_OMIYA_CONTEXT }),
    ).rejects.toMatchObject({
      name: "AgentApiError",
      status: 0,
      message: "Agent API request failed: connection refused",
    });

    const emptyResponseClient = new AgentApiClient({
      fetcher: createFetcher(jsonResponse(undefined)),
    });
    await expect(
      emptyResponseClient.propose({
        event: B1_OMIYA_EVENT,
        context: B1_OMIYA_CONTEXT,
      }),
    ).rejects.toBeInstanceOf(AgentApiError);
  });

  it("rejects an empty action ID before making a request", async () => {
    const fetcher = createFetcher(jsonResponse(completionEvent));
    const client = new AgentApiClient({ fetcher });

    await expect(
      client.verify("  ", {
        scenario_id: B1_OMIYA_EVENT.scenario_id,
        campus: "omiya",
        approved: true,
        completed: true,
        notes: "",
      }),
    ).rejects.toThrow("Action ID must not be empty.");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
