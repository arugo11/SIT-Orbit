import MiniSearch from "minisearch";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageProxy } from "pdfjs-dist/types/src/display/api";
import { createWorker, type Worker } from "tesseract.js";
import type {
  ScombzStudentAction,
  ScombzStudentReadMessage,
  ScombzStudentReadResponse,
} from "../shared/messages";

const ORIGIN = "https://scombz.shibaura-it.ac.jp";
const courseTargets = new Map<string, string>();
const itemTargets = new Map<string, string>();
const handleExpiry = new Map<string, number>();
const handleConversations = new Map<string, string>();
const cursorOffsets = new Map<
  string,
  { conversationId: string; offset: number }
>();
const HANDLE_TTL_MS = 30 * 60 * 1000;
const MAX_FILES = 20;
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_PAGES = 300;
const MAX_HITS = 24;
const MAX_QUOTE_CHARS = 30_000;
export const ADAPTER_VERSION = "scombz-student-v1" as const;
export const CONTENT_SCRIPT_GENERATION =
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const OCR_MIN_CONFIDENCE = 45;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const PHONE_RE = /(?:\+81|0)[-\d() ]{8,}/gu;
const STUDENT_ID_RE =
  /\b(?:20\d{2,}[A-Z]{1,8}\d{5,}|[A-Z]{1,5}[-_ ]?\d{5,})\b/giu;

export interface MaterialBatchBounds {
  start: number;
  end: number;
  truncated: boolean;
}

/**
 * Keep material pagination at the PDF-count boundary rather than treating
 * the first twenty links as the whole collection.  The cursor stores a link
 * offset, so every continuation advances monotonically through the visible
 * links and cannot repeat the same batch forever.
 */
export function materialBatchBounds(
  total: number,
  start: number,
): MaterialBatchBounds {
  if (
    !Number.isInteger(total) ||
    total < 0 ||
    !Number.isInteger(start) ||
    start < 0 ||
    start > total
  ) {
    throw new Error("material_cursor_invalid");
  }
  const end = Math.min(total, start + MAX_FILES);
  return { start, end, truncated: end < total };
}

function sanitizeVisibleText(value: string): string {
  return value
    .replace(EMAIL_RE, "[連絡先は省略]")
    .replace(PHONE_RE, "[連絡先は省略]")
    .replace(STUDENT_ID_RE, "[識別子は省略]")
    .replace(/https?:\/\/[^\s)]+/giu, (match) => {
      try {
        const url = new URL(match);
        // A SCombZ URL in a body is a private navigation target, not useful
        // evidence.  Expose only an opaque citation URI generated below.
        if (url.origin === ORIGIN) return "[URLは省略]";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[URLは省略]";
      }
    });
}

// PDF.js is bundled by the extension rather than loaded from the SCombZ page
// (or a CDN).  Point the worker at an extension-local asset so the content
// script does not fall back to a page-provided global or remote code.
if (
  typeof chrome !== "undefined" &&
  chrome.runtime?.getURL &&
  pdfjsLib.GlobalWorkerOptions
) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    chrome.runtime.getURL("pdf.worker.min.mjs");
}

