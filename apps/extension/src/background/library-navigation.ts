import { LIBRARY_OPAC_ORIGIN } from "../connectors/library-discovery";
import type { OpacDiagnosticRouteKind } from "../connectors/opac-diagnostics";

export const LIBRARY_NAVIGATION_TIMEOUT_MS = 15_000;
export const LIBRARY_NAVIGATION_POLL_MS = 100;

export type LibraryNavigationResult =
  | { status: "ready" }
  | { status: "unavailable"; reason_code: string };

export function sameNavigationUrl(
  left: string | undefined,
  right: string,
): boolean {
  if (!left) return false;
  try {
    const actual = new URL(left);
    const expected = new URL(right);
    return (
      actual.origin === expected.origin &&
      actual.pathname === expected.pathname &&
      actual.search === expected.search &&
      actual.hash === expected.hash
    );
  } catch {
    return false;
  }
}

export function sameSearchNavigationUrl(
  actualUrl: string | undefined,
  expectedUrl: string,
): boolean {
  if (!actualUrl) return false;
  try {
    const actual = new URL(actualUrl);
    const expected = new URL(expectedUrl);
    if (
      actual.origin !== expected.origin ||
      decodeURIComponent(actual.pathname) !==
        decodeURIComponent(expected.pathname) ||
      actual.hash !== expected.hash
    ) {
      return false;
    }
    const entries = (url: URL): string[] =>
      Array.from(url.searchParams.entries())
        .map(([key, value]) => `${key}\u0000${value}`)
        .sort();
    const actualEntries = entries(actual);
    const expectedEntries = entries(expected);
    return (
      actualEntries.length === expectedEntries.length &&
      actualEntries.every((entry, index) => entry === expectedEntries[index])
    );
  } catch {
    return false;
  }
}

export function isCanonicalLibrarySearchRecordRedirect(
  actualUrl: string | undefined,
): boolean {
  if (!actualUrl) return false;
  try {
    const actual = new URL(actualUrl);
    return (
      actual.origin === LIBRARY_OPAC_ORIGIN &&
      /^\/opc\/recordID\/catalog\.bib\/[A-Za-z0-9._-]{1,128}$/u.test(
        actual.pathname,
      ) &&
      actual.searchParams.get("caller") === "xc-search" &&
      Array.from(actual.searchParams.keys()).every(
        (key) => key === "caller" || key === "hit",
      ) &&
      !actual.hash
    );
  } catch {
    return false;
  }
}

export function classifyLibraryNavigationUrl(
  actualUrl: string | undefined,
): OpacDiagnosticRouteKind {
  if (!actualUrl) return "unknown";
  try {
    const url = new URL(actualUrl);
    if (url.origin !== LIBRARY_OPAC_ORIGIN) return "unknown";
    if (url.pathname.startsWith("/opc/xc/search/")) return "search_results";
    if (url.pathname.startsWith("/opc/recordID/catalog.bib/")) {
      return "single_record";
    }
    if (/login|selectLogin/iu.test(url.pathname)) return "login";
    if (/error/iu.test(url.pathname)) return "error";
    if (url.pathname === "/opc/" || url.pathname === "/opc") return "entry";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function isAllowedLibraryNavigationUrl(
  actualUrl: string | undefined,
  expectedUrl: string,
  allowSearchRecordRedirect: boolean,
): boolean {
  return (
    sameNavigationUrl(actualUrl, expectedUrl) ||
    sameSearchNavigationUrl(actualUrl, expectedUrl) ||
    (allowSearchRecordRedirect &&
      isCanonicalLibrarySearchRecordRedirect(actualUrl))
  );
}

export async function waitForLibraryNavigation(
  tabId: number,
  expectedUrl: string,
  timeoutReason: string,
  mismatchReason: string,
  initialUrl?: string,
  allowSearchRecordRedirect = false,
): Promise<LibraryNavigationResult> {
  if (!expectedUrl.startsWith(`${LIBRARY_OPAC_ORIGIN}/`)) {
    return { status: "unavailable", reason_code: "invalid_expected_url" };
  }
  return new Promise<LibraryNavigationResult>((resolve) => {
    let settled = false;
    let navigationObserved = false;
    let baselineUrl = initialUrl;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let pollId: ReturnType<typeof setInterval> | undefined;
    const finish = (result: LibraryNavigationResult): void => {
      if (settled) return;
      settled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (pollId !== undefined) clearInterval(pollId);
      chrome.tabs.onUpdated.removeListener?.(listener);
      resolve(result);
    };
    const inspect = async (updatedTab?: chrome.tabs.Tab): Promise<void> => {
      let tab = updatedTab;
      if (!tab) {
        try {
          tab = await chrome.tabs.get(tabId);
        } catch {
          return;
        }
      }
      const currentUrl = tab.url;
      if (!baselineUrl && currentUrl) {
        baselineUrl = currentUrl;
      } else if (
        baselineUrl &&
        currentUrl &&
        !sameNavigationUrl(currentUrl, baselineUrl)
      ) {
        navigationObserved = true;
      }
      if (
        isAllowedLibraryNavigationUrl(
          currentUrl,
          expectedUrl,
          allowSearchRecordRedirect,
        )
      ) {
        const status = (tab as chrome.tabs.Tab & { status?: string }).status;
        if (status === "complete") finish({ status: "ready" });
        return;
      }
      const status = (tab as chrome.tabs.Tab & { status?: string }).status;
      if (navigationObserved && status === "complete") {
        finish({ status: "unavailable", reason_code: mismatchReason });
      }
    };
    const listener = (
      updatedTabId: number,
      changeInfo: { status?: string; url?: string },
      updatedTab?: chrome.tabs.Tab,
    ): void => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.url) navigationObserved = true;
      void inspect(updatedTab);
    };
    chrome.tabs.onUpdated.addListener(listener);
    pollId = setInterval(() => {
      void inspect();
    }, LIBRARY_NAVIGATION_POLL_MS);
    timeoutId = setTimeout(() => {
      finish({ status: "unavailable", reason_code: timeoutReason });
    }, LIBRARY_NAVIGATION_TIMEOUT_MS);
    void inspect();
  });
}
