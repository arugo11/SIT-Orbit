import type {
  AgentApiClient,
  ChatCapabilities,
  ChatRunRequest,
  ChatRunResponse,
  ChatToolName,
  ChatToolResultRequest,
} from "../api/client";
import {
  advertiseReadOnlyTools,
  isRegisteredReadOnlyTool,
  validateChatToolArguments,
} from "./tool-registry";

export interface ChatToolReceipt {
  tool_call_id: string;
  evidence_id: string | null;
}

export interface ChatRunnerEvent {
  phase: "capabilities" | "planning" | "tool" | "resuming" | "completed";
  tool_call_id?: string;
  tool_name?: ChatToolName;
  status?: string;
  detail?: string;
}

export interface ChatToolExecutionContext {
  conversation_id: string;
  source_generation: string;
  signal?: AbortSignal;
}

export interface ChatToolExecution {
  request: ChatToolResultRequest;
  /** A local-only redacted projection for audit/UI progress. */
  audit?: Record<string, unknown>;
}

export type ChatToolExecutor = (
  call: Extract<ChatRunResponse, { status: "tool_required" }>["calls"][number],
  context: ChatToolExecutionContext,
) => Promise<ChatToolExecution>;

export interface ChatRunnerApi {
  startChat(
    request: ChatRunRequest,
    signal?: AbortSignal,
  ): Promise<ChatRunResponse>;
  submitChatToolResult(
    runId: string,
    request: ChatToolResultRequest,
    signal?: AbortSignal,
  ): Promise<ChatRunResponse>;
  submitChatToolResultWithReceipt?(
    runId: string,
    request: ChatToolResultRequest,
    signal?: AbortSignal,
  ): Promise<{ response: ChatRunResponse; evidence_id: string | null }>;
  chatCapabilities?(signal?: AbortSignal): Promise<ChatCapabilities>;
}

export interface ChatRunnerInput {
  conversation_id: string;
  message: string;
  history?: ChatRunRequest["history"];
  context_manifest?: ChatRunRequest["context_manifest"];
  /**
   * An already-read capability response.  The Side Panel uses this to bind
   * consent/pseudonymisation and the Chat run to one snapshot instead of
   * issuing a second capability request between those steps.
   * `null` means the request failed and the runner must advertise no client
   * tools; it is intentionally different from an omitted value.
   */
  capabilities?: ChatCapabilities | null;
  locally_available_tools?: ReadonlySet<string> | null;
  /** Require the live SCombZ gate when the runner is used by the audit path. */
  require_live_scombz?: boolean;
  /** Stable local source version; changing it invalidates exact-result reuse. */
  source_generation?: string;
  signal?: AbortSignal;
}

export interface ChatRunnerResult {
  response: Extract<ChatRunResponse, { status: "completed" }>;
  client_tools: ChatRunRequest["client_tools"];
  calls: Array<{
    tool_call_id: string;
    name: ChatToolName;
    arguments: Record<string, unknown>;
    audit?: Record<string, unknown>;
  }>;
  receipts: ChatToolReceipt[];
  capabilities: ChatCapabilities | null;
}

export class ChatRunnerError extends Error {
  readonly code:
    | "capability_unavailable"
    | "tool_not_advertised"
    | "invalid_tool_arguments"
    | "duplicate_tool_call"
    | "protocol_invalid"
    | "tool_limit_exceeded";

