import type {
  ChatCapabilities,
  ChatContextManifest,
  ChatHistoryMessage,
  ChatToolResultRequest,
} from "../api/client";
import {
  ChatRunner,
  type ChatRunnerApi,
  type ChatRunnerEvent,
  type ChatToolExecution,
  type ChatToolExecutor,
} from "../chat/chat-runner";
import { ConversationPseudonymizationGateway } from "../privacy/conversation-pseudonymization";
import {
  AUDIT_BRIDGE_KEEPALIVE_MS,
  AUDIT_BRIDGE_MAX_FRAME_BYTES,
  AUDIT_BRIDGE_PROTOCOL_VERSION,
  type AuditBridgeFrame,
  type AuditCommand,
  auditFrameByteLength,
  isAuditCommand,
  isAuditConversationId,
  isAuditRequestId,
  isSequence,
  sanitizeAuditValue,
} from "./audit-bridge-protocol";

export interface AuditSourceDescriptor {
  source_ref: string;
  connector: "scombz" | "syllabus" | "cast" | "moodle" | "library" | "other";
  page_kind: string;
  authenticated: boolean;
  title?: string;
}

export interface AuditBridgeDependencies {
  api: ChatRunnerApi;
  health?: () => Promise<boolean>;
  build_version?: string;
  list_sources: () => Promise<AuditSourceDescriptor[]>;
  bind_source: (
    conversationId: string,
    sourceRef: string,
  ) => Promise<
    { ok: true } | { ok: false; status: string; reason_code: string }
  >;
  source_tools: (source: AuditSourceDescriptor) => ReadonlySet<string>;
  execute_tool: ChatToolExecutor;
  /** Invalidate all connector handles owned by one audit conversation. */
  clear_conversation?: (conversationId: string) => Promise<void>;
  has_scombz_consent?: () => Promise<boolean>;
  pseudonymizer?: ConversationPseudonymizationGateway;
  /**
   * The service worker supplies a one-shot reset promise so a worker restart
   * invalidates any IndexedDB alias mapping before the first audit command.
   * A rejected reset fails closed rather than risking reuse of old aliases.
   */
  pseudonymizer_ready?: Promise<void>;
}

export interface AuditBridgeOptions {
  port: number;
  secret: string;
  dependencies: AuditBridgeDependencies;
  webSocketFactory?: (url: string) => WebSocket;
  now?: () => number;
}

export interface AuditBridgeController {
  stop(): void;
  connected(): boolean;
}

const AUDIT_CONVERSATION_TTL_MS = 30 * 60 * 1000;

interface AuditConversationState {
  source_ref: string;
  provider_history: ChatHistoryMessage[];
  /**
   * The server-issued, already-minimized manifest from the previous turn.
   * Keeping it here lets a follow-up cite the same source without sending raw
   * tool output back through the localhost bridge.  It is never persisted.
   */
  context_manifest: ChatContextManifest | null;
  turn_count: number;
  last_used_at: number;
}

interface SocketLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  send(data: string): void;
  close(): void;
}

const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;

interface AuditPresentationAliases {
  conversation: Map<string, string>;
  toolCall: Map<string, string>;
  evidence: Map<string, string>;
}

function auditAlias(
  prefix: "conversation" | "tool-call" | "evidence",
  map: Map<string, string>,
  value: string,
): string {
  const existing = map.get(value);
  if (existing) return existing;
  const alias = `audit-${prefix}-${map.size + 1}`;
  map.set(value, alias);
  return alias;
}

/**
 * Convert correlation identifiers to audit-local names before the payload
 * reaches the CLI. The extension still uses the real IDs internally for the
 * API receipt, while the report process only sees deterministic aliases.
 */