async function recognizePdfPage(
  page: PDFPageProxy,
): Promise<{ text: string; confidence: number } | null> {
  const viewport = page.getViewport({ scale: 1.5 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d");
  if (!context) return null;
  await page.render({ canvasContext: context, canvas, viewport }).promise;
  const base =
    typeof chrome !== "undefined" && chrome.runtime?.getURL
      ? chrome.runtime.getURL("ocr/")
      : "/ocr/";
  let worker: Worker | null = null;
  try {
    worker = await createWorker("jpn+eng", 1, {
      workerPath: `${base}worker.min.js`,
      corePath: `${base}tesseract-core.wasm.js`,
      langPath: `${base}lang/`,
      cacheMethod: "none",
      workerBlobURL: false,
      gzip: true,
    });
    const result = await worker.recognize(canvas);
    const text = result.data.text.replace(/\s+/gu, " ").trim();
    const confidence = Number(result.data.confidence ?? 0);
    return text && confidence >= OCR_MIN_CONFIDENCE
      ? { text, confidence }
      : null;
  } catch {
    return null;
  } finally {
    await worker?.terminate().catch(() => undefined);
    canvas.width = 1;
    canvas.height = 1;
  }
}

function emptyProjection(
  action: ScombzStudentAction,
  status: "reauth_required" | "unavailable",
  reason_code: string,
): ScombzStudentReadResponse["projection"] {
  const base = {
    schema_version: "v1" as const,
    status,
    coverage: {
      scope: action,
      requested: 0,
      attempted: 0,
      succeeded: 0,
      // No network request was made when the source/handle was already known
      // to be unusable. Keep the coverage arithmetic consistent (attempted >=
      // succeeded + failed) and let reason_code carry the boundary.
      failed: 0,
      truncated: false,
      next_cursor: null,
    },
    observed_at: new Date().toISOString(),
    reason_code,
  };
  if (action === "course_list") return { ...base, courses: [] };
  if (action === "portal_read") return { ...base, items: [] };
  if (action === "course_read")
    return { ...base, items: [], section_states: {} };
  return { ...base, hits: [] };
}

function ref(prefix: string): string {
  const id =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `orbit-scombz://${prefix}/${id.replace(/[^A-Za-z0-9_-]/gu, "")}`;
}

function remember<T>(
  map: Map<string, T>,
  key: string,
  value: T,
  conversationId = "",
): void {
  map.set(key, value);
  handleExpiry.set(key, Date.now() + HANDLE_TTL_MS);
  handleConversations.set(key, conversationId);
}

function resolve<T>(
  map: Map<string, T>,
  key: string,
  conversationId = "",
): T | null {
  if ((handleExpiry.get(key) ?? 0) <= Date.now()) {
    map.delete(key);
    handleExpiry.delete(key);
    handleConversations.delete(key);
    return null;
  }
  const owner = handleConversations.get(key);
  if (owner !== undefined && owner !== conversationId) return null;
  return map.get(key) ?? null;
}

function opaqueCursor(conversationId: string, offset: number): string {
  const value = ref("cursor");
  cursorOffsets.set(value, { conversationId, offset });
  handleExpiry.set(value, Date.now() + HANDLE_TTL_MS);
  return value;
}

function cursorOffset(value: string | null, conversationId: string): number {
  if (!value) return 0;
  const entry = cursorOffsets.get(value);
  if (!entry || entry.conversationId !== conversationId || entry.offset < 0) {
    throw new Error("cursor_invalid");
  }
  if ((handleExpiry.get(value) ?? 0) <= Date.now()) {
    cursorOffsets.delete(value);
    handleExpiry.delete(value);
    throw new Error("cursor_expired");
  }
  return entry.offset;
}

function visible(element: Element): boolean {
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  ) {
    if (
      current.hasAttribute("hidden") ||
      current.getAttribute("aria-hidden") === "true"
    )
      return false;
    const style = current.getAttribute("style") ?? "";
    if (/display\s*:\s*none|visibility\s*:\s*hidden/iu.test(style))
      return false;
    if (
      current.className &&
      /scombz[-_ ]?utilities/iu.test(String(current.className))
    ) {
      return false;
    }
    if (typeof getComputedStyle === "function") {
      const computed = getComputedStyle(current);
      if (computed.display === "none" || computed.visibility === "hidden")
        return false;
    }
  }
  return true;
}

function text(element: Element | null, limit = 6000): string {
  if (!element || !visible(element)) return "";
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const values: string[] = [];
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    if (!parent || !visible(parent)) {
      node = walker.nextNode();
      continue;
    }
    const value = node.nodeValue?.replace(/\s+/gu, " ").trim();
    if (value) values.push(value);
    node = walker.nextNode();
  }
  return sanitizeVisibleText(values.join(" ")).slice(0, limit);
}

function isUnsafeCoursePath(pathname: string): boolean {
  // Course pages are fetched by GET for reading only.  Explicit action/test
  // routes are rejected before the request is sent so a handle cannot be
  // redirected into a write or active-exam surface.
  return /(?:^|\/)(?:answer|answers|attendance|delete|download|edit|exam|examination|file|make|quiz|quizzes|setfiledown|start|submit|test|tests|update|write)(?:\/|$)/iu.test(
    pathname,
  );
}

function isAllowedHtmlQuery(target: URL): boolean {
  const pathname = target.pathname;
  const allowed =
    pathname === "/portal/home"
      ? new Set<string>()
      : pathname === "/lms/timetable"
        ? new Set(["selectDisplayMode", "risyunen", "kikanCd"])
        : new Set(["idnumber"]);
  const seen = new Set<string>();
  for (const [key, value] of target.searchParams.entries()) {
    // Duplicate query keys make it possible to smuggle a second action value
    // past a parser that only reads the first one.  Keep the read contract
    // deterministic and reject suspicious action-shaped values up front.
    if (
      seen.has(key) ||
      !allowed.has(key) ||
      value.length > 240 ||
      /(?:answer|attendance|delete|edit|exam|quiz|start|submit|test|update|write)/iu.test(
        `${key}=${value}`,
      )
    ) {
      return false;
    }
    seen.add(key);
  }
  return true;
}

/**
 * Resolve the read-only course target attached to a visible timetable tile.
 * SCombZ versions differ: some render the course id on the tile itself,
 * while others put the canonical `/lms/course?idnumber=...` link on a child
 * anchor or a data attribute.  Prefer the canonical link and only keep the
 * opaque id in the content-script map; it is never returned to the Agent.
 */
