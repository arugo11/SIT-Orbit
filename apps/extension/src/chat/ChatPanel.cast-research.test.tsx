import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentApiClient, ChatRunResponse } from "../api/client";
import {
  buttonByName,
  type MountedSidePanel,
  mountSidePanel,
  unmountSidePanel,
  waitFor,
} from "../sidepanel/ui-test-helpers";
import { ChatPanel } from "./ChatPanel";
import { deleteAllConversations, listConversations } from "./chat-history";

const careerArguments = {
  query: "MLエンジニアとしての芝浦の進路",
  surfaces: ["company", "hiring_record", "selection_report"],
  filters: {
    technical_domains: ["機械学習"],
    academic_programs: ["情報"],
    graduation_years: [2022, 2023, 2024, 2025, 2026],
  },
  limit: 10,
  exhaustive: false,
};

function toolRequired(): ChatRunResponse {
  return {
    status: "tool_required",
    run_id: "cast-research-ui-run",
    calls: [
      {
        tool_call_id: "cast-research-ui-call",
        name: "cast_career_search",
        version: 1,
        arguments: careerArguments,
      },
    ],
  } as ChatRunResponse;
}

function createApiClient(): AgentApiClient & {
  startChat: ReturnType<typeof vi.fn>;
  submitChatToolResult: ReturnType<typeof vi.fn>;
} {
  return {
    startChat: vi.fn(async () => toolRequired()),
    submitChatToolResult: vi.fn(async () => ({
      status: "completed",
      message: {
        message_id: "cast-research-ui-completed",
        content_markdown: "CASTと公開情報を確認しました。",
        evidence: [],
      },
      proposal: null,
    })),
  } as unknown as AgentApiClient & {
    startChat: ReturnType<typeof vi.fn>;
    submitChatToolResult: ReturnType<typeof vi.fn>;
  };
}

