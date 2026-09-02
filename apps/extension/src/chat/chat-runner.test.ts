import { describe, expect, it } from "vitest";
import {
  type CastSearchResult,
  type ChatCapabilities,
  type ChatRunRequest,
  type ChatRunResponse,
  type ChatToolName,
  type ChatToolResultRequest,
  isCastSearchResult,
  isLibraryCatalogSearchResult,
  isScombzCourseListResult,
  isScombzCourseReadResult,
  isSyllabusReadResult,
  isSyllabusSearchResult,
  type LibraryBibliographicRecord,
  type LibraryCatalogSearchResult,
  type RelatedBookCandidate,
  type ScombzCourseListResult,
  type ScombzCourseReadResult,
  type SyllabusReadResult,
  type SyllabusSearchResult,
} from "../api/client";
import { ChatRunner } from "./chat-runner";

const capabilities: ChatCapabilities = {
  schema_version: "v1",
  agent_backend: "azure_openai",
  observability: "off",
  scombz_student_read_mode: "live",
  sitrus_personal_context_mode: "off",
  supported_client_tools: ["scombz_course_list", "scombz_portal_read"],
  max_client_tools: 32,
};

const result = (toolCallId: string): ChatToolResultRequest =>
  ({
    tool_call_id: toolCallId,
    name: "scombz_course_list",
    version: 1,
    result: {
      schema_version: "v1",
      status: "known",
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
      observed_at: new Date().toISOString(),
      reason_code: null,
    },
  }) as ChatToolResultRequest;

