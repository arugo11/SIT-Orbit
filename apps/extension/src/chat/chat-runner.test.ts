import { describe, expect, it } from "vitest";
import type {
  ChatCapabilities,
  ChatRunResponse,
  ChatToolResultRequest,
} from "../api/client";
import { ChatRunner } from "./chat-runner";

const capabilities: ChatCapabilities = {
  schema_version: "v1",
  agent_backend: "azure_openai",
  observability: "off",
  scombz_student_read_mode: "live",
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
      executeTool: async (call) => ({ request: result(call.tool_call_id) }),
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

  it("removes live SCombZ tools from a malformed non-live capability", async () => {
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
      "syllabus_search",
    ]);
  });
});
