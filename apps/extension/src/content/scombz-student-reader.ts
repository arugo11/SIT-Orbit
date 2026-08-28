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
      failed: 1,
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
  if (!entry || entry.conversationId !== conversationId || entry.offset < 0)
    return 0;
  if ((handleExpiry.get(value) ?? 0) <= Date.now()) {
    cursorOffsets.delete(value);
    handleExpiry.delete(value);
    return 0;
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
  return values.join(" ").slice(0, limit);
}

function isUnsafeCoursePath(pathname: string): boolean {
  // Course pages are fetched by GET for reading only.  Explicit action/test
  // routes are rejected before the request is sent so a handle cannot be
  // redirected into a write or active-exam surface.
  return /(?:^|\/)(?:answer|answers|attendance|delete|edit|exam|examination|quiz|quizzes|start|submit|test|tests|update|write)(?:\/|$)/iu.test(
    pathname,
  );
}

function hasVisibleTestControls(block: Element): boolean {
  return Array.from(
    block.querySelectorAll(
      "form, input, textarea, select, button[type='submit']",
    ),
  ).some((element) => visible(element));
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
  if (!allowed) throw new Error("path_not_allowlisted");
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
  if (/ログイン|login|password/iu.test(source.slice(0, 5000)))
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
      !target.pathname.startsWith("/lms/course/material/setfiledown/")
    ) {
      return null;
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
    yearOptions.length > 0 &&
    !yearOptions.includes(String(year))
  ) {
    throw new Error("academic_year_not_available");
  }
  if (term !== null && termOptions.length > 0 && !termOptions.includes(term)) {
    throw new Error("term_not_available");
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
    const id = tile.id.trim();
    const name = text(tile, 300);
    if (!id || !name) continue;
    const courseRef = ref("course");
    remember(
      courseTargets,
      courseRef,
      `/lms/course?idnumber=${encodeURIComponent(id)}`,
      conversationId,
    );
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
        failed: 1,
        truncated: false,
        next_cursor: null,
      },
      observed_at: new Date().toISOString(),
      reason_code: "course_ref_expired",
    };
  const doc = await html(path);
  const links = Array.from(
    doc.querySelectorAll<HTMLElement>(".fileDownload, a[href$='.pdf' i]"),
  );
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
  const fileLimit = Math.min(links.length, MAX_FILES);
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
    for (let index = start; index < fileLimit; index += 1) {
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
            next_cursor: opaqueCursor(conversationId, index),
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
        (type !== "" &&
          !/(?:application\/pdf|application\/octet-stream)/iu.test(type))
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
            next_cursor: opaqueCursor(conversationId, index),
          },
          observed_at: new Date().toISOString(),
          reason_code: "pdf_limit_exceeded",
        };
      let pdf: Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;
      try {
        pdf = await pdfjsLib.getDocument({
          data: buffer,
          isEvalSupported: false,
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
            next_cursor: opaqueCursor(conversationId, index),
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
        let body = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .replace(/\s+/gu, " ")
          .trim();
        if (!body) {
          const ocr = await recognizePdfPage(page);
          if (ocr) body = ocr.text;
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
              next_cursor: opaqueCursor(conversationId, index),
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
          const hitTruncated =
            index + 1 < fileLimit || links.length > MAX_FILES;
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
  const truncated = links.length > MAX_FILES;
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
      next_cursor: truncated ? opaqueCursor(conversationId, fileLimit) : null,
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
          const activeTest =
            /テスト|試験|examination|exam|quiz/iu.test(title) &&
            !/結果|成績|講評|終了|完了|result|score|feedback/iu.test(title) &&
            hasVisibleTestControls(block);
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
      return {
        status,
        projection: {
          schema_version: "v1",
          status,
          items,
          section_states: boundedSectionStates,
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