function coursePathFromTile(tile: HTMLElement): string | null {
  const hrefs: string[] = [];
  if (tile instanceof HTMLAnchorElement) {
    const href = tile.getAttribute("href");
    if (href) hrefs.push(href);
  }
  for (const anchor of Array.from(
    tile.querySelectorAll<HTMLAnchorElement>("a[href]"),
  )) {
    const href = anchor.getAttribute("href");
    if (href) hrefs.push(href);
  }
  for (const href of hrefs) {
    try {
      const target = new URL(href, ORIGIN);
      if (
        target.origin === ORIGIN &&
        target.pathname === "/lms/course" &&
        isAllowedHtmlQuery(target)
      ) {
        const idnumber = target.searchParams.get("idnumber");
        if (idnumber) {
          return `${target.pathname}?idnumber=${encodeURIComponent(idnumber)}`;
        }
      }
    } catch {
      // Try the next same-page representation instead of following a link.
    }
  }
  const id =
    tile.id.trim() ||
    tile.dataset.idnumber?.trim() ||
    tile.dataset.courseId?.trim() ||
    tile.getAttribute("data-idnumber")?.trim() ||
    tile.getAttribute("data-course-id")?.trim() ||
    "";
  if (!id || !/^[A-Za-z0-9._~-]{1,200}$/u.test(id)) return null;
  return `/lms/course?idnumber=${encodeURIComponent(id)}`;
}

/**
 * Treat an unresolved test/quiz heading as active by default.  A changed
 * SCombZ DOM may hide the form controls while leaving the question text in a
 * visible detail block; requiring controls here would then leak an in-progress
 * exam.  Only an explicit result/completion marker may make the section
 * readable.  The helper is exported so the boundary can be regression-tested
 * without constructing a full browser document.
 */
export function isInProgressTestTitle(title: string): boolean {
  return (
    /(?:テスト|試験|小テスト|examination|exam|quiz)/iu.test(title) &&
    !/(?:結果|成績|講評|終了|完了|result|score|feedback|review|completed)/iu.test(
      title,
    )
  );
}

function isOwnSubmissionSection(title: string): boolean {
  return /(?:提出内容|提出ファイル|自分の提出|あなたの提出|講評|フィードバック|submission(?:\s+(?:content|file|detail|feedback))?)/iu.test(
    title,
  );
}

async function html(path: string): Promise<Document> {
  const target = new URL(path, ORIGIN);
  if (target.origin !== ORIGIN || !target.pathname.startsWith("/"))
    throw new Error("origin_rejected");
  const allowed =
    target.pathname === "/portal/home" ||
    target.pathname === "/lms/timetable" ||
    target.pathname === "/lms/course" ||
    target.pathname === "/lms/course/material" ||
    (target.pathname.startsWith("/lms/course/") &&
      !isUnsafeCoursePath(target.pathname));
  if (!allowed || !isAllowedHtmlQuery(target))
    throw new Error("path_not_allowlisted");
  const response = await fetch(target.href, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`http_${response.status}`);
  const responseUrl = new URL(response.url || target.href, ORIGIN);
  if (
    responseUrl.origin !== ORIGIN ||
    responseUrl.pathname === "/login" ||
    responseUrl.pathname.startsWith("/login/")
  ) {
    throw new Error("login_required");
  }
  const source = await response.text();
  if (
    /<input\b[^>]*type=["']?password\b/iu.test(source) ||
    /<form\b[^>]*action=["'][^"']*\/login(?:[/?"'])/iu.test(source) ||
    /<title\b[^>]*>[^<]*(?:ログイン|login)[^<]*<\/title>/iu.test(source)
  )
    throw new Error("login_required");
  return new DOMParser().parseFromString(source, "text/html");
}

function isPdfMagic(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const bytes = new Uint8Array(buffer, 0, 4);
  return (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  );
}

function sameOriginReadPath(value: string): string | null {
  try {
    const target = new URL(value, ORIGIN);
    if (
      target.origin !== ORIGIN ||
      !target.pathname.startsWith("/lms/course/material/setfiledown/") ||
      target.username ||
      target.password ||
      target.hash
    ) {
      return null;
    }
    const fileName = target.pathname.slice(
      "/lms/course/material/setfiledown/".length,
    );
    if (!fileName || decodeURIComponent(fileName).includes("/")) return null;
    const allowedQueryKeys = new Set([
      "fileName",
      "fileId",
      "idnumber",
      "resourceId",
      "screen",
      "contentId",
      "endDate",
    ]);
    const seenQueryKeys = new Set<string>();
    for (const key of target.searchParams.keys()) {
      if (seenQueryKeys.has(key) || !allowedQueryKeys.has(key)) return null;
      seenQueryKeys.add(key);
    }
    return `${target.pathname}${target.search}`;
  } catch {
    return null;
  }
}