  constructor(code: ChatRunnerError["code"], message: string) {
    super(message);
    this.name = "ChatRunnerError";
    this.code = code;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw new DOMException("The operation was aborted.", "AbortError");
}

function protocolError(message: string): ChatRunnerError {
  return new ChatRunnerError("protocol_invalid", message);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * UI-independent resumable Chat loop.  The Side Panel and the audit bridge
 * use this same loop; only their tool executor and event sink differ.
 */
export class ChatRunner {
  private readonly api: ChatRunnerApi;
  private readonly executeTool: ChatToolExecutor;
  private readonly onEvent?: (event: ChatRunnerEvent) => void;
  private readonly maxToolCalls: number;

  constructor(options: {
    api: ChatRunnerApi | AgentApiClient;
    executeTool: ChatToolExecutor;
    onEvent?: (event: ChatRunnerEvent) => void;
    maxToolCalls?: number;
  }) {
    this.api = options.api;
    this.executeTool = options.executeTool;
    this.onEvent = options.onEvent;
    this.maxToolCalls = Math.min(8, Math.max(1, options.maxToolCalls ?? 8));
  }

  async run(input: ChatRunnerInput): Promise<ChatRunnerResult> {
    if (!input.message.trim()) throw new TypeError("Chat message is empty.");
    throwIfAborted(input.signal);
    const capabilities =
      "capabilities" in input
        ? (input.capabilities ?? null)
        : await this.readCapabilities(
            input.require_live_scombz === true,
            input.signal,
          );
    throwIfAborted(input.signal);
    const liveScombzCapability =
      capabilities !== null &&
      capabilities.agent_backend === "azure_openai" &&
      capabilities.observability === "off" &&
      capabilities.scombz_student_read_mode === "live";
    const liveSitrusCapability =
      capabilities !== null &&
      capabilities.agent_backend === "azure_openai" &&
      capabilities.observability === "off" &&
      capabilities.sitrus_personal_context_mode === "live";
    if (input.require_live_scombz && !liveScombzCapability) {
      throw new ChatRunnerError(
        "capability_unavailable",
        "監査対象のlive SCombZ capabilityが有効ではありません。",
      );
    }
    this.onEvent?.({
      phase: "capabilities",
      detail: "capability intersection ready",
    });
    const serverAllowed = capabilities
      ? new Set(capabilities.supported_client_tools)
      : new Set<string>();
    if (!liveScombzCapability) {
      for (const tool of [
        "scombz_course_list",
        "scombz_portal_read",
        "scombz_course_read",
        "scombz_material_search",
      ]) {
        serverAllowed.delete(tool);
      }
    }
    if (!liveSitrusCapability) {
      serverAllowed.delete("sitrus_read");
    }
    const clientTools = advertiseReadOnlyTools({
      locallyAvailable: input.locally_available_tools,
      serverAllowed,
      maxClientTools: capabilities?.max_client_tools ?? 32,
    });
    const advertised = new Set(clientTools.map((tool) => tool.name));
    throwIfAborted(input.signal);
    let response = await this.api.startChat(
      {
        conversation_id: input.conversation_id,
        message: input.message,
        history: input.history ?? [],
        context_manifest: input.context_manifest ?? null,
        client_tools: clientTools,
      },
      input.signal,
    );
    throwIfAborted(input.signal);
    let runId: string | null =
      response.status === "tool_required" ? response.run_id : null;
    const calls: ChatRunnerResult["calls"] = [];
    const receipts: ChatToolReceipt[] = [];
    const seen = new Set<string>();
    const sourceGeneration = input.source_generation ?? "run-local-v1";
    const resultCache = new Map<string, ChatToolExecution>();
    for (let index = 0; response.status === "tool_required"; index += 1) {
      if (index >= this.maxToolCalls) {
        throw new ChatRunnerError(
          "tool_limit_exceeded",
          "Tool呼び出し回数の上限に達しました。",
        );
      }
      throwIfAborted(input.signal);
      if (runId === null || response.run_id !== runId) {
        throw protocolError("Chat run IDが継続中に変更されました。");
      }
      if (response.calls.length !== 1) {
        throw protocolError("Chatは一度に1件のTool callだけを要求できます。");
      }
      const call = response.calls[0];
      if (!call || call.version !== 1) {
        throw protocolError("Chat Tool callのversionは1である必要があります。");
      }
      if (seen.has(call.tool_call_id)) {
        throw new ChatRunnerError(
          "duplicate_tool_call",
          "重複したTool呼び出しを受け取りました。",
        );
      }
      if (!isRegisteredReadOnlyTool(call.name) || !advertised.has(call.name)) {
        throw new ChatRunnerError(
          "tool_not_advertised",
          "広告されていないread-only Toolが要求されました。",
        );
      }
      const validation = validateChatToolArguments(call.name, call.arguments);
      if (!validation.ok) {
        throw new ChatRunnerError(
          "invalid_tool_arguments",
          `Tool引数を検証できません（${validation.reason}）。`,
        );
      }
      seen.add(call.tool_call_id);
      this.onEvent?.({
        phase: "tool",
        tool_call_id: call.tool_call_id,
        tool_name: call.name,
        detail: "read-only executor started",
      });
      const cacheKey = `${call.name}:${stableJson(validation.arguments)}:${sourceGeneration}`;
      const cached = resultCache.get(cacheKey);
      throwIfAborted(input.signal);
      const execution = cached
        ? {
            ...cached,
            request: {
              ...cached.request,
              tool_call_id: call.tool_call_id,
              name: call.name,
            },
            audit: { ...cached.audit, cache_hit: true },
          }
        : await this.executeTool(call, {
            conversation_id: input.conversation_id,
            source_generation: sourceGeneration,
            signal: input.signal,
          });
      throwIfAborted(input.signal);
      if (
        execution.request.tool_call_id !== call.tool_call_id ||
        execution.request.name !== call.name ||
        execution.request.version !== 1
      ) {
        throw protocolError(
          "Tool resultのname、call ID、versionが要求内容と一致しません。",
        );
      }
      if (!cached) resultCache.set(cacheKey, execution);
      calls.push({
        tool_call_id: call.tool_call_id,
        name: call.name,
        arguments: validation.arguments,
        audit: execution.audit,
      });
      this.onEvent?.({
        phase: "resuming",
        tool_call_id: call.tool_call_id,
        tool_name: call.name,
      });
      throwIfAborted(input.signal);
      if (this.api.submitChatToolResultWithReceipt) {
        const resumed = await this.api.submitChatToolResultWithReceipt(
          runId,
          execution.request,
          input.signal,
        );
        throwIfAborted(input.signal);
        if (
          resumed.response.status === "tool_required" &&
          resumed.response.run_id !== runId
        ) {
          throw protocolError("Chat run IDが継続応答で変更されました。");
        }
        response = resumed.response;
        receipts.push({
          tool_call_id: call.tool_call_id,
          evidence_id: resumed.evidence_id,
        });
      } else {
        response = await this.api.submitChatToolResult(
          runId,
          execution.request,
          input.signal,
        );
        throwIfAborted(input.signal);
        if (response.status === "tool_required" && response.run_id !== runId) {
          throw protocolError("Chat run IDが継続応答で変更されました。");
        }
        receipts.push({ tool_call_id: call.tool_call_id, evidence_id: null });
      }
    }
    throwIfAborted(input.signal);
    if (response.status !== "completed") {
      throw new ChatRunnerError(
        "tool_limit_exceeded",
        "Chat実行が完了しませんでした。",
      );
    }
    this.onEvent?.({ phase: "completed", status: "completed" });
    throwIfAborted(input.signal);
    return {
      response,
      client_tools: clientTools,
      calls,
      receipts,
      capabilities,
    };
  }

  private async readCapabilities(
    requireLiveScombz = false,
    signal?: AbortSignal,
  ): Promise<ChatCapabilities | null> {
    if (!this.api.chatCapabilities) {
      throw new ChatRunnerError(
        "capability_unavailable",
        "AgentのChat capabilitiesを確認できません。",
      );
    }
    try {
      throwIfAborted(signal);
      const capabilities = await this.api.chatCapabilities(signal);
      throwIfAborted(signal);
      if (
        requireLiveScombz &&
        (capabilities.agent_backend !== "azure_openai" ||
          capabilities.observability !== "off")
      ) {
        throw new ChatRunnerError(
          "capability_unavailable",
          "監査対象のAzure read-only capabilityが有効ではありません。",
        );
      }
      return capabilities;
    } catch (error) {
      if (signal?.aborted) throwIfAborted(signal);
      if (isAbortError(error)) throw error;
      if (error instanceof ChatRunnerError) throw error;
      throw new ChatRunnerError(
        "capability_unavailable",
        "AgentのChat capabilitiesを確認できません。",
      );
    }
  }
}