async function sendMessage(
  mounted: MountedSidePanel,
  message: string,
): Promise<void> {
  const textarea = mounted.document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Chatメッセージ"]',
  );
  if (!textarea) throw new Error("Chat textarea is missing.");
  const valueSetter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(textarea),
    "value",
  )?.set;
  await act(async () => {
    if (valueSetter) valueSetter.call(textarea, message);
    else textarea.value = message;
    const propsKey = Object.keys(textarea).find((key) =>
      key.startsWith("__reactProps$"),
    );
    const props = propsKey
      ? (textarea as unknown as Record<string, unknown>)[propsKey]
      : null;
    const onChange =
      props && typeof props === "object"
        ? (props as { onChange?: unknown }).onChange
        : undefined;
    if (typeof onChange !== "function") {
      throw new Error("React textarea onChange handler is missing.");
    }
    onChange({ target: { value: message } });
  });
  await waitFor(() => !buttonByName(mounted.document, "送信").disabled);
  const form = mounted.document.querySelector("form.chat-composer");
  if (!form) throw new Error("Chat composer form is missing.");
  await act(async () => {
    form.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

function installCastRuntime(
  mounted: MountedSidePanel,
  response: unknown,
): void {
  mounted.chromeRuntime.sendMessage.mockImplementation(
    (request: unknown, callback?: (value: unknown) => void) => {
      if (
        typeof request === "object" &&
        request !== null &&
        (request as { type?: string }).type === "cast-career-search"
      ) {
        callback?.(response);
        return;
      }
      callback?.({ ok: true });
    },
  );
}

const localResult = {
  schema_version: "v1",
  status: "known",
  query: careerArguments.query,
  surfaces: careerArguments.surfaces,
  surface_results: careerArguments.surfaces.map((surface) => ({
    surface,
    status: "known",
    total_count: 1,
    returned_count: 1,
    coverage: { mode: "page", fetched_pages: 1, page_size: 10 },
    items: [
      {
        result_ref: `opaque-${surface}`,
        surface,
        title: "機械学習関連の進路",
        company_name: "公開企業A",
        dates: [],
        deadline: null,
        locations: ["東京"],
        industries: ["情報通信"],
        occupations: ["MLエンジニア"],
        employment_types: ["正社員"],
        academic_programs: ["情報"],
        target_grades: [],
        graduation_years: [2024],
        relation_flags: ["OB・OGあり"],
        local_summary: null,
        source_url: "https://shibaura.pita.services/career/top/student",
      },
    ],
    reason_code: null,
    evidence_ids: [],
  })),
  items: [],
  local_evidence: [],
  discovered_support_links: [],
  reason_codes: [],
};

const projection = {
  schema_version: "v1",
  status: "known",
  searched_surfaces: careerArguments.surfaces,
  surface_coverage: careerArguments.surfaces.map((surface) => ({
    surface,
    status: "known",
    total_count: 1,
    returned_count: 1,
    fetched_pages: 1,
    page_size: 10,
    reason_code: null,
  })),
  total_count: 3,
  returned_count: 3,
  anonymous_aggregates: [],
  evidence_ids: [],
  reason_codes: [],
};

const localReasoning = {
  payload: {
    schema_version: "v2",
    destination: "local",
    records: [
      {
        surface: "hiring_record",
        title: "機械学習関連の進路",
        company_name: "公開企業A",
        person_alias: "先輩-K7F2",
        dates: [],
        deadline: null,
        locations: ["東京"],
        technical_domains: ["機械学習"],
        occupations: ["MLエンジニア"],
        employment_types: [],
        graduation_year_buckets: ["2020-2024"],
        relation_flags: ["OB・OGあり"],
        result_ref: "opaque-hiring-record",
      },
    ],
  },
  manifest: {
    schema_version: "v2",
    source: "CAST",
    destination: "local",
    record_count: 1,
    replaced_person_count: 1,
    removed_fields: ["氏名", "連絡先", "内部ID"],
    generalized_fields: ["卒業年度"],
    payload_preview: {
      schema_version: "v2",
      destination: "local",
      records: [],
    },
  },
};

describe("CAST research UI boundary", () => {
  let mounted: MountedSidePanel | undefined;

  beforeEach(async () => {
    await deleteAllConversations();
  });

  afterEach(async () => {
    if (mounted) {
      await unmountSidePanel(mounted.root);
      mounted = undefined;
    }
    await deleteAllConversations();
  });

  it("keeps CAST reasoning local while displaying source and trace", async () => {
    const apiClient = createApiClient();
    mounted = await mountSidePanel(() => (
      <ChatPanel
        apiClient={apiClient}
        pageContext={null}
        calendarState={{ status: "not_connected" }}
        calendarRequest={async () => ({ status: "not_connected" })}
      />
    ));
    installCastRuntime(mounted, {
      ...localResult,
      projection,
      reasoning_projection: localReasoning,
    });

    await sendMessage(mounted, "MLエンジニアとして芝浦の先輩を確認して");
    await waitFor(() => apiClient.submitChatToolResult.mock.calls.length === 1);

    const request = apiClient.submitChatToolResult.mock.calls[0]?.[1] as {
      result?: unknown;
    };
    expect(request.result).toEqual(projection);
    expect(JSON.stringify(request.result)).not.toContain("先輩-K7F2");
    expect(mounted.document.body.textContent).toContain("先輩-K7F2");
    expect(mounted.document.body.textContent).toContain(
      "端末内で仮名化して整理した内容",
    );
    expect(mounted.document.body.textContent).toContain("調査トレース");
    expect(mounted.document.body.textContent).toContain("CAST");

    const stored = JSON.stringify(await listConversations());
    expect(stored).not.toContain("先輩-K7F2");
    expect(stored).not.toContain("機械学習関連の進路");
  });

  it("continues the loop with a typed CAST failure instead of generic abort", async () => {
    const apiClient = createApiClient();
    mounted = await mountSidePanel(() => (
      <ChatPanel
        apiClient={apiClient}
        pageContext={null}
        calendarState={{ status: "not_connected" }}
        calendarRequest={async () => ({ status: "not_connected" })}
      />
    ));
    installCastRuntime(mounted, {
      ...localResult,
      status: "reauth_required",
      surface_results: careerArguments.surfaces.map((surface) => ({
        surface,
        status: "reauth_required",
        total_count: null,
        returned_count: 0,
        coverage: null,
        items: [],
        reason_code: "session_expired",
        evidence_ids: [],
      })),
      items: [],
      reason_codes: ["session_expired"],
      projection: {
        ...projection,
        status: "reauth_required",
        surface_coverage: careerArguments.surfaces.map((surface) => ({
          surface,
          status: "reauth_required",
          total_count: null,
          returned_count: 0,
          fetched_pages: 0,
          page_size: 0,
          reason_code: "session_expired",
        })),
        total_count: 0,
        returned_count: 0,
        reason_codes: ["session_expired"],
      },
    });

    await sendMessage(mounted, "芝浦の採用実績を確認して");
    await waitFor(() => apiClient.submitChatToolResult.mock.calls.length === 1);

    const request = apiClient.submitChatToolResult.mock.calls[0]?.[1] as {
      result?: { status?: string; reason_codes?: string[] };
    };
    expect(request.result?.status).toBe("reauth_required");
    expect(request.result?.reason_codes).toContain("session_expired");
    expect(mounted.document.body.textContent).toContain("再認証が必要");
    expect(mounted.document.body.textContent).not.toContain(
      "今は応答できませんでした。もう一度お試しください。",
    );
  });
});