function aliasAuditPresentation(
  value: unknown,
  aliases: AuditPresentationAliases,
  key = "",
  depth = 0,
): unknown {
  if (depth > 8) return "[深さ制限]";
  if (typeof value === "string") {
    if (key === "conversation_id") {
      return auditAlias("conversation", aliases.conversation, value);
    }
    if (key === "tool_call_id") {
      return auditAlias("tool-call", aliases.toolCall, value);
    }
    if (key === "evidence_id") {
      return auditAlias("evidence", aliases.evidence, value);
    }
    return value;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 250)
      .map((item) => aliasAuditPresentation(item, aliases, key, depth + 1));
  }
  if (typeof value !== "object") return "[値は省略]";
  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, 250)) {
    if (childKey === "evidence_ids" && Array.isArray(childValue)) {
      output[childKey] = childValue
        .slice(0, 250)
        .map((item) =>
          typeof item === "string"
            ? auditAlias("evidence", aliases.evidence, item)
            : aliasAuditPresentation(item, aliases, childKey, depth + 1),
        );
      continue;
    }
    output[childKey] = aliasAuditPresentation(
      childValue,
      aliases,
      childKey,
      depth + 1,
    );
  }
  return output;
}
/**
 * Keys that are part of a typed read-only projection.  Audit traffic must be
 * closed-world: an adapter adding an unreviewed field (for example `html`,
 * `student_id`, or an internal response blob) must not accidentally send it
 * to the provider.  Keep this list in sync with the small projections used by
 * the audit source tools, not with arbitrary DOM fields.
 */
const SAFE_TOOL_KEY_RE =
  /^(?:schema_version|status|route|scope|query|year|faculty|task_count|announcement_count|related_link_count|has_current_course|courses|items|hits|results|links|coverage|section_states|observed_at|reason_code|requested|attempted|succeeded|failed|truncated|next_cursor|course_ref|display_name|academic_year|term|weekday|period|citation_uri|ref|section|title|detail|body|due_at|state|has_pdf|material_ref|material_title|page|quote|syllabus_ref|url|course_code|snippet|instructors|objectives|weekly_plan|evaluation|textbooks|prerequisites|text|label|data_classification|profile_count|profiles|alias|role|company|technical_domains|job_types|location_area|graduation_year_bucket|evidence_id|topic_categories|availability_frequencies|meeting_modes|shareable_insight_categories|contact_present|discovered_link_count)$/u;
const PRIVATE_KEY_RE =
  /(?:cookie|csrf|authorization|access[_-]?token|refresh[_-]?token|idnumber|objectname|resource[_-]?id|raw|html|dom|inner[_-]?html|text[_-]?content|pdf(?:[_-]?(?:bytes|content|data|base64))?|ocr[_-]?(?:image|data)|page[_-]?image|blob|full[_-]?text)/iu;
const RAW_CONTENT_VALUE_RE =
  /(?:<\s*(?:html|head|body|script|style|form|input|iframe|svg)\b|%PDF-\d|data:application\/pdf|JVBERi0[0-9A-Za-z+/=]*)/iu;

const DIRECT_IDENTIFIER_RE =
  /(?:\b20\d{2,}[A-Z]{1,8}\d{5,}\b|\b[A-Z]{1,5}[-_ ]?\d{5,}\b|\b(?:\+81|0)[-\d() ]{8,}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/iu;
const SENSITIVE_QUERY_VALUE_RE =
  /([?&](?:token|access_token|refresh_token|csrf|session|idnumber|resource(?:_id|id)?|objectname|key)=)[^\s&#)]+/giu;

function base64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
}

function randomNonce(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(24)));
}

function safeError(error: unknown): string {
  if (error instanceof Error && error.name === "ChatRunnerError") {
    return error.message.slice(0, 240);
  }
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : null;
  if (status === 401 || status === 403) return "認証が必要です。";
  return "監査用Chatを実行できませんでした。";
}

function errorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function scrubProviderValue(
  value: unknown,
  depth = 0,
  fieldName = "",
): unknown {
  if (depth > 8) return null;
  if (typeof value === "string") {
    if (RAW_CONTENT_VALUE_RE.test(value)) return "[内容は省略]";
    return value
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[連絡先は省略]")
      .replace(/(?:\+81|0)[-\d() ]{8,}/gu, "[連絡先は省略]")
      .replace(/\b20\d{2,}[A-Z]{1,8}\d{5,}\b/giu, "[識別子は省略]")
      .replace(/\b[A-Z]{1,5}[-_ ]?\d{5,}\b/giu, "[識別子は省略]")
      .replace(/https?:\/\/[^\s)]+/giu, (match) => {
        try {
          const url = new URL(match);
          url.search = "";
          url.hash = "";
          return url.toString();
        } catch {
          return "[URLは省略]";
        }
      })
      .replace(/orbit-[a-z0-9-]+:\/\/[^\s)]+/giu, (match) => {
        try {
          const url = new URL(match);
          url.search = "";
          url.hash = "";
          return url.toString();
        } catch {
          return "[参照先は省略]";
        }
      })
      .replace(SENSITIVE_QUERY_VALUE_RE, "$1[省略]");
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 250)
      .map((item) => scrubProviderValue(item, depth + 1, fieldName));
  }
  if (typeof value !== "object") return null;

  // `section_states` uses a deliberately dynamic key (`course_ref:title`).
  // Preserve only the finite state enum; never recurse through arbitrary
  // values under those keys.  This keeps coverage useful without opening a
  // path for hidden metadata in a section object.
  if (fieldName === "section_states") {
    const states: Record<string, string> = {};
    for (const [key, state] of Object.entries(value).slice(0, 20)) {
      if (
        typeof state !== "string" ||
        !["complete", "truncated", "failed", "not_requested"].includes(state)
      ) {
        continue;
      }
      const safeKey = key
        .replace(/[?&#]/gu, " ")
        .replace(DIRECT_IDENTIFIER_RE, "[識別子は省略]")
        .trim()
        .slice(0, 200);
      if (safeKey) states[safeKey] = state;
    }
    return states;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 250)) {
    if (PRIVATE_KEY_RE.test(key)) continue;
    // Closed-world projection: unknown fields are omitted even when they do
    // not look sensitive.  This is what prevents a future raw adapter field
    // from becoming provider-visible by accident.
    if (!SAFE_TOOL_KEY_RE.test(key)) continue;
    output[key] = scrubProviderValue(item, depth + 1, key);
  }
  return output;
}

async function scrubToolExecution(
  execution: ChatToolExecution,
  pseudonymizer: ConversationPseudonymizationGateway,
  conversationId: string,
): Promise<ChatToolExecution> {
  const isPersonalProjection =
    execution.request.name === "cast_alumni_read" ||
    execution.request.name.startsWith("scombz_");
  const transformed = isPersonalProjection
    ? await pseudonymizer.transformToolProjection(
        conversationId,
        execution.request.result,
      )
    : { provider_result: execution.request.result };
  const request = {
    ...execution.request,
    result: scrubProviderValue(transformed.provider_result),
  } as ChatToolResultRequest;
  return {
    request,
    audit: execution.audit,
  };
}

function frameFromJson(value: unknown): AuditBridgeFrame | null {
  if (typeof value !== "object" || value === null) return null;
  return value as AuditBridgeFrame;
}

async function readMessageData(data: unknown): Promise<string | null> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (typeof Blob !== "undefined" && data instanceof Blob)
    return await data.text();
  return null;
}

function responseFrame(
  sequence: number,
  requestId: string,
  ok: boolean,
  payload?: unknown,
  error?: string,
): AuditBridgeFrame {
  return {
    type: "response",
    sequence,
    request_id: requestId,
    ok,
    ...(payload === undefined ? {} : { payload: sanitizeAuditValue(payload) }),
    ...(error ? { error: error.slice(0, 240) } : {}),
  };
}

