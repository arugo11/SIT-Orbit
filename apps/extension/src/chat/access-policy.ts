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
