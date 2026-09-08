import { describe, expect, it, vi } from "vitest";

import {
  B1_OMIYA_CONTEXT,
  B1_OMIYA_EVENT,
  createFoundationClient,
  FoundationApiError,
  isActionProposal,
} from "./foundation";

function jsonResponse(value: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  } as Response;
}

const proposal = {
  action_id: "act-foundation-test",
  title: "次の授業までに合成関数の微分を2問確認する",
  reason: "明日の課題と直近の誤答を確認できるためです。",
  duration_minutes: 12,
  evidence: B1_OMIYA_CONTEXT,
  external_action: "checklist_update",
  requires_confirmation: true,
  prompt_version: "fixture-b1-omiya-v1",
  operation: null,
} as const;

const completion = {
  event_id: "evt-completed-foundation-test",
  event_type: "action_completed",
  scenario_id: B1_OMIYA_EVENT.scenario_id,
  occurred_at: "2026-09-08T01:00:00Z",
  campus: "omiya",
  data_classification: "synthetic",
  payload: {
    action_id: proposal.action_id,
    approved: true,
    completed: true,
    notes: "合成fixtureを完了",
  },
} as const;

function fetcherFor(...responses: Response[]) {
  let index = 0;
  return vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>(
    async (..._args) => responses[index++] ?? jsonResponse({}, 500),
  );
}

describe("createFoundationClient", () => {
  it("uses the fixture capability before proposing the B1 event", async () => {
    const fetcher = fetcherFor(
      jsonResponse({
        agent_backend: "fixture",
        my_library_personal_context: false,
      }),
      jsonResponse(proposal),
    );
    const client = createFoundationClient("http://localhost:8000/", fetcher);

    await expect(client.propose()).resolves.toEqual(proposal);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "http://localhost:8000/v1/capabilities",
    );
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "http://localhost:8000/v1/actions/propose",
    );
    const init = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      event: B1_OMIYA_EVENT,
      context: B1_OMIYA_CONTEXT,
    });
  });

  it("stops before proposal when the deployed backend is not fixture", async () => {
    const fetcher = fetcherFor(
      jsonResponse({
        agent_backend: "azure_openai",
        my_library_personal_context: true,
      }),
    );
    const client = createFoundationClient("http://localhost:8000", fetcher);

    await expect(client.propose()).rejects.toMatchObject({
      kind: "backend",
      message: "fixtureバックエンドではないため、合成デモを開始できません。",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("verifies a proposal using an encoded action ID and returns a bounded event", async () => {
    const fetcher = fetcherFor(jsonResponse(completion));
    const client = createFoundationClient("http://localhost:8000", fetcher);
    const request = {
      scenario_id: B1_OMIYA_EVENT.scenario_id,
      campus: "omiya",
      approved: true,
      completed: true,
      notes: "合成fixtureを完了",
    } as const;

    await expect(
      client.verify("act/foundation test", request),
    ).resolves.toEqual(completion);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "http://localhost:8000/v1/actions/act%2Ffoundation%20test/verify",
    );
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual(request);
  });

  it("does not expose HTTP response bodies or network errors", async () => {
    const httpFetcher = fetcherFor(
      jsonResponse({ secret: "student-data", detail: "provider failure" }, 503),
    );
    const httpClient = createFoundationClient(
      "http://localhost:8000",
      httpFetcher,
    );
    const httpError = await httpClient
      .capabilities()
      .catch((error: unknown) => error);
    expect(httpError).toBeInstanceOf(FoundationApiError);
    expect((httpError as Error).message).toBe(
      "Agent APIが利用できません（HTTP 503）。",
    );
    expect((httpError as Error).message).not.toContain("student-data");

    const networkFetcher = vi.fn(async () => {
      throw new Error("student-data in transport error");
    });
    const networkClient = createFoundationClient(
      "http://localhost:8000",
      networkFetcher,
    );
    await expect(networkClient.capabilities()).rejects.toMatchObject({
      kind: "network",
      message: "Agent APIに接続できませんでした。",
    });
  });

  it("rejects malformed proposal payloads before returning them", async () => {
    const malformed = { ...proposal, evidence: [] };
    expect(isActionProposal(malformed)).toBe(false);
    expect(
      isActionProposal({
        ...proposal,
        external_action: "library_write",
        operation: null,
      }),
    ).toBe(false);
    expect(
      isActionProposal({ ...proposal, requires_confirmation: false }),
    ).toBe(false);
    const fetcher = fetcherFor(
      jsonResponse({ agent_backend: "fixture" }),
      jsonResponse(malformed),
    );
    const client = createFoundationClient("http://localhost:8000", fetcher);

    await expect(client.propose()).rejects.toMatchObject({
      kind: "response",
      message: "Agent APIの提案応答が不正です。",
    });
  });

  it("rejects unsafe API base URLs before creating a client", () => {
    for (const baseUrl of [
      "ftp://localhost:8000",
      "https://user:password@example.test",
      "http://localhost:8000/?token=secret",
      "http://localhost:8000/#student",
    ]) {
      expect(() => createFoundationClient(baseUrl)).toThrow(
        "Agent APIの接続先が不正です。",
      );
    }
  });

  it("rejects a completion response without a real RFC3339 timestamp", async () => {
    const fetcher = fetcherFor(
      jsonResponse({ ...completion, occurred_at: "2026-09-08" }),
    );
    const client = createFoundationClient("http://localhost:8000", fetcher);

    await expect(
      client.verify("act-foundation-test", {
        scenario_id: B1_OMIYA_EVENT.scenario_id,
        campus: "omiya",
        approved: true,
        completed: true,
        notes: "合成fixtureを完了",
      }),
    ).rejects.toMatchObject({
      kind: "response",
      message: "Agent APIの完了イベント応答が不正です。",
    });
  });
});
