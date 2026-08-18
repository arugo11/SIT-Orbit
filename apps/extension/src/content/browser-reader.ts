/** Extract only visible, non-form content from an explicitly opened page. */

export interface BrowserReadLink {
  label: string;
  url: string;
}

export interface BrowserReadProjection {
  schema_version: "v1";
  status: "known" | "unavailable";
  url: string;
  title: string;
  text: string;
  links: BrowserReadLink[];
  truncated: boolean;
  data_classification: "public" | "personal";
  reason_code: string | null;
}

const MAX_TEXT_LENGTH = 30_000;
const MAX_LINKS = 50;

function visible(element: Element): boolean {
  if (
    element.hasAttribute("hidden") ||
    element.getAttribute("aria-hidden")?.toLowerCase() === "true"
  ) {
    return false;
  }
  const style = (element as HTMLElement).style;
  return style.display !== "none" && style.visibility !== "hidden";
}

function cleanText(value: string): string {
  return value
    .replaceAll(String.fromCharCode(0), "")
    .replace(/\s+/g, " ")
    .trim();
}

function removeUntrustedInstructionLines(value: string): string {
  return value
    .replace(/ignore (?:all )?previous instructions[^\n]*/giu, "")
    .replace(/system message:[^\n]*/giu, "")
    .replace(/developer message:[^\n]*/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function extractVisibleDocument(
  document: Document,
  url: string,
  dataClassification: "public" | "personal" = "public",
): BrowserReadProjection {
  const clone = document.body?.cloneNode(true) as HTMLElement | null;
  if (!clone) {
    return {
      schema_version: "v1",
      status: "unavailable",
      url,
      title: cleanText(document.title),
      text: "",
      links: [],
      truncated: false,
      data_classification: dataClassification,
      reason_code: "empty_document",
    };
  }

  for (const node of Array.from(
    clone.querySelectorAll(
      "script,style,noscript,template,iframe,object,embed,form,input,select,textarea,button,output,[contenteditable='true'],[role='textbox'],[hidden],[aria-hidden='true']",
    ),
  )) {
    node.remove();
  }

  const text = removeUntrustedInstructionLines(
    cleanText(clone.textContent ?? ""),
  );
  const truncated = text.length > MAX_TEXT_LENGTH;
  const links: BrowserReadLink[] = [];
  const seen = new Set<string>();
  for (const anchor of Array.from(clone.querySelectorAll("a[href]"))) {
    if (!visible(anchor)) continue;
    const href = anchor.getAttribute("href");
    if (!href) continue;
    let absolute: URL;
    try {
      absolute = new URL(href, url);
    } catch {
      continue;
    }
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
      continue;
    }
    const label = cleanText(anchor.textContent ?? "");
    if (!label) continue;
    const key = `${absolute.href}\u0000${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      label: label.slice(0, 300),
      url: absolute.href.slice(0, 500),
    });
    if (links.length >= MAX_LINKS) break;
  }

  return {
    schema_version: "v1",
    status: "known",
    url,
    title: cleanText(document.title).slice(0, 300),
    text: text.slice(0, MAX_TEXT_LENGTH),
    links,
    truncated,
    data_classification: dataClassification,
    reason_code: null,
  };
}

function runtimeListener(): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (
      typeof message !== "object" ||
      message === null ||
      (message as { type?: unknown }).type !== "orbit-extract-browser-document"
    ) {
      return;
    }
    const classification =
      (message as { data_classification?: unknown }).data_classification ===
      "personal"
        ? "personal"
        : "public";
    sendResponse(
      extractVisibleDocument(document, window.location.href, classification),
    );
  });
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  runtimeListener();
}
