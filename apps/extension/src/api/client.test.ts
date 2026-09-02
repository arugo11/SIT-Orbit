import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { B1_OMIYA_CONTEXT, B1_OMIYA_EVENT } from "../sidepanel/b1-fixture";
import {
  AgentApiClient,
  AgentApiError,
  classifyAgentApiError,
  type Fetcher,
  isActionProposal,
  isCastAlumniReadResult,
  isCastReadResult,
  isChatCapabilities,
  isChatRunResponse,
  isLibraryCatalogBrowseResult,
  isLibraryCatalogSearchResult,
  isLibraryDiscoverySearchResult,
  isLibraryItemReadResult,
  isMoodleReadResult,
  isMyLibraryReadResult,
  isScombzCourseListResult,
  isScombzCourseReadResult,
  isScombzMaterialSearchResult,
  isScombzPortalReadResult,
  isSitrusGradeResult,
  isSyllabusReadResult,
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

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
    headers: new Headers(headers),
  } as unknown as Response;
}

describe("isChatCapabilities", () => {
  it("accepts the explicit fixture SCombZ capability used by demo builds", () => {
    expect(
      isChatCapabilities({
        schema_version: "v1",
        agent_backend: "fixture",
        observability: "off",
        scombz_student_read_mode: "fixture",
        sitrus_personal_context_mode: "off",
        supported_client_tools: ["scombz_course_list", "scombz_course_read"],
        max_client_tools: 32,
      }),
    ).toBe(true);
  });
});

function createFetcher(response: Response): Fetcher & ReturnType<typeof vi.fn> {
  return vi.fn(async () => response) as unknown as Fetcher &
    ReturnType<typeof vi.fn>;
}

