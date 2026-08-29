/**
 * Wire contract for the optional, local-only live audit bridge.
 *
 * This module deliberately contains no browser or Node networking code.  It
 * is shared by the extension service worker and the CLI so framing, redaction
 * and command validation cannot drift between the two sides.
 */

export const AUDIT_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const AUDIT_BRIDGE_MAX_FRAME_BYTES = 256 * 1024;
export const AUDIT_BRIDGE_KEEPALIVE_MS = 15_000;

export type AuditCommand =
  | {
      type: "preflight";
      request_id: string;
    }
  | {
      type: "sources";
      request_id: string;
    }
  | {
      type: "chat";
      request_id: string;
      conversation_id: string;
      message: string;
      source_ref?: string | null;
    }
  | {
      type: "clear";
      request_id: string;
      conversation_id: string;
    }
  | {
      type: "ping";
      request_id: string;
    };

export type AuditBridgeFrame =
  | {
      type: "hello";
      protocol_version: typeof AUDIT_BRIDGE_PROTOCOL_VERSION;
      nonce: string;
    }
  | {
      type: "challenge";
      protocol_version: typeof AUDIT_BRIDGE_PROTOCOL_VERSION;
      nonce: string;
      challenge: string;
    }
  | {
      type: "auth";
      protocol_version: typeof AUDIT_BRIDGE_PROTOCOL_VERSION;
      nonce: string;
      challenge: string;
      proof: string;
    }
  | {
      type: "ready";
      protocol_version: typeof AUDIT_BRIDGE_PROTOCOL_VERSION;
      proof: string;
    }
  | {
      type: "command";
      sequence: number;
      command: AuditCommand;
    }
  | {
      type: "response";
      sequence: number;
      request_id: string;
      ok: boolean;
      payload?: unknown;
      error?: string;
    }
  | {
      type: "progress";
      sequence: number;
      request_id: string;
      phase: string;
      detail: string;
    }
  | {
      type: "keepalive";
      sequence: number;
    };

const SECRET_KEY_RE =
  /(?:authorization|cookie|csrf|token|secret|password|api[_-]?key|credential|internal[_-]?id|idnumber|objectname|resource[_-]?id)/iu;
const QUERY_KEY_RE =
  /[?&](?:token|access_token|refresh_token|csrf|session|idnumber|resource_id|resourceid|objectname|key)=/iu;
const QUERY_VALUE_RE =
  /([?&](?:token|access_token|refresh_token|csrf|session|idnumber|resource_id|resourceid|objectname|key)=)[^\s&#)]+/giu;
const RAW_CONTENT_KEY_RE =
  /(?:raw|html|dom|inner[_-]?html|text[_-]?content|pdf(?:[_-]?(?:bytes|content|data|base64))?|full[_-]?text|ocr[_-]?(?:image|data)|page[_-]?image|blob|ciphertext|private[_-]?key)/iu;
const RAW_CONTENT_VALUE_RE =
  /(?:<\s*(?:html|head|body|script|style|form|input|iframe|svg)\b|%PDF-\d|data:application\/pdf|JVBERi0[0-9A-Za-z+/=]*)/iu;
const PATH_ONLY_RE = /^(?:https?|orbit-[a-z0-9-]+):\/\/[^\s]+$/iu;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePath(value: string): string | null {
  if (value.startsWith("orbit-")) {
    return /^[a-z0-9-]+:\/\/[A-Za-z0-9._~:/-]{1,260}$/iu.test(value)
      ? value
      : null;
  }
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return null;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Remove values that must never cross the local audit boundary.  The output
 * is intentionally lossy and is suitable for a transcript/report only; it
 * must not be fed back into the extension as a tool result.
 */
export function sanitizeAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[深さ制限]";
  if (typeof value === "string") {
    const truncated = value.length > 12_000;
    const candidate = truncated ? value.slice(0, 12_000) : value;
    // Raw markup and encoded PDF bytes are never audit material. Detect the
    // common magic/markup forms even when an adapter accidentally places them
    // in an otherwise innocuous string field such as `body` or `text`.
    if (RAW_CONTENT_VALUE_RE.test(candidate)) return "[内容は省略]";
    const path = safePath(candidate);
    if (PATH_ONLY_RE.test(candidate)) return path ?? "[URLは省略]";
    const sanitized = candidate
      // A URL can be embedded in a sentence or Markdown rather than occupy
      // the complete field. Strip its query and fragment in that case too;
      // otherwise a temporary SCombZ download URL could survive the audit
      // boundary merely because it had surrounding prose.
      .replace(/(?:https?|orbit-[a-z0-9-]+):\/\/[^\s<>()]+/giu, (match) => {
        try {
          const url = new URL(match);
          if (url.username || url.password) return "[URLは省略]";
          url.search = "";
          url.hash = "";
          return url.toString();
        } catch {
          return "[URLは省略]";
        }
      })
      .replace(QUERY_VALUE_RE, "$1[省略]")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[連絡先は省略]")
      .replace(/(?:\+81|0)[-\d() ]{8,}/gu, "[連絡先は省略]")
      .replace(/\b[A-Z]{1,5}[-_ ]?\d{5,}\b/giu, "[識別子は省略]")
      .replace(/(?:Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, "Bearer [省略]");
    return truncated ? `${sanitized}…[省略]` : sanitized;
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
      .slice(0, 200)
      .map((item) => sanitizeAuditValue(item, depth + 1));
  }
  if (!isPlainObject(value)) return "[値は省略]";
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 200)) {
    if (SECRET_KEY_RE.test(key) || RAW_CONTENT_KEY_RE.test(key)) {
      output[key] = "[省略]";
      continue;
    }
    if (typeof item === "string" && QUERY_KEY_RE.test(item)) {
      output[key] = safePath(item) ?? "[URLは省略]";
      continue;
    }
    output[key] = sanitizeAuditValue(item, depth + 1);
  }
  return output;
}

export function auditFrameByteLength(frame: AuditBridgeFrame): number {
  return new TextEncoder().encode(JSON.stringify(frame)).byteLength;
}

export function isAuditRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,96}$/u.test(value);
}

export function isAuditConversationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,160}$/u.test(value);
}

export function isAuditCommand(value: unknown): value is AuditCommand {
  if (!isPlainObject(value) || !isAuditRequestId(value.request_id)) {
    return false;
  }
  switch (value.type) {
    case "preflight":
    case "sources":
    case "ping":
      return Object.keys(value).every((key) =>
        ["type", "request_id"].includes(key),
      );
    case "clear":
      return (
        Object.keys(value).every((key) =>
          ["type", "request_id", "conversation_id"].includes(key),
        ) && isAuditConversationId(value.conversation_id)
      );
    case "chat":
      return (
        Object.keys(value).every((key) =>
          [
            "type",
            "request_id",
            "conversation_id",
            "message",
            "source_ref",
          ].includes(key),
        ) &&
        isAuditConversationId(value.conversation_id) &&
        typeof value.message === "string" &&
        value.message.trim().length > 0 &&
        value.message.length <= 8_000 &&
        (value.source_ref === undefined ||
          value.source_ref === null ||
          (typeof value.source_ref === "string" &&
            /^orbit-source:\/\/[A-Za-z0-9_-]{16,96}$/u.test(value.source_ref)))
      );
    default:
      return false;
  }
}

export function isSequence(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}