function courseList(
  doc: Document,
  year: number | null,
  term: string | null,
  conversationId: string,
  query = "",
  cursor: string | null = null,
): unknown {
  const yearOptions = Array.from(
    doc.querySelectorAll<HTMLOptionElement>('select[name="risyunen"] option'),
  ).map((option) => option.value.trim());
  const termOptions = Array.from(
    doc.querySelectorAll<HTMLOptionElement>('select[name="kikanCd"] option'),
  ).map((option) => option.value.trim());
  if (
    year !== null &&
    (!yearOptions.length || !yearOptions.includes(String(year)))
  ) {
    throw new Error("academic_year_not_available");
  }
  if (term !== null && (!termOptions.length || !termOptions.includes(term))) {
    throw new Error("term_not_available");
  }
  // The timetable endpoint may silently fall back to the current term when a
  // requested year/term is no longer valid.  Do not label that response as the
  // requested historical period: the selected option in the returned HTML is
  // the only read-time confirmation that the server honored the choice.
  const selectedYear =
    doc
      .querySelector<HTMLSelectElement>('select[name="risyunen"]')
      ?.value.trim() ?? "";
  const selectedTerm =
    doc
      .querySelector<HTMLSelectElement>('select[name="kikanCd"]')
      ?.value.trim() ?? "";
  if (year !== null && selectedYear !== String(year)) {
    throw new Error("academic_year_not_selected");
  }
  if (term !== null && selectedTerm !== term) {
    throw new Error("term_not_selected");
  }
  const tiles = Array.from(
    doc.querySelectorAll<HTMLElement>(".timetable-course-top-btn"),
  );
  if (
    tiles.length === 0 &&
    !doc.querySelector(
      'select[name="risyunen"], select[name="kikanCd"], #timetable, .timetable, table',
    )
  ) {
    throw new Error("timetable_structure_not_found");
  }
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const candidates = tiles.filter((tile) => {
    if (!visible(tile)) return false;
    const name = text(tile, 300);
    return (
      Boolean(name) &&
      (!normalizedQuery || name.toLocaleLowerCase().includes(normalizedQuery))
    );
  });
  const offset = cursorOffset(cursor, conversationId);
  const selected = candidates.slice(offset, offset + 50);
  const courses: unknown[] = [];
  for (const tile of selected) {
    if (!visible(tile)) continue;
    const coursePath = coursePathFromTile(tile);
    const name = text(tile, 300);
    if (!coursePath || !name) continue;
    const courseRef = ref("course");
    remember(courseTargets, courseRef, coursePath, conversationId);
    courses.push({
      course_ref: courseRef,
      display_name: name,
      academic_year: year,
      term,
      weekday:
        tile.dataset.weekday ??
        tile.getAttribute("data-weekday") ??
        tile.getAttribute("data-day") ??
        null,
      period: tile.dataset.period ?? tile.getAttribute("data-period") ?? null,
      citation_uri: `orbit-scombz://citation/${courseRef.split("/").pop() ?? "course"}`,
    });
  }
  const observed = new Date().toISOString();
  const nextOffset = offset + selected.length;
  const truncated = nextOffset < candidates.length;
  return {
    schema_version: "v1",
    status: truncated ? "partial" : "known",
    courses,
    coverage: {
      scope: "timetable_surface",
      requested: Math.min(candidates.length, 1000),
      attempted: Math.min(nextOffset, 1000),
      succeeded: courses.length,
      failed: 0,
      truncated,
      next_cursor: truncated ? opaqueCursor(conversationId, nextOffset) : null,
    },
    observed_at: observed,
    reason_code: null,
  };
}

function genericItems(
  doc: Document,
  section: string,
  conversationId: string,
  requestedSections: string[] = [],
  query = "",
): unknown[] {
  const selectors: Array<[string, string]> = [
    ["tasks", "#taskList > li > a"],
    ["announcements", "#informationList > li > a"],
    ["links", ".contents-detail > li > a"],
    ["announcements", ".block-title"],
  ];
  const items: unknown[] = [];
  for (const [itemSection, selector] of selectors) {
    if (
      requestedSections.length > 0 &&
      !requestedSections.some(
        (value) => value === itemSection || value === section,
      )
    )
      continue;
    for (const element of Array.from(doc.querySelectorAll(selector))) {
      const title = text(element, 300);
      if (!title) continue;
      if (
        query &&
        !title.toLocaleLowerCase().includes(query.toLocaleLowerCase())
      )
        continue;
      const itemRef = ref("item");
      const href =
        element instanceof HTMLAnchorElement
          ? element.getAttribute("href")
          : null;
      if (href) {
        try {
          const target = new URL(href, ORIGIN);
          if (target.origin === ORIGIN) {
            remember(
              itemTargets,
              itemRef,
              `${target.pathname}${target.search}`,
              conversationId,
            );
          }
        } catch {
          // A malformed or external href is not a readable item target.
        }
      }
      items.push({
        ref: itemRef,
        section: itemSection,
        title,
        detail: null,
        observed_at: new Date().toISOString(),
        citation_uri: `orbit-scombz://citation/${itemRef.split("/").pop() ?? "item"}`,
      });
      if (items.length >= 1000) return items;
    }
  }
  return items;
}

