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

function available(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.storage?.local?.get === "function" &&
    typeof chrome.storage?.local?.set === "function"
  );
}

export async function hasScombzStudentSessionConsent(): Promise<boolean> {
  if (!available()) return false;
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
  if (!available()) return false;
  try {
    await chrome.storage.local.set({
      [SCOMBZ_STUDENT_SESSION_CONSENT_KEY]: {
        granted_at: new Date().toISOString(),
      },
    });
    return true;
  } catch {
    return false;
  }
}

export async function clearScombzStudentSessionConsent(): Promise<void> {
  if (
    typeof chrome === "undefined" ||
    typeof chrome.storage?.local?.remove !== "function"
  )
    return;
  try {
    await chrome.storage.local.remove(SCOMBZ_STUDENT_SESSION_CONSENT_KEY);
  } catch {
    // Session teardown also clears the value; removal is best effort.
  }
}