describe("ChatRunner", () => {
  it("supports repeated read-only calls and binds receipts to the exact call", async () => {
    let executionCount = 0;
    const responses: ChatRunResponse[] = [
      {
        status: "tool_required",
        run_id: "run-1",
        calls: [
          {
            tool_call_id: "call-1",
            name: "scombz_course_list",
            version: 1,
            arguments: {},
          },
        ],
      },
      {
        status: "tool_required",
        run_id: "run-1",
        calls: [
          {
            tool_call_id: "call-2",
            name: "scombz_course_list",
            version: 1,
            arguments: {},
          },
        ],
      },
      {
        status: "completed",
        message: {
          message_id: "message-1",
          content_markdown: "確認しました。",
          evidence: [],
        },
        proposal: null,
      },
    ];
    const receipts = new Map([
      ["call-1", "evidence-1"],
      ["call-2", "evidence-2"],
    ]);
    const api = {
      chatCapabilities: async () => capabilities,
      startChat: async () => responses.shift() as ChatRunResponse,
      submitChatToolResultWithReceipt: async (
        _runId: string,
        request: ChatToolResultRequest,
      ) => ({
        response: responses.shift() as ChatRunResponse,
        evidence_id: receipts.get(request.tool_call_id) ?? null,
      }),
      submitChatToolResult: async () => responses.shift() as ChatRunResponse,
    };
    const runner = new ChatRunner({
      api,
      executeTool: async (call) => {
        executionCount += 1;
        return { request: result(call.tool_call_id) };
      },
    });
    const output = await runner.run({
      conversation_id: "conversation-runner",
      message: "授業を確認して",
      locally_available_tools: new Set(["scombz_course_list"]),
      require_live_scombz: true,
    });
    expect(output.calls.map((call) => call.tool_call_id)).toEqual([
      "call-1",
      "call-2",
    ]);
    expect(output.receipts).toEqual([
      { tool_call_id: "call-1", evidence_id: "evidence-1" },
      { tool_call_id: "call-2", evidence_id: "evidence-2" },
    ]);
    expect(executionCount).toBe(1);
    expect(output.calls[1]?.audit).toEqual({ cache_hit: true });
  });

  it("fails closed when live capabilities are unavailable", async () => {
    const api = {
      chatCapabilities: async (): Promise<ChatCapabilities> => ({
        ...capabilities,
        scombz_student_read_mode: "fixture" as const,
      }),
      startChat: async () => {
        throw new Error("must not start");
      },
      submitChatToolResult: async () => {
        throw new Error("must not resume");
      },
    };
    const runner = new ChatRunner({
      api,
      executeTool: async () => ({ request: result("call") }),
    });
    await expect(
      runner.run({
        conversation_id: "conversation-runner",
        message: "授業を確認して",
        locally_available_tools: new Set(["scombz_course_list"]),
        require_live_scombz: true,
      }),
    ).rejects.toMatchObject({
      code: "capability_unavailable",
    });
  });

  it("accepts SCombZ tools only for the explicit fixture capability", async () => {
    const started: Array<{ client_tools?: Array<{ name: string }> }> = [];
    const api = {
      chatCapabilities: async (): Promise<ChatCapabilities> => ({
        ...capabilities,
        agent_backend: "fixture",
        scombz_student_read_mode: "fixture",
        supported_client_tools: ["scombz_course_list", "syllabus_search"],
      }),
      startChat: async (request: {
        client_tools?: Array<{ name: string }>;
      }) => {
        started.push(request);
        return {
          status: "completed" as const,
          run_id: "run-non-live",
          message: {
            message_id: "message-non-live",
            content_markdown: "確認しました。",
            evidence: [],
          },
          proposal: null,
        };
      },
      submitChatToolResult: async () => {
        throw new Error("must not resume");
      },
    };
    const runner = new ChatRunner({
      api,
      executeTool: async () => ({ request: result("unused") }),
    });
    await runner.run({
      conversation_id: "conversation-non-live",
      message: "確認して",
      locally_available_tools: new Set([
        "scombz_course_list",
        "syllabus_search",
      ]),
    });
    expect(started[0]?.client_tools?.map((tool) => tool.name)).toEqual([
      "scombz_course_list",
      "syllabus_search",
    ]);
  });

  it("replays the six-turn video conversation with fixed API and tool mocks", async () => {
    const utterances = [
      "何ができるの？",
      "人工知能の授業では、どんなことを学ぶの？",
      "強化学習はどのあたり？ 授業全体での位置づけも知りたい。",
      "それを仕事として体験するなら、今参加できるものはある？",
      "理解の助けになる入門書を、3冊候補にして。",
      "その3冊、芝浦で今借りられる？",
    ] as const;
    const bookTitles = [
      "イラストで学ぶ 人工知能概論 改訂第2版",
      "IT Text 人工知能 改訂2版",
      "強化学習 第2版",
    ] as const;
    const videoCapabilities: ChatCapabilities = {
      ...capabilities,
      supported_client_tools: [
        "scombz_course_list",
        "scombz_course_read",
        "syllabus_search",
        "syllabus_read",
        "cast_search",
        "library_catalog_search",
        "library_item_read",
      ],
    };
    const call = (
      tool_call_id: string,
      name: ChatToolName,
      argumentsObject: Record<string, unknown> = {},
    ): Extract<
      ChatRunResponse,
      { status: "tool_required" }
    >["calls"][number] => ({
      tool_call_id,
      name,
      version: 1,
      arguments: argumentsObject,
    });
    const required = (
      run_id: string,
      tool_call_id: string,
      name: ChatToolName,
      argumentsObject: Record<string, unknown> = {},
    ): ChatRunResponse => ({
      status: "tool_required",
      run_id,
      calls: [call(tool_call_id, name, argumentsObject)],
    });
    const completed = (
      message_id: string,
      content_markdown: string,
      related_books?: RelatedBookCandidate[],
    ): ChatRunResponse => ({
      status: "completed",
      message: {
        message_id,
        content_markdown,
        evidence:
          related_books?.flatMap((book) =>
            book.evidence_ids.map((evidence_id) => ({
              evidence_id,
              title: book.title,
              source_type: "web" as const,
              locator: "https://books.example/public",
              data_classification: "public" as const,
            })),
          ) ?? [],
        ...(related_books ? { related_books } : {}),
      },
      proposal: null,
    });
    const publicBooks: RelatedBookCandidate[] = bookTitles.map(
      (title, index) => ({
        candidate_ref: `orbit-book://candidate/video-book-${index + 1}-2026`,
        title,
        authors: ["公開書誌著者"],
        isbn: ["978-4-0000-0000-1", "978-4-0000-0000-2", null][index] ?? null,
        publication_year: 2024,
        relation_axes: [
          {
            label: index === 2 ? "強化学習" : "人工知能",
            source: "metadata",
          },
        ],
        why_related: "人工知能と強化学習の基礎を学べるため",
        evidence_ids: [`web-book-v1-${index + 1}`],
        catalog_verification: {
          status: "unverified",
          resource_ref: null,
          observed_at: null,
        },
        observed_at: "2026-08-31T00:00:00Z",
      }),
    );
    const observedAt = "2026-08-31T00:00:00Z";
    const courseRef = "orbit-scombz://course/artificial-intelligence-2025";
    const syllabusRef = "orbit-syllabus://result/artificial-intelligence-2025";
    const courseListResult: ScombzCourseListResult = {
      schema_version: "v1",
      status: "known",
      courses: [
        {
          course_ref: courseRef,
          display_name: "人工知能",
          academic_year: 2025,
          term: "後期",
          weekday: "火",
          period: "3",
          citation_uri: "orbit-scombz://citation/artificial-intelligence-2025",
        },
      ],
      coverage: {
        scope: "course_list",
        requested: 1,
        attempted: 1,
        succeeded: 1,
        failed: 0,
        truncated: false,
        next_cursor: null,
      },
      observed_at: observedAt,
      reason_code: null,
    };
    const courseReadResult: ScombzCourseReadResult = {
      schema_version: "v1",
      status: "known",
      items: [
        {
          ref: "orbit-scombz://item/artificial-intelligence-overview-2025",
          course_ref: courseRef,
          section: "概要",
          title: "人工知能",
          body: "探索と強化学習の基礎を扱う。",
          due_at: null,
          state: "active",
          has_pdf: false,
          observed_at: observedAt,
          citation_uri:
            "orbit-scombz://citation/artificial-intelligence-overview-2025",
        },
      ],
      section_states: { overview: "complete", materials: "complete" },
      coverage: {
        scope: "course_read",
        requested: 2,
        attempted: 2,
        succeeded: 2,
        failed: 0,
        truncated: false,
        next_cursor: null,
      },
      observed_at: observedAt,
      reason_code: null,
    };
    const syllabusSearchResult: SyllabusSearchResult = {
      schema_version: "v1",
      status: "known",
      query: "人工知能 強化学習",
      year: 2025,
      faculty: "工学部",
      results: [
        {
          syllabus_ref: syllabusRef,
          title: "人工知能",
          course_code: "AI2025",
          faculty: "工学部",
          url: "https://syllabus.sic.shibaura-it.ac.jp/course/artificial-intelligence-2025",
          snippet: "探索、強化学習などを学ぶ。",
          citation_uri:
            "orbit-syllabus://citation/artificial-intelligence-2025",
        },
      ],
      observed_at: observedAt,
      reason_code: null,
    };
    const syllabusReadResult: SyllabusReadResult = {
      schema_version: "v1",
      status: "known",
      syllabus_ref: syllabusRef,
      url: "https://syllabus.sic.shibaura-it.ac.jp/course/artificial-intelligence-2025",
      course_code: "AI2025",
      title: "人工知能",
      instructors: ["公開教員"],
      objectives: "人工知能の基礎と応用を理解する。",
      weekly_plan: ["第8回: 強化学習"],
      evaluation: "試験と課題",
      textbooks: ["人工知能入門"],
      prerequisites: "基礎数学",
      observed_at: observedAt,
      reason_code: null,
      citation_uri: "orbit-syllabus://citation/artificial-intelligence-2025",
    };
    const castSearchResult: CastSearchResult = {
      schema_version: "v1",
      status: "known",
      applied_filters: {
        kind: "internship",
        filters: { industries: ["情報・通信"] },
        sort: null,
        graduation_years_defaulted: false,
      },
      total_count: 8,
      returned_count: 8,
      coverage: {
        mode: "complete",
        page_size: 10,
        fetched_pages: 1,
        total_pages: 1,
      },
      anonymous_aggregates: [
        { dimension: "industry", value: "情報・通信", count: 8 },
      ],
      evidence_ids: ["cast-search-v1-0123456789abcdef"],
      reason_code: null,
    };
    const catalogRecord = (
      title: string,
      resource_ref: string,
      isbn: string,
      call_number: string,
    ): LibraryBibliographicRecord => ({
      resource_ref,
      title,
      authors: ["公開書誌著者"],
      subjects: ["人工知能"],
      isbn,
      publisher: "公開出版社",
      publication_year: 2024,
      format: "book",
      campus: "omiya",
      url: `https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/${resource_ref.slice(-16)}`,
      holdings: [
        {
          campus: "omiya",
          location: "大宮図書館",
          call_number,
          status: "available",
          due_date: null,
          reservation_count: 0,
        },
      ],
      related_records: [],
    });
    const catalogResults: Record<string, LibraryCatalogSearchResult> = {
      [bookTitles[0]]: {
        schema_version: "v1",
        status: "known",
        query: bookTitles[0],
        items: [
          catalogRecord(
            bookTitles[0],
            "orbit-library://record/video-book-00000001",
            "978-4-0000-0000-1",
            "007.1/I1",
          ),
        ],
        reason_code: null,
      },
      [bookTitles[1]]: {
        schema_version: "v1",
        status: "known",
        query: bookTitles[1],
        items: [
          catalogRecord(
            bookTitles[1],
            "orbit-library://record/video-book-00000002",
            "978-4-0000-0000-2",
            "007.1/I2",
          ),
        ],
        reason_code: null,
      },
      [bookTitles[2]]: {
        schema_version: "v1",
        status: "known",
        query: bookTitles[2],
        items: [],
        reason_code: null,
      },
    };
    const plans = new Map<string, ChatRunResponse[]>([
      [
        utterances[0],
        [completed("message-1", "SIT ORBITの機能を案内します。")],
      ],
      [
        utterances[1],
        [
          required("run-2", "call-2-list", "scombz_course_list", {
            query: "人工知能",
          }),
          required("run-2", "call-2-read", "scombz_course_read", {
            course_refs: ["orbit-scombz://course/artificial-intelligence-2025"],
            sections: ["overview", "materials"],
          }),
          completed("message-2", "人工知能では探索や強化学習などを学びます。"),
        ],
      ],
      [
        utterances[2],
        [
          required("run-3", "call-3-search", "syllabus_search", {
            query: "人工知能 強化学習",
          }),
          required("run-3", "call-3-read", "syllabus_read", {
            syllabus_ref:
              "orbit-syllabus://result/artificial-intelligence-2025",
          }),
          completed("message-3", "強化学習は授業後半の第8回に位置づきます。"),
        ],
      ],
      [
        utterances[3],
        [
          required("run-4", "call-4-cast", "cast_search", {
            kind: "internship",
            filters: { industries: ["情報・通信"] },
          }),
          completed("message-4", "CASTのインターンを確認しました。"),
        ],
      ],
      [
        utterances[4],
        [
          completed(
            "message-5",
            "公開情報から3冊の候補を確認しました。",
            publicBooks,
          ),
        ],
      ],
      [
        utterances[5],
        [
          required("run-6", "call-6-book-1", "library_catalog_search", {
            query: bookTitles[0],
          }),
          required("run-6", "call-6-book-2", "library_catalog_search", {
            query: bookTitles[1],
          }),
          required("run-6", "call-6-book-3", "library_catalog_search", {
            query: bookTitles[2],
          }),
          completed("message-6", "3冊を一冊ずつ検索しました。"),
        ],
      ],
    ]);
    const starts: ChatRunRequest[] = [];
    const submitted: ChatToolResultRequest[] = [];
    const executed: Array<{
      name: ChatToolName;
      arguments: Record<string, unknown>;
    }> = [];
    const pending = new Map<string, ChatRunResponse[]>();
    const mockResult = (
      toolCallId: string,
      name: ChatToolName,
      argumentsObject: Record<string, unknown>,
    ): ChatToolResultRequest => {
      let toolResult:
        | ScombzCourseListResult
        | ScombzCourseReadResult
        | SyllabusSearchResult
        | SyllabusReadResult
        | CastSearchResult
        | LibraryCatalogSearchResult;
      switch (name) {
        case "scombz_course_list":
          toolResult = courseListResult;
          break;
        case "scombz_course_read":
          toolResult = courseReadResult;
          break;
        case "syllabus_search":
          toolResult = syllabusSearchResult;
          break;
        case "syllabus_read":
          toolResult = syllabusReadResult;
          break;
        case "cast_search":
          toolResult = castSearchResult;
          break;
        case "library_catalog_search": {
          const query = argumentsObject.query;
          if (typeof query !== "string" || !catalogResults[query]) {
            throw new Error(`unexpected catalog query: ${String(query)}`);
          }
          toolResult = catalogResults[query];
          break;
        }
        default:
          throw new Error(`unexpected tool result: ${name}`);
      }
      return {
        tool_call_id: toolCallId,
        name,
        version: 1,
        result: toolResult,
      };
    };
    const api = {
      chatCapabilities: async () => videoCapabilities,
      startChat: async (request: ChatRunRequest) => {
        starts.push(request);
        const plan = plans.get(request.message);
        if (!plan) throw new Error(`unexpected message: ${request.message}`);
        const response = plan.shift();
        if (!response) throw new Error(`plan exhausted: ${request.message}`);
        if (response.status === "tool_required") {
          pending.set(response.run_id, plan);
        }
        return response;
      },
      submitChatToolResult: async () => {
        throw new Error("receipt-aware mock should be used");
      },
      submitChatToolResultWithReceipt: async (
        runId: string,
        request: ChatToolResultRequest,
      ) => {
        submitted.push(request);
        const plan = pending.get(runId);
        const response = plan?.shift();
        if (!response) throw new Error(`no pending response for ${runId}`);
        if (response.status === "completed") pending.delete(runId);
        return {
          response,
          evidence_id: `evidence-${request.tool_call_id}`,
        };
      },
    };
    const runner = new ChatRunner({
      api,
      executeTool: async (toolCall) => {
        executed.push({
          name: toolCall.name,
          arguments: toolCall.arguments ?? {},
        });
        return {
          request: mockResult(
            toolCall.tool_call_id,
            toolCall.name,
            toolCall.arguments ?? {},
          ),
        };
      },
    });
    const locallyAvailable = [
      new Set<string>(),
      new Set(["scombz_course_list", "scombz_course_read"]),
      new Set(["syllabus_search", "syllabus_read"]),
      new Set(["cast_search"]),
      new Set<string>(),
      new Set(["library_catalog_search", "library_item_read"]),
    ];
    let history: ChatRunRequest["history"] = [];
    let contextManifest: ChatRunRequest["context_manifest"] = null;
    const turns: Awaited<ReturnType<ChatRunner["run"]>>[] = [];
    for (const [index, message] of utterances.entries()) {
      const output = await runner.run({
        conversation_id: "video-conversation",
        message,
        history,
        context_manifest: contextManifest,
        capabilities: videoCapabilities,
        locally_available_tools: locallyAvailable[index],
      });
      turns.push(output);
      history = [
        ...(history ?? []),
        { role: "user", content: message },
        {
          role: "assistant",
          content: output.response.message.content_markdown,
        },
      ];
      if (output.response.message.related_books) {
        contextManifest = {
          schema_version: "v1",
          related_books: output.response.message.related_books,
        };
      }
    }

    expect(starts.map((request) => request.conversation_id)).toEqual(
      utterances.map(() => "video-conversation"),
    );
    expect(
      starts.map((request) => request.client_tools?.map((tool) => tool.name)),
    ).toEqual([
      [],
      ["scombz_course_list", "scombz_course_read"],
      ["syllabus_search", "syllabus_read"],
      ["cast_search"],
      [],
      ["library_catalog_search", "library_item_read"],
    ]);
    expect(
      turns.map((turn) => turn.calls.map((toolCall) => toolCall.name)),
    ).toEqual([
      [],
      ["scombz_course_list", "scombz_course_read"],
      ["syllabus_search", "syllabus_read"],
      ["cast_search"],
      [],
      [
        "library_catalog_search",
        "library_catalog_search",
        "library_catalog_search",
      ],
    ]);
    expect(starts.map((request) => request.history?.length)).toEqual([
      0, 2, 4, 6, 8, 10,
    ]);
    expect(
      starts[5]?.context_manifest?.related_books?.map((book) => book.title),
    ).toEqual([...bookTitles]);
    expect(
      executed.find((toolCall) => toolCall.name === "cast_search")?.arguments,
    ).toMatchObject({
      kind: "internship",
    });
    const catalogQueries = executed
      .filter((toolCall) => toolCall.name === "library_catalog_search")
      .map((toolCall) => toolCall.arguments.query);
    expect(catalogQueries).toEqual([...bookTitles]);
    expect(new Set(catalogQueries).size).toBe(3);
    expect(
      catalogQueries.some(
        (query) =>
          typeof query === "string" &&
          bookTitles.some((title) => title !== query && query.includes(title)),
      ),
    ).toBe(false);
    expect(submitted.map((request) => request.name)).toEqual([
      "scombz_course_list",
      "scombz_course_read",
      "syllabus_search",
      "syllabus_read",
      "cast_search",
      "library_catalog_search",
      "library_catalog_search",
      "library_catalog_search",
    ]);
    expect(isScombzCourseListResult(submitted[0]?.result)).toBe(true);
    expect(isScombzCourseReadResult(submitted[1]?.result)).toBe(true);
    expect(isSyllabusSearchResult(submitted[2]?.result)).toBe(true);
    expect(isSyllabusReadResult(submitted[3]?.result)).toBe(true);
    expect(isCastSearchResult(submitted[4]?.result)).toBe(true);
    const catalogResultsSubmitted = submitted
      .slice(5)
      .map((request) => request.result as LibraryCatalogSearchResult);
    expect(catalogResultsSubmitted.map((item) => item.query)).toEqual([
      ...bookTitles,
    ]);
    expect(
      catalogResultsSubmitted.map((item) => item.items?.[0]?.title ?? null),
    ).toEqual([bookTitles[0], bookTitles[1], null]);
    expect(
      catalogResultsSubmitted
        .slice(0, 2)
        .flatMap((item) => item.items ?? [])
        .flatMap((item) => item.holdings ?? [])
        .map((holding) => holding.status),
    ).toEqual(["available", "available"]);
    expect(isLibraryCatalogSearchResult(catalogResultsSubmitted[2])).toBe(true);
  });
});