async function materialSearch(
  courseRef: string,
  query: string,
  cursor: string | null,
  conversationId: string,
): Promise<unknown> {
  const path = resolve(courseTargets, courseRef, conversationId);
  if (!path)
    return {
      schema_version: "v1",
      status: "unavailable",
      hits: [],
      coverage: {
        scope: "materials",
        requested: 0,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        truncated: false,
        next_cursor: null,
      },
      observed_at: new Date().toISOString(),
      reason_code: "course_ref_expired",
    };
  const doc = await html(path);
  const links = Array.from(
    doc.querySelectorAll<HTMLElement>(".fileDownload, a[href$='.pdf' i]"),
  ).filter(visible);
  if (
    links.length === 0 &&
    !doc.querySelector("#courseTopForm, .contents-detail, .block-title")
  ) {
    throw new Error("material_structure_not_found");
  }
  const hits: unknown[] = [];
  let bytes = 0;
  let pages = 0;
  let ocrNeeded = false;
  const searchIndex = new MiniSearch({
    fields: ["body"],
    storeFields: ["body", "page"],
    processTerm: (value) => value.toLocaleLowerCase(),
  });
  const start = cursorOffset(cursor, conversationId);
  const batch = materialBatchBounds(links.length, start);
  let activePdf: Awaited<
    ReturnType<typeof pdfjsLib.getDocument>["promise"]
  > | null = null;
  let attemptedFiles = 0;
  let succeededFiles = 0;
  let failedFiles = 0;
  const destroyActivePdf = async (): Promise<void> => {
    const pdf = activePdf;
    activePdf = null;
    await pdf?.destroy().catch(() => undefined);
  };
  try {
    for (let index = batch.start; index < batch.end; index += 1) {
      attemptedFiles += 1;
      const link = links[index];
      if (!link) {
        failedFiles += 1;
        continue;
      }
      let href =
        link instanceof HTMLAnchorElement
          ? link.href
          : link.getAttribute("data-url");
      if (!href) {
        const parent = link.parentElement;
        if (!parent || !visible(parent)) {
          failedFiles += 1;
          continue;
        }
        const fileName = parent
          ?.querySelector(".fileName")
          ?.textContent?.trim();
        const objectName = parent
          ?.querySelector(".objectName")
          ?.textContent?.trim();
        const resourceId = parent
          ?.querySelector(".resource_Id")
          ?.textContent?.trim();
        const materialId = (
          parent?.querySelector("#dlMaterialId") as HTMLInputElement | null
        )?.value;
        const endDate = parent
          ?.querySelector(".openEndDate")
          ?.textContent?.trim();
        const idnumber = new URL(path, ORIGIN).searchParams.get("idnumber");
        if (fileName && objectName && resourceId && idnumber) {
          const tempfileParams = new URLSearchParams({
            fileName,
            objectName,
            id: resourceId,
            idnumber,
          });
          const tempfile = await fetch(
            `${ORIGIN}/lms/course/make/tempfile?${tempfileParams}`,
            { credentials: "same-origin" },
          );
          if (tempfile.ok) {
            const fileId = (await tempfile.text()).trim();
            if (/^[A-Za-z0-9._-]{1,200}$/u.test(fileId)) {
              const finalParams = new URLSearchParams({
                fileName,
                fileId,
                idnumber,
                resourceId,
                screen: "1",
                contentId: materialId ?? "",
                endDate: endDate ?? "",
              });
              href = `${ORIGIN}/lms/course/material/setfiledown/${encodeURIComponent(fileName.replace(/\s+/gu, "_"))}?${finalParams}`;
            }
          }
        }
      }
      const safePath = href ? sameOriginReadPath(href) : null;
      if (!safePath) {
        failedFiles += 1;
        continue;
      }
      let response: Response;
      try {
        response = await fetch(`${ORIGIN}${safePath}`, {
          credentials: "same-origin",
        });
      } catch {
        failedFiles += 1;
        continue;
      }
      const type = response.headers.get("content-type") ?? "";
      const advertisedLength = Number(
        response.headers.get("content-length") ?? "",
      );
      if (
        Number.isFinite(advertisedLength) &&
        advertisedLength > MAX_BYTES - bytes
      ) {
        return {
          schema_version: "v1",
          status: "partial",
          hits,
          coverage: {
            scope: "materials",
            requested: Math.min(links.length, 1000),
            attempted: attemptedFiles,
            succeeded: succeededFiles,
            failed: failedFiles,
            truncated: true,
            // Skip the file that exhausted the byte budget. Reusing its
            // offset would make every continuation hit the same limit again.
            next_cursor: opaqueCursor(conversationId, index + 1),
          },
          observed_at: new Date().toISOString(),
          reason_code: "pdf_limit_exceeded",
        };
      }
      const buffer = await response.arrayBuffer();
      // A PDF content type is not sufficient: an HTML login page can be
      // mislabeled by the two-step download endpoint. Require the magic bytes
      // before handing data to PDF.js, while accepting octet-stream responses
      // from the official downloader.
      if (
        !isPdfMagic(buffer) ||
        !/(?:application\/pdf|application\/octet-stream)/iu.test(type)
      ) {
        failedFiles += 1;
        continue;
      }
      bytes += buffer.byteLength;
      if (bytes > MAX_BYTES)
        return {
          schema_version: "v1",
          status: "partial",
          hits,
          coverage: {
            scope: "materials",
            requested: Math.min(links.length, 1000),
            attempted: attemptedFiles,
            succeeded: succeededFiles,
            failed: failedFiles,
            truncated: true,
            next_cursor: opaqueCursor(conversationId, index + 1),
          },
          observed_at: new Date().toISOString(),
          reason_code: "pdf_limit_exceeded",
        };
      let pdf: Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;
      try {
        pdf = await pdfjsLib.getDocument({
          data: buffer,
          isEvalSupported: false,
          disableJavaScript: true,
          enableXfa: false,
          useSystemFonts: false,
          stopAtErrors: true,
          disableFontFace: true,
        } as never).promise;
        activePdf = pdf;
      } catch {
        failedFiles += 1;
        continue;
      }
      if (pages + pdf.numPages > MAX_PAGES) {
        await destroyActivePdf();
        return {
          schema_version: "v1",
          status: "partial",
          hits,
          coverage: {
            scope: "materials",
            requested: Math.min(links.length, 1000),
            attempted: attemptedFiles,
            succeeded: succeededFiles,
            failed: failedFiles,
            truncated: true,
            // This PDF would exceed the page budget even though it parsed
            // successfully; advance past it so the cursor is monotonic.
            next_cursor: opaqueCursor(conversationId, index + 1),
          },
          observed_at: new Date().toISOString(),
          reason_code: "pdf_limit_exceeded",
        };
      }
      succeededFiles += 1;
      pages += pdf.numPages;
      for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
        const page = await pdf.getPage(pageNo);
        const content = await page.getTextContent();
        let body = sanitizeVisibleText(
          content.items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" ")
            .replace(/\s+/gu, " ")
            .trim(),
        );
        if (!body) {
          const ocr = await recognizePdfPage(page);
          if (ocr) body = sanitizeVisibleText(ocr.text);
          else {
            ocrNeeded = true;
            await page.cleanup?.();
            continue;
          }
        }
        await page.cleanup?.();
        const documentId = `${index}-${pageNo}`;
        searchIndex.add({ id: documentId, body, page: pageNo });
        if (
          query &&
          !searchIndex
            .search(query, { prefix: true })
            .some((item) => item.id === documentId)
        )
          continue;
        const usedQuoteChars = hits.reduce<number>(
          (total, item) =>
            total +
            (typeof item === "object" && item !== null && "quote" in item
              ? String((item as { quote: unknown }).quote).length
              : 0),
          0,
        );
        const remaining = MAX_QUOTE_CHARS - usedQuoteChars;
        if (remaining <= 0) {
          await destroyActivePdf();
          return {
            schema_version: "v1",
            status: "partial",
            hits,
            coverage: {
              scope: "materials",
              requested: Math.min(links.length, 1000),
              attempted: attemptedFiles,
              succeeded: succeededFiles,
              failed: failedFiles,
              truncated: true,
              next_cursor: opaqueCursor(conversationId, index + 1),
            },
            observed_at: new Date().toISOString(),
            reason_code: "quote_limit_exceeded",
          };
        }
        hits.push({
          material_ref: ref("material"),
          course_ref: courseRef,
          material_title: text(link, 300) || "教材PDF",
          page: pageNo,
          quote: body.slice(0, Math.min(1800, remaining)),
          observed_at: new Date().toISOString(),
          citation_uri: `orbit-scombz://citation/${courseRef.split("/").pop() ?? "material"}-p${pageNo}`,
        });
        if (hits.length >= MAX_HITS) {
          await destroyActivePdf();
          const hitTruncated = index + 1 < batch.end || batch.truncated;
          return {
            schema_version: "v1",
            status: hitTruncated || failedFiles > 0 ? "partial" : "known",
            hits,
            coverage: {
              scope: "materials",
              requested: Math.min(links.length, 1000),
              attempted: attemptedFiles,
              succeeded: succeededFiles,
              failed: failedFiles,
              truncated: hitTruncated,
              next_cursor: hitTruncated
                ? opaqueCursor(conversationId, index + 1)
                : null,
            },
            observed_at: new Date().toISOString(),
            reason_code: hitTruncated
              ? "result_limit_exceeded"
              : failedFiles > 0
                ? "material_read_partial"
                : null,
          };
        }
      }
      await destroyActivePdf();
    }
  } finally {
    await destroyActivePdf();
  }
  const truncated = batch.truncated;
  return {
    schema_version: "v1",
    status: truncated || ocrNeeded || failedFiles > 0 ? "partial" : "known",
    hits,
    coverage: {
      scope: "materials",
      requested: Math.min(links.length, 1000),
      attempted: attemptedFiles,
      succeeded: succeededFiles,
      failed: failedFiles,
      truncated,
      next_cursor: truncated ? opaqueCursor(conversationId, batch.end) : null,
    },
    observed_at: new Date().toISOString(),
    reason_code: truncated
      ? "pdf_limit_exceeded"
      : ocrNeeded
        ? "ocr_required"
        : failedFiles > 0
          ? "material_read_partial"
          : null,
  };
}