export function startAuditBridge(
  options: AuditBridgeOptions,
): AuditBridgeController {
  const WebSocketCtor =
    options.webSocketFactory ??
    ((url: string) => new globalThis.WebSocket(url));
  const now = options.now ?? Date.now;
  const pseudonymizer =
    options.dependencies.pseudonymizer ??
    new ConversationPseudonymizationGateway();
  const conversations = new Map<string, AuditConversationState>();
  let socket: SocketLike | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  let outboundSequence = 0;
  let inboundSequence = -1;
  let connected = false;
  let nonce = "";
  let challenge = "";
  const presentationAliases: AuditPresentationAliases = {
    conversation: new Map(),
    toolCall: new Map(),
    evidence: new Map(),
  };

  const send = (frame: AuditBridgeFrame): void => {
    if (!socket || socket.readyState !== SOCKET_OPEN) return;
    if (auditFrameByteLength(frame) > AUDIT_BRIDGE_MAX_FRAME_BYTES) {
      socket.close();
      return;
    }
    socket.send(JSON.stringify(frame));
  };

  const sendProgress = (requestId: string, event: ChatRunnerEvent): void => {
    send({
      type: "progress",
      sequence: outboundSequence++,
      request_id: requestId,
      phase: event.phase,
      detail: (event.detail ?? event.status ?? "処理中").slice(0, 240),
    });
  };

  const sources = async (): Promise<AuditSourceDescriptor[]> => {
    const result = await options.dependencies.list_sources();
    return result
      .slice(0, 32)
      .map((item) => sanitizeAuditValue(item) as AuditSourceDescriptor);
  };

  const preflight = async (): Promise<Record<string, unknown>> => {
    let health: boolean | null = null;
    let capabilities: ChatCapabilities | null = null;
    let capabilityError: unknown = null;
    let healthError = false;
    try {
      health = options.dependencies.health
        ? await options.dependencies.health()
        : null;
    } catch {
      healthError = true;
    }
    try {
      if (options.dependencies.api.chatCapabilities) {
        capabilities = await options.dependencies.api.chatCapabilities();
      }
    } catch (error) {
      capabilityError = error;
    }
    const consent = options.dependencies.has_scombz_consent
      ? await options.dependencies.has_scombz_consent().catch(() => false)
      : null;
    const availableSources = await sources().catch(() => []);
    const scombzSources = availableSources.filter(
      (item) => item.connector === "scombz",
    );
    const liveTools = new Set([
      "scombz_course_list",
      "scombz_portal_read",
      "scombz_course_read",
      "scombz_material_search",
    ]);
    const supportedTools = new Set<string>(
      capabilities?.supported_client_tools ?? [],
    );
    const hasLiveTools = Boolean(
      capabilities && [...liveTools].every((tool) => supportedTools.has(tool)),
    );
    let status: "known" | "partial" | "reauth_required" | "unavailable";
    if (capabilityError) {
      const statusCode = errorStatus(capabilityError);
      status =
        statusCode === 401 || statusCode === 403
          ? "reauth_required"
          : "unavailable";
    } else if (
      healthError ||
      health === false ||
      !capabilities ||
      capabilities.agent_backend !== "azure_openai" ||
      capabilities.observability !== "off" ||
      capabilities.scombz_student_read_mode !== "live" ||
      !hasLiveTools ||
      consent === false
    ) {
      status = "unavailable";
    } else if (
      scombzSources.length === 0 ||
      scombzSources.every((item) => !item.authenticated)
    ) {
      status = scombzSources.length === 0 ? "unavailable" : "reauth_required";
    } else {
      status = "known";
    }
    return {
      status,
      build_version: options.dependencies.build_version ?? "audit-v1",
      health,
      consent,
      capabilities: capabilities
        ? {
            agent_backend: capabilities.agent_backend,
            observability: capabilities.observability,
            scombz_student_read_mode: capabilities.scombz_student_read_mode,
            supported_client_tools: capabilities.supported_client_tools,
            max_client_tools: capabilities.max_client_tools,
          }
        : null,
      sources: availableSources,
      observed_at: new Date(now()).toISOString(),
    };
  };

  const runChat = async (
    command: Extract<AuditCommand, { type: "chat" }>,
    requestId: string,
  ): Promise<Record<string, unknown>> => {
    try {
      await options.dependencies.pseudonymizer_ready;
    } catch {
      return {
        status: "unavailable",
        reason_code: "pseudonymizer_unavailable",
      };
    }
    if (!isAuditConversationId(command.conversation_id)) {
      return { status: "unavailable", reason_code: "conversation_id_invalid" };
    }
    const available = await sources();
    const previous = conversations.get(command.conversation_id);
    if (previous && now() - previous.last_used_at > AUDIT_CONVERSATION_TTL_MS) {
      conversations.delete(command.conversation_id);
      await pseudonymizer.clear(command.conversation_id);
      await options.dependencies.clear_conversation?.(command.conversation_id);
      return {
        status: "unavailable",
        reason_code: "conversation_expired",
      };
    }
    const source = command.source_ref
      ? available.find((item) => item.source_ref === command.source_ref)
      : previous
        ? available.find((item) => item.source_ref === previous.source_ref)
        : available.length === 1
          ? available[0]
          : undefined;
    if (!source) {
      return {
        status:
          available.length > 1 ? "source_selection_required" : "unavailable",
        reason_code:
          available.length > 1 ? "source_ref_required" : "source_not_found",
        sources: available,
      };
    }
    if (previous && previous.source_ref !== source.source_ref) {
      return { status: "unavailable", reason_code: "source_changed" };
    }
    if (
      source.connector === "scombz" &&
      options.dependencies.has_scombz_consent &&
      !(await options.dependencies.has_scombz_consent().catch(() => false))
    ) {
      return { status: "unavailable", reason_code: "consent_required" };
    }
    const bound = await options.dependencies.bind_source(
      command.conversation_id,
      source.source_ref,
    );
    if (!bound.ok) return bound;
    await pseudonymizer.begin(command.conversation_id);
    const transformed = await pseudonymizer.transformText(
      command.conversation_id,
      command.message,
    );
    const state: AuditConversationState = previous ?? {
      source_ref: source.source_ref,
      provider_history: [],
      context_manifest: null,
      turn_count: 0,
      last_used_at: now(),
    };
    let providerContextManifest = state.context_manifest;
    if (providerContextManifest) {
      const transformedEvidence = await pseudonymizer.transformEvidence(
        command.conversation_id,
        providerContextManifest.evidence ?? [],
      );
      providerContextManifest = {
        ...providerContextManifest,
        evidence:
          transformedEvidence as typeof providerContextManifest.evidence,
      };
    }
    const runner = new ChatRunner({
      api: options.dependencies.api,
      executeTool: async (call, context) =>
        scrubToolExecution(
          await options.dependencies.execute_tool(call, context),
          pseudonymizer,
          context.conversation_id,
        ),
      onEvent: (event) => sendProgress(requestId, event),
    });
    try {
      const result = await runner.run({
        conversation_id: command.conversation_id,
        message: transformed.provider_content,
        history: state.provider_history,
        context_manifest: providerContextManifest,
        locally_available_tools: options.dependencies.source_tools(source),
        require_live_scombz: source.connector === "scombz",
      });
      const restored = await pseudonymizer.restoreMarkdown(
        command.conversation_id,
        result.response.message.content_markdown,
      );
      const nextHistory: ChatHistoryMessage[] = [
        ...state.provider_history,
        { role: "user" as const, content: transformed.provider_content },
        {
          role: "assistant" as const,
          content: result.response.message.content_markdown,
        },
      ].slice(-20);
      state.provider_history = nextHistory;
      state.context_manifest =
        result.response.context_manifest ?? state.context_manifest;
      state.turn_count += 1;
      state.last_used_at = now();
      conversations.set(command.conversation_id, state);
      return {
        status: "known",
        conversation_id: command.conversation_id,
        source_ref: source.source_ref,
        turn: state.turn_count,
        assistant: restored.content,
        restore_warnings: restored.warnings,
        tool_calls: result.calls,
        receipts: result.receipts,
        evidence: result.response.message.evidence,
        context_manifest: result.response.context_manifest,
        observed_at: new Date(now()).toISOString(),
      };
    } catch (error) {
      return {
        status: "unavailable",
        reason_code: error instanceof Error ? error.name : "chat_failed",
        message: safeError(error),
        source_ref: source.source_ref,
      };
    }
  };

  const handleCommand = async (
    command: AuditCommand,
    requestId: string,
  ): Promise<unknown> => {
    switch (command.type) {
      case "preflight":
        return preflight();
      case "sources":
        return {
          status: "known",
          sources: await sources(),
          observed_at: new Date(now()).toISOString(),
        };
      case "chat":
        return runChat(command, requestId);
      case "clear":
        conversations.delete(command.conversation_id);
        await pseudonymizer.clear(command.conversation_id);
        await options.dependencies.clear_conversation?.(
          command.conversation_id,
        );
        return { status: "known", conversation_id: command.conversation_id };
      case "ping":
        return { status: "known", observed_at: new Date(now()).toISOString() };
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== undefined) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, 2_000);
  };

  const closeSocket = (): void => {
    connected = false;
    if (keepaliveTimer !== undefined) clearInterval(keepaliveTimer);
    keepaliveTimer = undefined;
    if (socket && socket.readyState !== SOCKET_CLOSED) socket.close();
    socket = null;
  };

  const onMessage = async (event: MessageEvent<unknown>): Promise<void> => {
    const raw = await readMessageData(event.data);
    if (
      !raw ||
      new TextEncoder().encode(raw).byteLength > AUDIT_BRIDGE_MAX_FRAME_BYTES
    ) {
      closeSocket();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      closeSocket();
      return;
    }
    const frame = frameFromJson(parsed);
    if (!frame) {
      closeSocket();
      return;
    }
    if (
      frame.type === "challenge" &&
      frame.protocol_version === AUDIT_BRIDGE_PROTOCOL_VERSION
    ) {
      if (!nonce || frame.nonce !== nonce || !frame.challenge) {
        closeSocket();
        return;
      }
      challenge = frame.challenge;
      const proof = await hmac(
        options.secret,
        `${AUDIT_BRIDGE_PROTOCOL_VERSION}|${nonce}|${challenge}|extension`,
      );
      send({
        type: "auth",
        protocol_version: AUDIT_BRIDGE_PROTOCOL_VERSION,
        nonce,
        challenge,
        proof,
      });
      return;
    }
    if (
      frame.type === "ready" &&
      frame.protocol_version === AUDIT_BRIDGE_PROTOCOL_VERSION
    ) {
      const expected = await hmac(
        options.secret,
        `${AUDIT_BRIDGE_PROTOCOL_VERSION}|${nonce}|${challenge}|cli`,
      );
      if (frame.proof !== expected) {
        closeSocket();
        return;
      }
      connected = true;
      keepaliveTimer = setInterval(() => {
        send({ type: "keepalive", sequence: outboundSequence++ });
      }, AUDIT_BRIDGE_KEEPALIVE_MS);
      return;
    }
    if (!connected || frame.type !== "command") {
      closeSocket();
      return;
    }
    if (!isSequence(frame.sequence) || frame.sequence <= inboundSequence) {
      closeSocket();
      return;
    }
    inboundSequence = frame.sequence;
    if (!isAuditCommand(frame.command)) {
      closeSocket();
      return;
    }
    const requestId = frame.command.request_id;
    if (!isAuditRequestId(requestId)) {
      closeSocket();
      return;
    }
    try {
      const payload = await handleCommand(frame.command, requestId);
      send(
        responseFrame(
          outboundSequence++,
          requestId,
          true,
          aliasAuditPresentation(payload, presentationAliases),
        ),
      );
    } catch (error) {
      send(
        responseFrame(
          outboundSequence++,
          requestId,
          false,
          undefined,
          safeError(error),
        ),
      );
    }
  };

  const connect = (): void => {
    if (stopped || socket || !options.secret || options.port <= 0) return;
    nonce = randomNonce();
    challenge = "";
    presentationAliases.conversation.clear();
    presentationAliases.toolCall.clear();
    presentationAliases.evidence.clear();
    outboundSequence = 0;
    inboundSequence = -1;
    try {
      const next = WebSocketCtor(
        `ws://127.0.0.1:${Math.trunc(options.port)}`,
      ) as SocketLike;
      socket = next;
      next.onopen = () => {
        send({
          type: "hello",
          protocol_version: AUDIT_BRIDGE_PROTOCOL_VERSION,
          nonce,
        });
      };
      next.onmessage = (event) => void onMessage(event);
      next.onerror = () => closeSocket();
      next.onclose = () => {
        closeSocket();
        scheduleReconnect();
      };
    } catch {
      socket = null;
      scheduleReconnect();
    }
  };

  connect();
  return {
    stop() {
      stopped = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      closeSocket();
      const conversationIds = [...conversations.keys()];
      conversations.clear();
      void Promise.all(
        conversationIds.map((conversationId) =>
          options.dependencies.clear_conversation?.(conversationId),
        ),
      )
        .catch(() => undefined)
        .finally(() => {
          void pseudonymizer.clearAll();
        });
    },
    connected: () => connected,
  };
}
