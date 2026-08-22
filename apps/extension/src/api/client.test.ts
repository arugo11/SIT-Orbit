import { describe, expect, it, vi } from "vitest";
import { B1_OMIYA_CONTEXT, B1_OMIYA_EVENT } from "../sidepanel/b1-fixture";
import {
  AgentApiClient,
  AgentApiError,
  type Fetcher,
  isActionProposal,
  isCastReadResult,
  isLibraryCatalogBrowseResult,
  isLibraryCatalogSearchResult,
  isLibraryDiscoverySearchResult,
  isLibraryItemReadResult,
  isMoodleReadResult,
  isMyLibraryReadResult,
  isSitrusGradeResult,
} from "./client";

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
  it("accepts public library records with conservative holdings", () => {
    const item = {
      resource_ref: "orbit-library://record/0123456789abcdef",
      title: "公開ロボット工学",
      authors: ["芝浦太郎"],
      subjects: ["ロボット"],
      isbn: "978-4-0000-0000-0",
      publisher: "公開出版社",
      publication_year: 2026,
      format: "book",
      campus: "omiya",
      url: "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/ABC123",
      holdings: [
        {
          campus: "unknown",
          location: null,
          call_number: null,
          status: "unknown",
          due_date: null,
          reservation_count: null,
        },
      ],
      related_records: [],
    };
    const search = {
      schema_version: "v1",
      status: "known",
      query: "ロボット",
      items: [item],
      reason_code: null,
    };
    expect(isLibraryCatalogSearchResult(search)).toBe(true);
    expect(
      isLibraryItemReadResult({
        schema_version: "v1",
        status: "known",
        resource_ref: item.resource_ref,
        item,
        reason_code: null,
      }),
    ).toBe(true);
    expect(
      isLibraryCatalogBrowseResult({
        schema_version: "v1",
        status: "known",
        kind: "new_books",
        campus: "any",
        items: [item],
        reason_code: null,
      }),
    ).toBe(true);
    expect(
      isLibraryDiscoverySearchResult({
        schema_version: "v1",
        status: "known",
        query: "ロボット",
        items: [
          {
            title: item.title,
            authors: item.authors,
            source_label: "SIT Search",
            url: item.url,
            snippet: "公開された書誌情報",
            resource_ref: item.resource_ref,
          },
        ],
        reason_code: null,
      }),
    ).toBe(true);
    expect(
      isLibraryCatalogSearchResult({
        ...search,
        items: [
          {
            ...item,
            holdings: [{ ...item.holdings[0], material_id: "secret" }],
          },
        ],
      }),
    ).toBe(false);
    expect(
      isLibraryCatalogSearchResult({
        ...search,
        status: "unavailable",
        items: [item],
      }),
    ).toBe(false);
    expect(
      isLibraryDiscoverySearchResult({
        schema_version: "v1",
        status: "known",
        query: "ロボット",
        items: [
          {
            title: "公開論文",
            authors: [],
            source_label: "SIT Search",
            url: "https://slib.shibaura-it.ac.jp/sublib/?session=secret",
            snippet: null,
            resource_ref: null,
          },
        ],
        reason_code: null,
      }),
    ).toBe(false);
  });

  it("accepts Moodle aggregates and rejects local course details", () => {
    const result = {
      schema_version: "v1",
      status: "known",
      course_count: 2,
      upcoming_item_count: 1,
      overdue_count: 0,
      earliest_due_at: "2026-08-24T06:00:00Z",
      unread_notification_count: 3,
      reason_code: null,
    };
    expect(isMoodleReadResult(result)).toBe(true);
    expect(
      isMoodleReadResult({ ...result, course_names: ["must stay local"] }),
    ).toBe(false);
    expect(isMoodleReadResult({ ...result, status: "reauth_required" })).toBe(
      false,
    );
  });

  it("accepts My Library aggregates and rejects bibliographic details", () => {
    const result = {
      schema_version: "v1",
      status: "known",
      loan_count: 2,
      reservation_count: 1,
      overdue_count: 0,
      renewable_count: 1,
      earliest_due_date: "2026-09-01",
      reason_code: null,
    };
    expect(isMyLibraryReadResult(result)).toBe(true);
    expect(
      isMyLibraryReadResult({ ...result, titles: ["must stay local"] }),
    ).toBe(false);
    expect(
      isMyLibraryReadResult({ ...result, status: "reauth_required" }),
    ).toBe(false);
    expect(
      isMyLibraryReadResult({ ...result, earliest_due_date: "2026-99-99" }),
    ).toBe(false);
    expect(
      isMyLibraryReadResult({
        ...result,
        status: "unavailable",
        loan_count: 0,
        reservation_count: 0,
        overdue_count: 0,
        renewable_count: 0,
        earliest_due_date: null,
        reason_code: "login_required",
      }),
    ).toBe(true);

    const scopedLoan = {
      ...result,
      scope: "current_loans",
      items: [],
      total_count: 2,
      next_offset: 0,
      reservation_count: null,
    };
    expect(isMyLibraryReadResult(scopedLoan)).toBe(true);
    expect(isMyLibraryReadResult({ ...scopedLoan, loan_count: 1 })).toBe(false);

    const scoped = {
      ...result,
      scope: "purchase_requests",
      items: [],
      total_count: 0,
      next_offset: null,
      loan_count: null,
      reservation_count: null,
      overdue_count: null,
      renewable_count: null,
      earliest_due_date: null,
    };
    expect(isMyLibraryReadResult(scoped)).toBe(true);
    expect(isMyLibraryReadResult({ ...scoped, loan_count: 0 })).toBe(false);
    expect(
      isMyLibraryReadResult({
        ...scoped,
        status: "unavailable",
        loan_count: 0,
      }),
    ).toBe(false);
  });

  it("accepts CAST aggregates and rejects local notice details", () => {
    const result = {
      schema_version: "v1",
      status: "known",
      notice_count: 3,
      new_job_count: 4,
      new_internship_count: 7,
      new_event_count: 2,
      has_counseling_reservation: false,
      nearest_notice_date: "2026-08-20",
      reason_code: null,
    };
    expect(isCastReadResult(result)).toBe(true);
    expect(
      isCastReadResult({ ...result, notice_titles: ["must stay local"] }),
    ).toBe(false);
    expect(isCastReadResult({ ...result, status: "reauth_required" })).toBe(
      false,
    );
    expect(
      isCastReadResult({ ...result, nearest_notice_date: "2026-99-99" }),
    ).toBe(false);
  });

  it("accepts opaque CAST evidence as a career source", () => {
    expect(
      isActionProposal({
        ...proposal,
        evidence: [
          {
            evidence_id: "cast-summary-v1-synthetic",
            title: "CAST概要",
            source_type: "career",
            locator: "orbit-cast://summary/1234567890abcdef",
            data_classification: "personal",
          },
        ],
      }),
    ).toBe(true);
  });

  it("accepts a minimized SITRUS result but not a PDF or identity field", () => {
    const result = {
      schema_version: "v1",
      status: "known",
      report_label: "2025年度 秋学期 分まで",
      grades: [
        {
          subject: "合成科目",
          course_code: "L0410100",
          credits: 2,
          grade: "A",
          year: 2025,
          term: 2,
          term_slot: 1,
          repeated: false,
        },
      ],
      cumulative_gpa: 3.1,
      reason_code: null,
    };
    expect(isSitrusGradeResult(result)).toBe(true);
    expect(
      isSitrusGradeResult({
        ...result,
        report_label: "取得済み科目",
        grades: [{ ...result.grades[0], course_code: null, credits: null }],
        cumulative_gpa: null,
      }),
    ).toBe(true);
    expect(isSitrusGradeResult({ ...result, pdf_base64: "forbidden" })).toBe(
      false,
    );
    expect(isSitrusGradeResult({ ...result, student_number: "AL00000" })).toBe(
      false,
    );
    expect(
      isSitrusGradeResult({
        ...result,
        status: "unavailable",
        grades: [],
        cumulative_gpa: null,
        report_label: null,
      }),
    ).toBe(true);
    expect(
      isSitrusGradeResult({
        ...result,
        status: "unavailable",
      }),
    ).toBe(false);
  });

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

  it("adds the configured bearer token without changing the request body", async () => {
    const fetcher = createFetcher(jsonResponse(proposal));
    const client = new AgentApiClient({
      baseUrl: "https://agent.example.test",
      accessToken: "demo-token",
      fetcher,
    });

    await client.propose({ event: B1_OMIYA_EVENT, context: B1_OMIYA_CONTEXT });

    expect(fetcher).toHaveBeenCalledWith(
      "https://agent.example.test/v1/actions/propose",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer demo-token",
          "Content-Type": "application/json",
        },
      }),
    );
  });

  it("checks health without requiring a JSON response", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    const client = new AgentApiClient({
      baseUrl: "https://agent.example.test",
      accessToken: "demo-token",
      fetcher,
    });

    await expect(client.health()).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith("https://agent.example.test/health", {
      method: "GET",
      headers: {},
    });
  });

  it("reads authenticated Agent capabilities before personal data transfer", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        agent_backend: "azure_openai",
        my_library_personal_context: true,
      }),
    );
    const client = new AgentApiClient({
      baseUrl: "https://agent.example.test",
      accessToken: "demo-token",
      fetcher,
    });

    await expect(client.capabilities()).resolves.toEqual({
      agent_backend: "azure_openai",
      my_library_personal_context: true,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://agent.example.test/v1/capabilities",
      {
        method: "GET",
        headers: { Authorization: "Bearer demo-token" },
      },
    );
  });

  it("accepts a google_drive EvidenceLink with an opaque locator", async () => {
    const driveProposal = {
      ...proposal,
      evidence: [
        {
          evidence_id: "ev-sel_api_01",
          title: "選択した授業ノート",
          source_type: "google_drive",
          locator: "orbit-drive://sel_api_01",
          data_classification: "personal",
        },
      ],
    };
    expect(isActionProposal(driveProposal)).toBe(true);

    const fetcher = createFetcher(jsonResponse(driveProposal));
    const client = new AgentApiClient({ fetcher });
    await expect(
      client.propose({ event: B1_OMIYA_EVENT, context: B1_OMIYA_CONTEXT }),
    ).resolves.toMatchObject({
      evidence: [
        {
          source_type: "google_drive",
          locator: "orbit-drive://sel_api_01",
        },
      ],
    });
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
