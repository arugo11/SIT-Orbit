/**
 * Persistent, user-revocable consent for sending minimized SCombZ/PDF
 * projections to Azure.  Only the grant timestamp is stored; no account,
 * course, cookie, or access-token data is included.  The historical export
 * name is retained so older callers continue to compile.
 */
export const SCOMBZ_STUDENT_SESSION_CONSENT_KEY =
  "sit-orbit-scombz-student-session-consent";

function isConsentRecord(value: unknown): value is { granted_at: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 1 &&
    typeof candidate.granted_at === "string" &&
    Number.isFinite(Date.parse(candidate.granted_at))
  );
}

function canRead(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.storage?.local?.get === "function"
  );
}

function canGrant(): boolean {
  return canRead() && typeof chrome.storage?.local?.set === "function";
}

function canClear(): boolean {
  return canRead() && typeof chrome.storage?.local?.remove === "function";
}

export async function hasScombzStudentSessionConsent(): Promise<boolean> {
  if (!canRead()) return false;
  try {
    const stored = await chrome.storage.local.get(
      SCOMBZ_STUDENT_SESSION_CONSENT_KEY,
    );
    const value = stored[SCOMBZ_STUDENT_SESSION_CONSENT_KEY];
    return isConsentRecord(value);
  } catch {
    return false;
  }
}

export async function grantScombzStudentSessionConsent(): Promise<boolean> {
  if (!canGrant()) return false;
  try {
    await chrome.storage.local.set({
      [SCOMBZ_STUDENT_SESSION_CONSENT_KEY]: {
        granted_at: new Date().toISOString(),
      },
    });
    return await hasScombzStudentSessionConsent();
  } catch {
    return false;
  }
}

export async function clearScombzStudentSessionConsent(): Promise<boolean> {
  if (!canClear()) return false;
  try {
    await chrome.storage.local.remove(SCOMBZ_STUDENT_SESSION_CONSENT_KEY);
    const stored = await chrome.storage.local.get(
      SCOMBZ_STUDENT_SESSION_CONSENT_KEY,
    );
    return !isConsentRecord(stored[SCOMBZ_STUDENT_SESSION_CONSENT_KEY]);
  } catch {
    return false;
  }
}
