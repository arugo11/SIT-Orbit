/**
 * My Library's one-session sharing consent.
 *
 * Only the boolean flag is persisted. Titles, raw snapshots, account details,
 * and authentication state never enter chrome.storage.session.
 */
export const MY_LIBRARY_SESSION_CONSENT_KEY =
  "sit-orbit-my-library-session-consent";

function sessionStorageAvailable(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.storage?.session?.get === "function" &&
    typeof chrome.storage?.session?.set === "function"
  );
}

export async function hasMyLibrarySessionConsent(): Promise<boolean> {
  if (!sessionStorageAvailable()) return false;
  try {
    const stored = await chrome.storage.session.get(
      MY_LIBRARY_SESSION_CONSENT_KEY,
    );
    return stored[MY_LIBRARY_SESSION_CONSENT_KEY] === true;
  } catch {
    return false;
  }
}

export async function grantMyLibrarySessionConsent(): Promise<boolean> {
  if (!sessionStorageAvailable()) return false;
  try {
    await chrome.storage.session.set({
      [MY_LIBRARY_SESSION_CONSENT_KEY]: true,
    });
    return true;
  } catch {
    return false;
  }
}

export async function clearMyLibrarySessionConsent(): Promise<void> {
  if (
    typeof chrome === "undefined" ||
    typeof chrome.storage?.session?.remove !== "function"
  ) {
    return;
  }
  try {
    await chrome.storage.session.remove(MY_LIBRARY_SESSION_CONSENT_KEY);
  } catch {
    // Session storage is best-effort; Chrome session teardown also clears it.
  }
}
