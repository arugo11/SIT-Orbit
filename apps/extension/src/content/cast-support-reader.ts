/**
 * Reader for the two CAST-linked Notion pages that are part of the career
 * source runtime.  This file is bundled separately and injected only into a
 * temporary, inactive tab.  It deliberately returns visible metadata only;
 * links, meeting identifiers, staff names, and page internals never cross the
 * runtime message boundary.
 */

export const CAST_SUPPORT_INTERNAL_MESSAGE = "orbit-cast-support-read" as const;

export type CastSupportPageKind = "recording" | "career_event";

export const CAST_NOTION_RECORDING_URL =
  "https://shibaura-it.notion.site/33d80feff3d180ea9378d51ef787c19d";
export const CAST_NOTION_EVENT_URL =
  "https://shibaura-it.notion.site/4dcc08138b9044b69d0734e3e4534faf";

const PAGE_URLS: Readonly<Record<CastSupportPageKind, string>> = {
  recording: CAST_NOTION_RECORDING_URL,
  career_event: CAST_NOTION_EVENT_URL,
};

export interface CastSupportPageItem {
  title: string;
  date: string | null;
  target: string | null;
  summary: string | null;
}

export interface CastSupportPageSnapshot {
  schema_version: "v1";
  status: "known";
  kind: CastSupportPageKind;
  source_url: string;
  items: CastSupportPageItem[];
}

export type CastSupportPageReadResult =
  | CastSupportPageSnapshot
  | { status: "reauth_required" | "unavailable"; reason_code: string };

function compact(value: string | null | undefined, limit = 600): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

function normalizeRoot(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.origin !== "https://shibaura-it.notion.site") return null;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

export function isCastSupportPageUrl(
  value: string | null | undefined,
  kind?: CastSupportPageKind,
): value is string {
  if (!value) return false;
  const normalized = normalizeRoot(value);
  if (!normalized) return false;
  if (!kind) return Object.values(PAGE_URLS).includes(normalized);
  return normalized === PAGE_URLS[kind];
}

function visibleText(element: Element | null | undefined): string {
  if (!element) return "";
  const clone = element.cloneNode(true) as Element;
  clone
    .querySelectorAll(
      "script,style,noscript,template,[hidden],[aria-hidden='true'],input,textarea,select,button,svg,a",
    )
    .forEach((node) => {
      node.remove();
    });
  return compact(clone.textContent, 20000);
}

function safeDate(value: string): string | null {
  const match = value.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/u);
  if (!match) return null;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    return null;
  }
  return `${match[1]}-${match[2]?.padStart(2, "0")}-${match[3]?.padStart(2, "0")}`;
}

function itemFromElement(element: Element): CastSupportPageItem | null {
  const text = visibleText(element);
  if (!text || text.length < 3) return null;
  const heading = compact(
    element.querySelector("h1,h2,h3,h4,[role='heading']")?.textContent,
    240,
  );
  const title = heading || text.slice(0, 240);
  const date = safeDate(text);
  const targetMatch = text.match(
    /(?:対象|対象者|学年|学部)[：:]?\s*([^|｜。]{1,120})/u,
  );
  const target = compact(
    targetMatch?.[1]?.split(/概要|Zoom|Meeting/iu)[0],
    120,
  );
  const summary =
    compact(
      text
        .replace(title, "")
        .replace(/20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/gu, "")
        .replace(/(?:対象|対象者|学年|学部)[：:]?\s*[^|｜。]{1,120}/u, "")
        .trim(),
      500,
    ) || null;
  return {
    title,
    date,
    target: target || null,
    summary,
  };
}

function pageItems(document: Document): CastSupportPageItem[] {
  const candidates = Array.from(
    document.querySelectorAll(
      "article,main section,[data-block-id],.notion-list-item,.notion-collection_view-block",
    ),
  );
  const source = candidates.length > 0 ? candidates : [document.body];
  const seen = new Set<string>();
  return source
    .map(itemFromElement)
    .filter((item): item is CastSupportPageItem => item !== null)
    .filter((item) => {
      const key = `${item.title}|${item.date ?? ""}|${item.target ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 200);
}

export function extractCastSupportPage(
  document: Document,
  pageUrl: string,
  kind: CastSupportPageKind,
): CastSupportPageReadResult {
  if (!isCastSupportPageUrl(pageUrl, kind)) {
    return { status: "unavailable", reason_code: "support_unexpected_url" };
  }
  if (document.querySelector('input[type="password"]')) {
    return { status: "reauth_required", reason_code: "support_login_required" };
  }
  const text = visibleText(document.body);
  if (
    !text ||
    /ページが見つかりません|404|System Error|Error loading/u.test(text)
  ) {
    return { status: "unavailable", reason_code: "support_page_unavailable" };
  }
  const items = pageItems(document);
  if (items.length === 0) {
    return { status: "unavailable", reason_code: "support_structure_changed" };
  }
  return {
    schema_version: "v1",
    status: "known",
    kind,
    source_url: PAGE_URLS[kind],
    items,
  };
}

// This listener is intentionally tiny.  It is only active in the temporary
// tab created by the service worker and is never registered on arbitrary web
// pages through the manifest content-script list.
if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (
      !message ||
      typeof message !== "object" ||
      (message as { type?: unknown }).type !== CAST_SUPPORT_INTERNAL_MESSAGE
    ) {
      return;
    }
    const kind = (message as { kind?: unknown }).kind;
    if (kind !== "recording" && kind !== "career_event") {
      sendResponse({ status: "unavailable", reason_code: "invalid_kind" });
      return;
    }
    sendResponse(extractCastSupportPage(document, window.location.href, kind));
  });
}
