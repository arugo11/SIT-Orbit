export type AccessMode = "ask" | "full";

export interface HostAccessRequest {
  origin: string;
  pattern: string;
  sensitive: boolean;
}

const SENSITIVE_PATH = /(?:grade|score|attendance|absence|成績|出席|評価)/iu;
const BLOCKED_SCHEMES = /^(?:javascript|data|file|chrome|chrome-extension):/iu;

export function hostAccessRequest(value: string): HostAccessRequest | null {
  try {
    const url = new URL(value);
    if (
      BLOCKED_SCHEMES.test(url.protocol) ||
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return {
      origin: url.origin,
      pattern: `${url.origin}/*`,
      sensitive: SENSITIVE_PATH.test(url.pathname),
    };
  } catch {
    return null;
  }
}

export function requiresHostConfirmation(
  mode: AccessMode,
  request: HostAccessRequest,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (request.sensitive) return true;
  if (mode === "full") return false;
  return !allowedOrigins.has(request.origin);
}

export async function containsOriginPermission(
  pattern: string,
): Promise<boolean> {
  if (
    typeof chrome === "undefined" ||
    typeof chrome.permissions?.contains !== "function"
  ) {
    return false;
  }
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

export async function requestOriginPermission(
  pattern: string,
): Promise<boolean> {
  if (
    typeof chrome === "undefined" ||
    typeof chrome.permissions?.request !== "function"
  ) {
    return false;
  }
  try {
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}