describe("AgentApiClient", () => {
  it("classifies value-free chat 422 responses by safe reason code", () => {
    expect(
      classifyAgentApiError(
        new AgentApiError("unused", 422, {
          detail: {
            reason_code: "chat_context_invalid",
            field: "context_manifest",
          },
        }),
      ),
    ).toBe("context_invalid");
    expect(
      classifyAgentApiError(
        new AgentApiError("unused", 422, {
          detail: { reason_code: "agent_output_invalid" },
        }),
      ),
    ).toBe("agent_output_invalid");
    expect(
      classifyAgentApiError(
        new AgentApiError("unused", 422, { detail: "legacy" }),
      ),
    ).toBe("contract_invalid");
  });

  it("validates grounded related-book cards in completed Chat responses", () => {
    expect(
      isChatRunResponse({
        status: "completed",
        message: {
          message_id: "msg-related-books",
          content_markdown: "候補です。",
          evidence: [
            {
              evidence_id: "web-search-v1-books-1",
              title: "公開書誌",
              source_type: "web",
              locator: "https://books.example/item",
              data_classification: "public",
            },
          ],
          related_books: [
            {
              candidate_ref: "orbit-book://candidate/1234567890abcdef",
              title: "Robot Learning",
              authors: ["Jane Doe"],
              isbn: "9780000000001",
              publication_year: 2024,
              relation_axes: [{ label: "強化学習", source: "metadata" }],
              why_related: "関連する。",
              evidence_ids: ["web-search-v1-books-1"],
              catalog_verification: {
                status: "unverified",
                resource_ref: null,
                observed_at: null,
              },
              observed_at: "2026-08-24T00:00:00Z",
            },
          ],
        },
        proposal: null,
      }),
    ).toBe(true);
  });

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
      isMyLibraryReadResult({ ...result, earliest_due_date: "2026-9-1" }),
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

  it("accepts only generalized CAST alumni aggregates", () => {
    const result = {
      schema_version: "v1",
      status: "known",
      data_classification: "personal",
      profile_count: 2,
      topic_categories: ["技術・研究"],
      availability_frequencies: ["monthly"],
      meeting_modes: ["online"],
      shareable_insight_categories: ["選考体験"],
      contact_present: true,
      discovered_link_count: 1,
      reason_code: null,
    };
    expect(isCastAlumniReadResult(result)).toBe(true);
    expect(isCastAlumniReadResult({ ...result, names: ["local only"] })).toBe(
      false,
    );
    expect(
      isCastAlumniReadResult({
        ...result,
        status: "unavailable",
        profile_count: 0,
      }),
    ).toBe(false);
    const restricted = {
      ...result,
      data_classification: "restricted",
      profile_count: 1,
      contact_present: false,
      profiles: [
        {
          alias: "[[ORBIT_PERSON_0123456789abcdef]]",
          role: "alumni",
          company: "Example Labs",
          technical_domains: ["自然言語処理"],
          job_types: ["研究開発"],
          location_area: "東京",
          graduation_year_bucket: "2020-2024",
          evidence_id: "cast-alumni-v1-0123456789abcdef",
        },
      ],
    };
    expect(isCastAlumniReadResult(restricted)).toBe(true);
    expect(
      isCastAlumniReadResult({
        ...restricted,
        profiles: [
          {
            ...restricted.profiles[0],
            email: "student@example.invalid",
          },
        ],
      }),
    ).toBe(false);
    expect(
      isCastAlumniReadResult({
        ...restricted,
        profiles: [
          {
            ...restricted.profiles[0],
            company: "https://example.invalid",
          },
        ],
      }),
    ).toBe(false);
    expect(
      isCastAlumniReadResult({
        ...restricted,
        profiles: undefined,
      }),
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

  it("accepts a bounded ILL copy operation and rejects extra provider fields", () => {
    const libraryEvidence = {
      evidence_id: "library-action-options-v1-test",
      title: "図書館の現在の操作可否",
      source_type: "library",
      locator: "orbit-library://record/0123456789abcdef",
      data_classification: "public",
    } as const;
    const illCopyProposal = {
      ...proposal,
      evidence: [libraryEvidence],
      external_action: "library_write",
      operation: {
        action_type: "ill_copy",
        resource_ref: libraryEvidence.locator,
      },
    };
    expect(isActionProposal(illCopyProposal)).toBe(true);
    expect(
      isActionProposal({
        ...illCopyProposal,
        operation: {
          ...illCopyProposal.operation,
          reason: "must-stay-in-local-confirmation-memory",
        },
      }),
    ).toBe(false);
  });

  it.each([
    "visit_shelf",
    "open_online",
    "reserve",
    "intercampus_transfer",
    "renew",
    "purchase_request",
    "ill_loan",
    "ill_copy",
  ] as const)(
    "keeps %s operation form values out of the API shape",
    (action_type) => {
      const libraryEvidence = {
        evidence_id: "library-action-options-v1-test-all",
        title: "図書館の現在の操作可否",
        source_type: "library",
        locator: "orbit-library://record/0123456789abcdef",
        data_classification: "public",
      } as const;
      const operation = {
        action_type,
        resource_ref: libraryEvidence.locator,
      } as const;
      const write = !["visit_shelf", "open_online"].includes(action_type);
      const candidate = {
        ...proposal,
        evidence: [libraryEvidence],
        external_action: write ? ("library_write" as const) : ("none" as const),
        operation,
      };
      expect(isActionProposal(candidate)).toBe(true);
      for (const field of [
        "reason",
        "pickup_campus",
        "payment",
        "fee",
        "page_range",
        "arguments",
      ]) {
        expect(
          isActionProposal({
            ...candidate,
            operation: { ...operation, [field]: "secret" },
          }),
        ).toBe(false);
      }
    },
  );

  it("accepts a minimized SITRUS result but not a PDF or identity field", () => {
    const result = {
      schema_version: "v1",
      status: "known",
      report_label: "2025年度 秋学期 分まで",
      grades: [
        {
          subject: "合成科目",
          credits: 2,
          grade: "A",
          outcome: "合格",
          year: 2025,
          term: 2,
        },
      ],
      credit_summaries: [
        {
          category: "専門科目",
          credit_type: "選択",
          current_course_count: 1,
          current_credits: 2,
          cumulative_course_count: 10,
          cumulative_credits: 20,
        },
      ],
      observed_at: "2026-09-02T00:00:00Z",
      reason_code: null,
    };
    expect(isSitrusGradeResult(result)).toBe(true);
    expect(
      isSitrusGradeResult({
        ...result,
        report_label: "取得済み科目",
        grades: [{ ...result.grades[0], credits: null }],
      }),
    ).toBe(true);
    expect(isSitrusGradeResult({ ...result, pdf_base64: "forbidden" })).toBe(
      false,
    );
    expect(isSitrusGradeResult({ ...result, student_number: "AL00000" })).toBe(
      false,
    );
    for (const forbidden of [
      "cumulative_gpa",
      "course_code",
      "term_slot",
      "repeated",
    ]) {
      const candidate = structuredClone(result);
      if (forbidden === "cumulative_gpa") {
        Object.assign(candidate, { [forbidden]: 3.1 });
      } else {
        Object.assign(candidate.grades[0] ?? {}, { [forbidden]: "forbidden" });
      }
      expect(isSitrusGradeResult(candidate)).toBe(false);
    }
    expect(
      isSitrusGradeResult({
        ...result,
        status: "unavailable",
        grades: [],
        credit_summaries: [],
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

  it("accepts the shared Python/TypeScript SITRUS contract fixture", () => {
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../../fixtures/contracts/sitrus_tool_result_v1.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ) as { result: unknown };

    expect(isSitrusGradeResult(fixture.result)).toBe(true);
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

  it("exchanges one-time PKCE material without forwarding a bearer credential", async () => {
    const fetcher = createFetcher(
      jsonResponse({
        access_token: "opaque-session",
        expires_at: "2026-08-23T04:30:00Z",
      }),
    );
    const client = new AgentApiClient({
      baseUrl: "https://agent.example.test",
      accessToken: "must-not-be-used-for-exchange",
      fetcher,
    });

    await expect(
      client.createSession({
        authorization_code: "one-time-code",
        code_verifier: "v".repeat(43),
      }),
    ).resolves.toEqual({
      access_token: "opaque-session",
      expires_at: "2026-08-23T04:30:00Z",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://agent.example.test/v1/auth/session",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authorization_code: "one-time-code",
          code_verifier: "v".repeat(43),
        }),
      },
    );
  });

  it("refreshes the managed session once after a 401 and does not fallback", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: "expired" }, 401))
      .mockResolvedValueOnce(jsonResponse(proposal));
    const sessionProvider = vi.fn(async (forceRefresh = false) =>
      forceRefresh ? "fresh-session" : "stale-session",
    );
    const client = new AgentApiClient({
      baseUrl: "https://agent.example.test",
      sessionProvider,
      fetcher,
    });

    await expect(
      client.propose({ event: B1_OMIYA_EVENT, context: B1_OMIYA_CONTEXT }),
    ).resolves.toEqual(proposal);
    expect(sessionProvider).toHaveBeenNthCalledWith(1, false);
    expect(sessionProvider).toHaveBeenNthCalledWith(2, true);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://agent.example.test/v1/actions/propose",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer fresh-session",
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

  it("omits the default sync mode for strict pre-background Chat APIs", async () => {
    const response = {
      status: "completed" as const,
      message: {
        message_id: "chat-compatibility",
        content_markdown: "確認しました。",
        evidence: [],
      },
      proposal: null,
    };
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.execution_mode).toBeUndefined();
        return jsonResponse(response);
      },
    ) as unknown as Fetcher;
    const client = new AgentApiClient({
      baseUrl: "https://agent.example.test",
      fetcher,
    });

    await expect(
      client.startChat({
        conversation_id: "compatibility-chat",
        message: "LLMに関するおすすめの本はある？",
        execution_mode: "sync",
      }),
    ).resolves.toEqual(response);
    expect(fetcher).toHaveBeenCalledWith(
      "https://agent.example.test/v1/chat/runs",
      expect.objectContaining({
        body: JSON.stringify({
          conversation_id: "compatibility-chat",
          message: "LLMに関するおすすめの本はある？",
        }),
      }),
    );
  });

  it("keeps an explicitly requested background mode", async () => {
    const response = {
      status: "completed" as const,
      message: {
        message_id: "chat-background",
        content_markdown: "バックグラウンドで確認しました。",
        evidence: [],
      },
      proposal: null,
    };
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.execution_mode).toBe("background");
        return jsonResponse(response);
      },
    ) as unknown as Fetcher;
    const client = new AgentApiClient({
      baseUrl: "https://agent.example.test",
      fetcher,
    });

    await expect(
      client.startChat({
        conversation_id: "background-chat",
        message: "進捗を確認して",
        execution_mode: "background",
      }),
    ).resolves.toEqual(response);
  });

  it("binds a complete server receipt to the submitted tool call", async () => {
    const response = {
      status: "completed" as const,
      message: {
        message_id: "chat-receipt",
        content_markdown: "確認しました。",
        evidence: [],
      },
      proposal: null,
    };
    const request = {
      tool_call_id: "call-receipt-1",
      name: "scombz_course_list" as const,
      version: 1 as const,
      result: {
        schema_version: "v1" as const,
        status: "known" as const,
        courses: [],
        coverage: {
          scope: "course_list",
          requested: 0,
          attempted: 0,
          succeeded: 0,
          failed: 0,
          truncated: false,
          next_cursor: null,
        },
        observed_at: "2026-08-30T00:00:00Z",
        reason_code: null,
      },
    };
    const fetcher = createFetcher(
      jsonResponse(response, 200, {
        "X-Orbit-Tool-Call-Id": request.tool_call_id,
        "X-Orbit-Evidence-Id": "scombz-course-list-v1-receipt-1",
      }),
    );
    const client = new AgentApiClient({ fetcher });

    await expect(
      client.submitChatToolResultWithReceipt("run-receipt", request),
    ).resolves.toEqual({
      response,
      evidence_id: "scombz-course-list-v1-receipt-1",
    });
  });

  it("rejects an incomplete or mismatched receipt instead of positional matching", async () => {
    const response = {
      status: "completed" as const,
      message: {
        message_id: "chat-receipt-invalid",
        content_markdown: "確認しました。",
        evidence: [],
      },
      proposal: null,
    };
    const request = {
      tool_call_id: "call-receipt-2",
      name: "scombz_course_list" as const,
      version: 1 as const,
      result: {
        schema_version: "v1" as const,
        status: "known" as const,
        courses: [],
        coverage: {
          scope: "course_list",
          requested: 0,
          attempted: 0,
          succeeded: 0,
          failed: 0,
          truncated: false,
          next_cursor: null,
        },
        observed_at: "2026-08-30T00:00:00Z",
        reason_code: null,
      },
    };
    const partial = new AgentApiClient({
      fetcher: createFetcher(
        jsonResponse(response, 200, {
          "X-Orbit-Tool-Call-Id": request.tool_call_id,
        }),
      ),
    });
    await expect(
      partial.submitChatToolResultWithReceipt("run-receipt", request),
    ).rejects.toMatchObject({
      name: "AgentApiError",
      status: 200,
      body: { category: "tool_result_invalid" },
    });

    const mismatched = new AgentApiClient({
      fetcher: createFetcher(
        jsonResponse(response, 200, {
          "X-Orbit-Tool-Call-Id": "call-receipt-other",
          "X-Orbit-Evidence-Id": "scombz-course-list-v1-receipt-2",
        }),
      ),
    });
    await expect(
      mismatched.submitChatToolResultWithReceipt("run-receipt", request),
    ).rejects.toMatchObject({
      name: "AgentApiError",
      status: 200,
      body: { category: "tool_result_invalid" },
    });
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
      message: "Agent API request failed: network",
      body: { category: "network" },
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

  it("validates all typed SCombZ projections and rejects hidden identifiers", () => {
    const coverage = {
      scope: "fixture",
      requested: 1,
      attempted: 1,
      succeeded: 1,
      failed: 0,
      truncated: false,
      next_cursor: null,
    };
    const course = {
      course_ref: "orbit-scombz://course/1234567890abcdef",
      display_name: "自然言語処理",
      academic_year: 2026,
      term: "春",
      weekday: "金",
      period: "3",
      citation_uri: "orbit-scombz://citation/1234567890abcdef",
    };
    const common = {
      schema_version: "v1" as const,
      status: "known" as const,
      coverage,
      observed_at: "2026-08-28T00:00:00Z",
      reason_code: null,
    };
    expect(isScombzCourseListResult({ ...common, courses: [course] })).toBe(
      true,
    );
    expect(
      isScombzPortalReadResult({
        ...common,
        items: [
          {
            ref: "orbit-scombz://item/1234567890abcdef",
            section: "announcements",
            title: "授業連絡",
            detail: null,
            observed_at: common.observed_at,
            citation_uri: "orbit-scombz://citation/1234567890abcdef",
          },
        ],
      }),
    ).toBe(true);
    expect(
      isScombzCourseReadResult({
        ...common,
        items: [
          {
            ref: "orbit-scombz://item/1234567890abcdef",
            course_ref: course.course_ref,
            section: "課題",
            title: "レポート",
            body: null,
            due_at: null,
            state: null,
            has_pdf: false,
            observed_at: common.observed_at,
            citation_uri: "orbit-scombz://citation/1234567890abcdef",
          },
        ],
        section_states: { 課題: "complete" },
      }),
    ).toBe(true);
    expect(
      isScombzMaterialSearchResult({
        ...common,
        hits: [
          {
            material_ref: "orbit-scombz://material/1234567890abcdef",
            course_ref: course.course_ref,
            material_title: "講義資料.pdf",
            page: 2,
            quote: "形態素解析の説明",
            observed_at: common.observed_at,
            citation_uri: "orbit-scombz://citation/1234567890abcdef-p2",
          },
        ],
      }),
    ).toBe(true);
    expect(
      isScombzCourseListResult({
        ...common,
        courses: [{ ...course, internal_id: "secret" }],
      }),
    ).toBe(false);
  });

  it("validates syllabus detail refs and blocks URL/ref substitutions", () => {
    const detail = {
      schema_version: "v1" as const,
      status: "known" as const,
      syllabus_ref: "orbit-syllabus://result/1234567890abcdef",
      url: "https://syllabus.sic.shibaura-it.ac.jp/course/1",
      course_code: "A0001",
      title: "自然言語処理",
      instructors: ["公開教員"],
      objectives: "目的",
      weekly_plan: ["第1回"],
      evaluation: "試験",
      textbooks: ["教科書"],
      prerequisites: "線形代数",
      observed_at: "2026-08-28T00:00:00Z",
      reason_code: null,
      citation_uri: "orbit-syllabus://citation/1234567890abcdef",
    };
    expect(isSyllabusReadResult(detail)).toBe(true);
    expect(
      isSyllabusReadResult({
        ...detail,
        url: "https://evil.example/course/1",
      }),
    ).toBe(false);
    expect(isSyllabusReadResult({ ...detail, syllabus_url: detail.url })).toBe(
      false,
    );
  });
});
