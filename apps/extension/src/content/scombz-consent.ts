/** One-session consent for sending minimized SCombZ/PDF projections to Azure. */
export const SCOMBZ_STUDENT_SESSION_CONSENT_KEY =
  "sit-orbit-scombz-student-session-consent";

function available(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.storage?.session?.get === "function" &&
    typeof chrome.storage?.session?.set === "function"
  );
}

export async function hasScombzStudentSessionConsent(): Promise<boolean> {
  if (!available()) return false;
  try {
    const stored = await chrome.storage.session.get(
      SCOMBZ_STUDENT_SESSION_CONSENT_KEY,
    );
    const value = stored[SCOMBZ_STUDENT_SESSION_CONSENT_KEY];
    return (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { granted_at?: unknown }).granted_at === "string"
    );
  } catch {
    return false;
  }
}

export async function grantScombzStudentSessionConsent(): Promise<boolean> {
  if (!available()) return false;
  try {
    await chrome.storage.session.set({
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
    typeof chrome.storage?.session?.remove !== "function"
  )
    return;
  try {
    await chrome.storage.session.remove(SCOMBZ_STUDENT_SESSION_CONSENT_KEY);
  } catch {
    // Session teardown also clears the value; removal is best effort.
  }
}