async function read(
  message: ScombzStudentReadMessage,
): Promise<ScombzStudentReadResponse> {
  try {
    if (
      (message.adapter_version !== undefined &&
        message.adapter_version !== ADAPTER_VERSION) ||
      (message.content_script_generation !== undefined &&
        message.content_script_generation !== CONTENT_SCRIPT_GENERATION)
    ) {
      return {
        status: "unavailable",
        projection: emptyProjection(
          message.action,
          "unavailable",
          "scombz_source_identity_changed",
        ),
        reason_code: "scombz_source_identity_changed",
      };
    }
    if (message.action === "course_list") {
      const year =
        typeof message.arguments.academic_year === "number"
          ? message.arguments.academic_year
          : null;
      const term =
        typeof message.arguments.term === "string"
          ? message.arguments.term
          : null;
      const query =
        typeof message.arguments.query === "string"
          ? message.arguments.query
          : "";
      const cursor =
        typeof message.arguments.cursor === "string"
          ? message.arguments.cursor
          : null;
      const params = new URLSearchParams({ selectDisplayMode: "0" });
      if (year !== null) params.set("risyunen", String(year));
      if (term) params.set("kikanCd", term);
      const projection = courseList(
        await html(`/lms/timetable?${params}`),
        year,
        term,
        message.conversation_id,
        query,
        cursor,
      ) as ScombzStudentReadResponse["projection"];
      return { status: projection.status, projection };
    }
    if (message.action === "portal_read") {
      const requestedSections = Array.isArray(message.arguments.sections)
        ? message.arguments.sections
            .filter((value): value is string => typeof value === "string")
            .slice(0, 12)
        : [];
      const query =
        typeof message.arguments.query === "string"
          ? message.arguments.query
          : "";
      const cursor =
        typeof message.arguments.cursor === "string"
          ? message.arguments.cursor
          : null;
      const portalDoc = await html("/portal/home");
      const allItems = genericItems(
        portalDoc,
        "portal",
        message.conversation_id,
        requestedSections,
        query,
      );
      if (
        allItems.length === 0 &&
        !portalDoc.querySelector(
          "#taskList, #informationList, .contents-detail, .block-title",
        )
      ) {
        throw new Error("portal_structure_not_found");
      }
      const offset = cursorOffset(cursor, message.conversation_id);
      const items = allItems.slice(offset, offset + 200);
      const nextOffset = offset + items.length;
      const truncated = nextOffset < allItems.length;
      const status = truncated ? "partial" : "known";
      return {
        status,
        projection: {
          schema_version: "v1",
          status,
          items,
          coverage: {
            scope: "portal",
            requested: Math.min(allItems.length, 1000),
            attempted: Math.min(nextOffset, 1000),
            succeeded: items.length,
            failed: 0,
            truncated,
            next_cursor: truncated
              ? opaqueCursor(message.conversation_id, nextOffset)
              : null,
          },
          observed_at: new Date().toISOString(),
          reason_code: null,
        },
      };
    }
    if (message.action === "course_read") {
      const refs = Array.isArray(message.arguments.course_refs)
        ? message.arguments.course_refs
            .filter((value): value is string => typeof value === "string")
            .slice(0, 5)
        : [];
      const includeOwnSubmission =
        message.arguments.include_own_submission === true;
      const requestedSections = Array.isArray(message.arguments.sections)
        ? message.arguments.sections
            .filter((value): value is string => typeof value === "string")
            .slice(0, 12)
        : [];
      const query =
        typeof message.arguments.query === "string"
          ? message.arguments.query
          : "";
      const cursor =
        typeof message.arguments.cursor === "string"
          ? message.arguments.cursor
          : null;
      const offset = cursorOffset(cursor, message.conversation_id);
      const selectedRefs = refs.slice(offset, offset + 5);
      const items: unknown[] = [];
      const sectionStates: Record<
        string,
        "complete" | "truncated" | "failed" | "not_requested"
      > = {};
      let failed = 0;
      for (const courseRef of selectedRefs) {
        const path = resolve(courseTargets, courseRef, message.conversation_id);
        if (!path) {
          failed += 1;
          sectionStates[courseRef] = "failed";
          continue;
        }
        let doc: Document;
        try {
          doc = await html(path);
        } catch {
          failed += 1;
          sectionStates[courseRef] = "failed";
          continue;
        }
        if (!doc.querySelector("#courseTopForm")) {
          failed += 1;
          sectionStates[courseRef] = "failed";
          continue;
        }
        for (const block of Array.from(
          doc.querySelectorAll<HTMLElement>("#courseTopForm .block"),
        )) {
          const title = text(block.querySelector(".block-title"), 300);
          if (!title) continue;
          if (
            requestedSections.length > 0 &&
            !requestedSections.some((section) => title.includes(section))
          )
            continue;
          const activeTest = isInProgressTestTitle(title);
          const isSubmission = isOwnSubmissionSection(title);
          if (isSubmission && !includeOwnSubmission) {
            sectionStates[`${courseRef}:${title}`] = "not_requested";
            continue;
          }
          const body = activeTest
            ? null
            : text(block.querySelector(".contents-detail"), 6000);
          if (
            query &&
            !`${title} ${body ?? ""}`
              .toLocaleLowerCase()
              .includes(query.toLocaleLowerCase())
          )
            continue;
          const itemRef = ref("item");
          remember(itemTargets, itemRef, path, message.conversation_id);
          items.push({
            ref: itemRef,
            course_ref: courseRef,
            section: title,
            title,
            body,
            due_at: null,
            state: activeTest
              ? "in_progress"
              : /テスト|試験|examination/iu.test(title)
                ? "completed"
                : null,
            has_pdf: Boolean(
              block.querySelector(".fileDownload, a[href$='.pdf' i]"),
            ),
            observed_at: new Date().toISOString(),
            citation_uri: `orbit-scombz://citation/${itemRef.split("/").pop() ?? "item"}`,
          });
          sectionStates[`${courseRef}:${title}`] = "complete";
        }
        if (!sectionStates[courseRef]) sectionStates[courseRef] = "complete";
      }
      const cursorTruncated = offset + selectedRefs.length < refs.length;
      const stateEntries = Object.entries(sectionStates);
      const statesTruncated = stateEntries.length > 20;
      const boundedSectionStates = Object.fromEntries(
        stateEntries.slice(0, 20),
      );
      const status =
        failed > 0
          ? failed < selectedRefs.length
            ? "partial"
            : "unavailable"
          : cursorTruncated || statesTruncated
            ? "partial"
            : "known";
      // The API contract deliberately forbids detail fields on an entirely
      // unavailable result.  Keep the failed count/reason in coverage and
      // omit per-section state in that case so the projection remains
      // type-valid and the Agent can explain the boundary without guessing.
      const responseSectionStates =
        status === "unavailable" ? {} : boundedSectionStates;
      return {
        status,
        projection: {
          schema_version: "v1",
          status,
          items,
          section_states: responseSectionStates,
          coverage: {
            scope: "selected_courses",
            requested: refs.length,
            attempted: selectedRefs.length,
            succeeded: Math.max(0, selectedRefs.length - failed),
            failed,
            truncated: cursorTruncated || statesTruncated,
            next_cursor: cursorTruncated
              ? opaqueCursor(
                  message.conversation_id,
                  offset + selectedRefs.length,
                )
              : null,
          },
          observed_at: new Date().toISOString(),
          reason_code:
            failed > 0
              ? "course_read_partial"
              : statesTruncated
                ? "section_limit_exceeded"
                : null,
        },
      };
    }
    if (message.action === "material_search") {
      const courseRef =
        typeof message.arguments.course_ref === "string"
          ? message.arguments.course_ref
          : "";
      const query =
        typeof message.arguments.query === "string"
          ? message.arguments.query
          : "";
      const cursor =
        typeof message.arguments.cursor === "string"
          ? message.arguments.cursor
          : null;
      const projection = (await materialSearch(
        courseRef,
        query,
        cursor,
        message.conversation_id,
      )) as { status?: string };
      const status =
        projection.status === "partial" || projection.status === "unavailable"
          ? projection.status
          : "known";
      return {
        status,
        projection: projection as ScombzStudentReadResponse["projection"],
      };
    }
    return {
      status: "unavailable",
      projection: emptyProjection(
        message.action,
        "unavailable",
        "unsupported_action",
      ),
      reason_code: "unsupported_action",
    };
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "scombz_read_failed";
    const status =
      reason === "login_required" ? "reauth_required" : "unavailable";
    return {
      status,
      projection: emptyProjection(message.action, status, reason),
      reason_code: reason,
    };
  }
}

export function isScombzStudentAction(
  value: unknown,
): value is ScombzStudentAction {
  return (
    value === "course_list" ||
    value === "portal_read" ||
    value === "course_read" ||
    value === "material_search"
  );
}

export { read as readScombzStudent };
