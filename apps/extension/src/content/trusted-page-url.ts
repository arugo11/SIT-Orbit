export interface TrustedPageUrlPolicy {
  origin: string;
  paths: ReadonlySet<string>;
  allowQuery?: boolean;
  allowFragment?: boolean;
}

/**
 * Validate a fixed read-only connector page before any DOM is interpreted.
 * Search connectors with provider-defined query strings must use a separate,
 * explicit policy instead of weakening this default.
 */
export function exactTrustedPagePath(
  value: string | null | undefined,
  policy: TrustedPageUrlPolicy,
): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.origin !== policy.origin ||
      url.username ||
      url.password ||
      (!policy.allowQuery && url.search) ||
      (!policy.allowFragment && url.hash) ||
      !policy.paths.has(url.pathname)
    ) {
      return null;
    }
    return url.pathname;
  } catch {
    return null;
  }
}
