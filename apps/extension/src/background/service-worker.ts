import {
  type CalendarConnectorResult,
  GoogleCalendarConnector,
} from "../connectors/google-calendar";
import {
  type DriveConnectorResult,
  GoogleDriveConnector,
} from "../connectors/google-drive";
import {
  isLibraryActionEditableInputs,
  type LibraryActionEditableInputs,
  type LibraryActionOption,
  type LibraryActionPreviewOfficial,
  readOnlyInputsForOperation,
  unavailableLibraryActionOptions,
} from "../connectors/library-actions";
import {
  createLibraryResourceRef,
  isLibraryResourceRef,
  isOfficialDiscoveryUrl,
  LIBRARY_LOAN_RANKING_URL,
  LIBRARY_NEW_BOOKS_URL,
  LIBRARY_OPAC_ENTRY_URL,
  LIBRARY_OPAC_ORIGIN,
  LIBRARY_OPAC_PERMISSION_PATTERN,
  LIBRARY_RECORD_PATH_PREFIX,
  LIBRARY_SIT_SEARCH_ENTRY_URL,
  LIBRARY_SIT_SEARCH_ORIGIN,
  LIBRARY_SIT_SEARCH_PERMISSION_PATTERN,
} from "../connectors/library-discovery";
import {
  SYLLABUS_SEARCH_ORIGIN,
  searchOfficialSyllabus,
} from "../connectors/syllabus-search";
import {
  CAST_ENTRY_URL,
  CAST_ORIGIN,
  CAST_TOP_URL,
  type CastLocalSnapshot,
  projectCastForAgent,
} from "../content/cast-reader";
import {
  MOODLE_DASHBOARD_URL,
  MOODLE_LOGIN_URL,
  MOODLE_ORIGIN,
  type MoodleLocalSnapshot,
  projectMoodleForAgent,
} from "../content/moodle-reader";
import {
  MY_LIBRARY_ENTRY_URL,
  MY_LIBRARY_MENU_IDS,
  MY_LIBRARY_ORIGIN,
  MY_LIBRARY_STATUS_PATH,
  type MyLibraryLocalSnapshot,
  type MyLibraryReadOptions,
  type MyLibraryScope,
  type MyLibraryScopedItem,
  projectMyLibraryForAgent,
} from "../content/my-library-reader";
import {
  isScombzUrl,
  isSitrusGradeUrl,
  type PageContext,
} from "../content/page-context";
import {
  parseSitrusGradeProjection,
  parseSitrusGradeTableProjection,
  type SitrusTableRow,
} from "../content/sitrus-reader";
import {
  type BrowserReadResponse,
  type CalendarCommandMessage,
  type CastReadResponse,
  type DriveCommandMessage,
  isBrowserReadMessage,
  isCalendarCommandMessage,
  isCastOpenMessage,
  isCastReadMessage,
  isDriveCommandMessage,
  isGetPageContextMessage,
  isGetWorkspaceSessionMessage,
  isGetWorkspaceStatusMessage,
  isLibraryActionOptionsMessage,
  isLibraryActionPreviewMessage,
  isLibraryActionSubmitMessage,
  isLibraryCatalogBrowseMessage,
  isLibraryCatalogSearchMessage,
  isLibraryDiscoverySearchMessage,
  isLibraryItemReadMessage,
  isMoodleOpenMessage,
  isMoodleReadMessage,
  isMyLibraryDisconnectMessage,
  isMyLibraryOpenMessage,
  isMyLibraryReadMessage,
  isOpenWorkspaceMessage,
  isPageContext,
  isPageContextUpdatedMessage,
  isSitrusReadMessage,
  isSyllabusSearchMessage,
  isUpdateWorkspaceSessionMessage,
  type LibraryActionOptionsMessage,
  type LibraryActionOptionsResponse,
  type LibraryActionPreviewMessage,
  type LibraryActionPreviewResponse,
  type LibraryActionSubmitMessage,
  type LibraryActionSubmitResponse,
  type LibraryCatalogBrowseMessage,
  type LibraryCatalogBrowseResponse,
  type LibraryCatalogSearchMessage,
  type LibraryCatalogSearchResponse,
  type LibraryDiscoverySearchMessage,
  type LibraryDiscoverySearchResponse,
  type LibraryItemReadMessage,
  type LibraryItemReadResponse,
  MESSAGE_TYPES,
  type MoodleReadResponse,
  type MyLibraryReadMessage,
  type MyLibraryReadResponse,
  type OpenWorkspaceMessage,
  type OpenWorkspaceResponse,
  type SitrusReadResponse,
  type UpdateWorkspaceSessionMessage,
  type WorkspaceSessionResponse,
  type WorkspaceStatusResponse,
} from "../shared/messages";
import {
  isWorkspaceSessionId,
  type WorkspaceSession,
  workspaceSessionKey,
  workspaceSourceKey,
} from "../shared/workspace-session";

const googleCalendarConnector = new GoogleCalendarConnector();
const googleDriveConnector = new GoogleDriveConnector();

const BUILT_IN_ORIGINS = new Set([
  "https://scombz.shibaura-it.ac.jp",
  "https://syllabus.sic.shibaura-it.ac.jp",
  "https://sitrus.sic.shibaura-it.ac.jp",
  "http://localhost:8000",
]);

const MOODLE_PERMISSION_PATTERN = `${MOODLE_ORIGIN}/*`;
const MY_LIBRARY_PERMISSION_PATTERN = `${MY_LIBRARY_ORIGIN}/*`;
const CAST_PERMISSION_PATTERN = `${CAST_ORIGIN}/*`;

// The public record ID is retained only while the service worker is alive so
// an opaque resource_ref can be resolved for the next item-read call. A
// worker restart therefore fails closed instead of guessing a record URL.
const libraryRecordRefs = new Map<string, string>();
const libraryRecordSnapshots = new Map<string, LibraryMaterializedRecord>();
const libraryActionRefExpiry = new Map<string, number>();
const LIBRARY_ACTION_REF_TTL_MS = 10 * 60 * 1000;

interface MyLibraryResourceTarget {
  scope: MyLibraryScope;
  raw_id: string | null;
}

// Personal material/request identifiers are retained only in this short-lived
// worker map. A missing visible identifier is deliberately represented as a
// null target: the opaque ref may be displayed, but a future Branch 3 action
// must fail closed instead of matching by title or guessing an ID.
const myLibraryResourceRefs = new Map<string, MyLibraryResourceTarget>();
const myLibraryResourceRefKeys = new Map<string, string>();

function clearMyLibraryResourceMaps(): void {
  for (const resourceRef of myLibraryResourceRefs.keys()) {
    libraryActionRefExpiry.delete(resourceRef);
  }
  myLibraryResourceRefs.clear();
  myLibraryResourceRefKeys.clear();
}

function clearLibraryRecordMaps(): void {
  libraryRecordRefs.clear();
  libraryRecordSnapshots.clear();
  libraryActionRefExpiry.clear();
}

function rememberLibraryActionRef(resourceRef: string): void {
  libraryActionRefExpiry.set(
    resourceRef,
    Date.now() + LIBRARY_ACTION_REF_TTL_MS,
  );
}

function isLiveLibraryActionRef(resourceRef: string): boolean {
  const expiresAt = libraryActionRefExpiry.get(resourceRef);
  if (expiresAt === undefined || expiresAt <= Date.now()) {
    libraryActionRefExpiry.delete(resourceRef);
    libraryRecordRefs.delete(resourceRef);
    myLibraryResourceRefs.delete(resourceRef);
    myLibraryResourceRefKeys.delete(resourceRef);
    return false;
  }
  return true;
}

function browserOrigin(
  value: string,
): { origin: string; pattern: string } | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return { origin: url.origin, pattern: `${url.origin}/*` };
  } catch {
    return null;
  }
}

async function hasBrowserPermission(
  pattern: string,
  origin: string,
): Promise<boolean> {
  if (BUILT_IN_ORIGINS.has(origin)) return true;
  if (typeof chrome.permissions?.contains !== "function") return false;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

function unavailableBrowser(reason_code: string): BrowserReadResponse {
  return { status: "unavailable", reason_code };
}

async function waitForTabReady(tabId: number): Promise<void> {
  try {
    const current = await chrome.tabs.get(tabId);
    const status = (current as chrome.tabs.Tab & { status?: string }).status;
    if (status !== "loading") {
      return;
    }
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener?.(listener);
      resolve();
    };
    const listener = (
      updatedTabId: number,
      changeInfo: { status?: string },
    ) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, 8000);
  });
}

type LibraryRawHolding = {
  campus: "toyosu" | "omiya" | "unknown";
  location: string | null;
  call_number: string | null;
  status: "available" | "unavailable" | "unknown";
  due_date: string | null;
  reservation_count: number | null;
};

type LibraryRawRecord = {
  record_id: string;
  title: string;
  authors: string[];
  subjects: string[];
  isbn: string | null;
  publisher: string | null;
  publication_year: number | null;
  format: "book" | "journal" | "ebook" | "unknown";
  campus: "toyosu" | "omiya" | "any";
  url: string;
  holdings: LibraryRawHolding[];
  related_records: Array<{
    record_id: string;
    title: string;
    relation: "related" | "edition" | "translation" | "other";
  }>;
};

type LibraryMaterializedRecord = {
  resource_ref: string;
  title: string;
  authors: string[];
  subjects: string[];
  isbn: string | null;
  publisher: string | null;
  publication_year: number | null;
  format: "book" | "journal" | "ebook" | "unknown";
  campus: "toyosu" | "omiya" | "any";
  url: string;
  holdings: LibraryRawHolding[];
  related_records: Array<{
    resource_ref: string;
    title: string;
    relation: "related" | "edition" | "translation" | "other";
  }>;
};

type LibraryPageProjection =
  | { status: "known"; records: LibraryRawRecord[] }
  | { status: "loading" }
  | { status: "unavailable"; reason_code: string };

type LibraryActionPageProjection =
  | {
      status: "known";
      holding_visible: boolean;
      official_viewer_visible: boolean;
      official_viewer_url: string | null;
    }
  | { status: "reauth_required"; reason_code: string }
  | { status: "unavailable"; reason_code: string };

type MyLibraryActionPageProjection =
  | {
      status: "known";
      target_found: boolean;
      target_renewable: boolean;
      any_overdue: boolean;
      target_reserved: boolean;
      viewer_visible: boolean;
    }
  | { status: "reauth_required"; reason_code: string }
  | { status: "unavailable"; reason_code: string };

type LibraryActionPreviewEntry = {
  tool_call_id: string;
  operation: LibraryActionPreviewMessage["operation"];
  inputs: LibraryActionEditableInputs;
  resource_ref: string;
  action_type: LibraryActionPreviewMessage["operation"]["action_type"];
  exact_origin: string;
  exact_path: string;
  state_fingerprint: string;
  created_at: number;
  state: "pending" | "consumed";
  official_url: string;
};

const LIBRARY_PREVIEW_TTL_MS = 90_000;
const libraryActionPreviews = new Map<string, LibraryActionPreviewEntry>();

function clearLibraryActionPreviews(): void {
  libraryActionPreviews.clear();
}

function libraryActionStateFingerprint(value: unknown): string {
  return JSON.stringify(value);
}

function newLibraryPreviewId(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `orbit-library://preview/${token}`;
}

function submitLibraryCatalogSearchInPage(filters: {
  query: string;
  author?: string | null;
  subject?: string | null;
  isbn?: string | null;
  pub_year?: number | null;
  campus?: "toyosu" | "omiya" | "any";
  format?: "book" | "journal" | "ebook" | "any";
}): { status: "submitted" | "unavailable"; reason_code?: string } {
  try {
    const isVisible = (element: Element): boolean => {
      for (
        let current: Element | null = element;
        current;
        current = current.parentElement
      ) {
        if (
          current.hasAttribute("hidden") ||
          current.getAttribute("aria-hidden") === "true"
        ) {
          return false;
        }
        const inlineStyle = (current.getAttribute("style") ?? "")
          .replace(/\s+/gu, "")
          .toLowerCase();
        if (
          /(?:^|;)display:none(?:;|$)/u.test(inlineStyle) ||
          /(?:^|;)visibility:(?:hidden|collapse)(?:;|$)/u.test(inlineStyle) ||
          /(?:^|;)opacity:0(?:;|$)/u.test(inlineStyle)
        ) {
          return false;
        }
        if (typeof getComputedStyle === "function") {
          const style = getComputedStyle(current);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            style.opacity === "0"
          ) {
            return false;
          }
        }
      }
      return true;
    };
    if (
      location.origin !== "https://library.shibaura-it.ac.jp" ||
      location.pathname !== "/opc/"
    ) {
      return { status: "unavailable", reason_code: "unexpected_opac_entry" };
    }
    const form = Array.from(
      document.querySelectorAll<HTMLFormElement>("form"),
    ).find(
      (candidate) =>
        isVisible(candidate) &&
        candidate.querySelector('[name="keys"]') !== null &&
        (candidate.action === "" ||
          new URL(candidate.action, location.href).pathname ===
            "/opc/xc/search"),
    );
    if (!form)
      return { status: "unavailable", reason_code: "search_form_not_found" };
    const setValue = (name: string, value: string): boolean => {
      const field = form.querySelector<HTMLInputElement | HTMLSelectElement>(
        `[name="${CSS.escape(name)}"]`,
      );
      if (!field || !isVisible(field)) return false;
      field.value = value;
      return true;
    };
    if (!setValue("keys", filters.query)) {
      return { status: "unavailable", reason_code: "query_field_not_found" };
    }
    const optionalFields: Array<[string, string | null | undefined]> = [
      ["title", null],
      ["fullTitle", null],
      ["auth", filters.author],
      ["pub", null],
      ["isbn", filters.isbn],
      [
        "pubYear",
        filters.pub_year === null || filters.pub_year === undefined
          ? null
          : String(filters.pub_year),
      ],
      ["subject", filters.subject],
      ["callNumber", null],
    ];
    for (const [name, value] of optionalFields) {
      if (value === null || value === undefined) continue;
      if (!setValue(name, value)) {
        return {
          status: "unavailable",
          reason_code: `${name}_field_not_found`,
        };
      }
    }
    if (filters.format && filters.format !== "any") {
      if (filters.format === "ebook") {
        const ebookLocation = Array.from(
          form.querySelectorAll<HTMLInputElement>('input[name^="location["]'),
        ).find(
          (field) =>
            isVisible(field) &&
            /eBook|電子図書/iu.test(
              field.closest("label")?.textContent ?? field.value,
            ),
        );
        if (!ebookLocation) {
          return {
            status: "unavailable",
            reason_code: "format_filter_unavailable",
          };
        }
        ebookLocation.checked = true;
      } else {
        const fieldName = `format[${filters.format === "book" ? "Book" : "Journal"}]`;
        const formatField = form.querySelector<HTMLInputElement>(
          `[name="${CSS.escape(fieldName)}"]`,
        );
        if (!formatField || !isVisible(formatField)) {
          return {
            status: "unavailable",
            reason_code: "format_filter_unavailable",
          };
        }
        formatField.checked = true;
      }
    }
    if (filters.campus && filters.campus !== "any") {
      const fieldName = `location[${filters.campus === "toyosu" ? "Toyosu" : "Omiya"}]`;
      const campusField = form.querySelector<HTMLInputElement>(
        `[name="${CSS.escape(fieldName)}"]`,
      );
      if (!campusField || !isVisible(campusField)) {
        return {
          status: "unavailable",
          reason_code: "campus_filter_unavailable",
        };
      }
      campusField.checked = true;
    }
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
    return { status: "submitted" };
  } catch {
    return { status: "unavailable", reason_code: "search_submit_failed" };
  }
}

function readLibraryCatalogSearchInPage(): LibraryPageProjection {
  const clean = (value: string | null | undefined, limit: number): string =>
    (value ?? "").replace(/\s+/gu, " ").trim().slice(0, limit);
  const isVisible = (element: Element): boolean => {
    for (
      let current: Element | null = element;
      current;
      current = current.parentElement
    ) {
      if (
        current.hasAttribute("hidden") ||
        current.getAttribute("aria-hidden") === "true"
      ) {
        return false;
      }
      const inlineStyle = (current.getAttribute("style") ?? "")
        .replace(/\s+/gu, "")
        .toLowerCase();
      if (
        /(?:^|;)display:none(?:;|$)/u.test(inlineStyle) ||
        /(?:^|;)visibility:(?:hidden|collapse)(?:;|$)/u.test(inlineStyle) ||
        /(?:^|;)opacity:0(?:;|$)/u.test(inlineStyle)
      ) {
        return false;
      }
      if (typeof getComputedStyle === "function") {
        const style = getComputedStyle(current);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          style.opacity === "0"
        ) {
          return false;
        }
      }
    }
    return true;
  };
  const visibleText = (root: Element, limit: number): string => {
    const parts: string[] = [];
    let length = 0;
    const visit = (node: Node): void => {
      if (length >= limit) return;
      if (node.nodeType === 3) {
        const parent = node.parentElement;
        if (parent && isVisible(parent)) {
          const text = node.textContent ?? "";
          parts.push(text);
          length += text.length + 1;
        }
        return;
      }
      if (node.nodeType === 1 && !isVisible(node as Element)) return;
      for (const child of Array.from(node.childNodes)) visit(child);
    };
    visit(root);
    return clean(parts.join(" "), limit);
  };
  const recordIdFromUrl = (value: string): string | null => {
    try {
      const url = new URL(value, location.href);
      if (
        url.origin !== "https://library.shibaura-it.ac.jp" ||
        !url.pathname.startsWith("/opc/recordID/catalog.bib/")
      ) {
        return null;
      }
      const raw = url.pathname.slice("/opc/recordID/catalog.bib/".length);
      return raw ? decodeURIComponent(raw) : null;
    } catch {
      return null;
    }
  };
  const rowFor = (link: Element): Element =>
    link.closest(".result-row, article, li, tr, .record, .search-result") ??
    link;
  const parseHolding = (element: Element): LibraryRawHolding | null => {
    if (!isVisible(element)) return null;
    const text = visibleText(element, 500);
    if (!text) return null;
    const status = /利用可|貸出可|available/i.test(text)
      ? "available"
      : /貸出中|利用不可|unavailable|checked\s*out/i.test(text)
        ? "unavailable"
        : "unknown";
    const campus = /豊洲|toyosu/i.test(text)
      ? "toyosu"
      : /大宮|omiya/i.test(text)
        ? "omiya"
        : "unknown";
    const dueDate = text.match(/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})/u);
    const dueYear = dueDate?.[1];
    const dueMonth = dueDate?.[2];
    const dueDay = dueDate?.[3];
    const due_date =
      status !== "unknown" && dueYear && dueMonth && dueDay
        ? `${dueYear}-${dueMonth.padStart(2, "0")}-${dueDay.padStart(2, "0")}`
        : null;
    const reservationMatch = text.match(/予約(?:数|件)?\s*[:：]?\s*(\d+)/u);
    const callNumber =
      text.match(/(?:請求記号|call\s*number)\s*[:：]?\s*([^\s,、]+)/iu)?.[1] ??
      text.match(/(?:貸出可|利用可|貸出中)\s*[,、]\s*([^\s,、]+)/u)?.[1] ??
      null;
    return {
      campus,
      location:
        text
          .match(/(?:所在|配置場所|location)\s*[:：]?\s*([^,、]+)/iu)?.[1]
          ?.slice(0, 200) ?? null,
      call_number: callNumber?.slice(0, 100) ?? null,
      status,
      due_date,
      reservation_count:
        reservationMatch && status !== "unknown"
          ? Number(reservationMatch[1])
          : null,
    };
  };
  const parseRecord = (link: HTMLAnchorElement): LibraryRawRecord | null => {
    const recordId = recordIdFromUrl(link.href);
    if (!recordId) return null;
    const row = rowFor(link);
    if (!isVisible(link) || !isVisible(row)) return null;
    const titleElement = Array.from(row.querySelectorAll(".xc-title")).find(
      isVisible,
    );
    const renderedTitle =
      titleElement && isVisible(titleElement)
        ? visibleText(titleElement, 300)
        : "";
    const title = clean(
      renderedTitle || link.getAttribute("title") || visibleText(link, 300),
      300,
    );
    if (!title) return null;
    const text = visibleText(row, 2_000);
    const visibleValues = (selector: string, limit: number): string[] =>
      Array.from(row.querySelectorAll(selector))
        .filter(isVisible)
        .map((element) => visibleText(element, limit))
        .filter((value) => value.length > 0)
        .filter((value, index, values) => values.indexOf(value) === index)
        .slice(0, 20);
    const yearMatch = text.match(/(?:19|20)\d{2}/u);
    const holdings = Array.from(
      row.querySelectorAll(
        "[data-availability], .xc-availability, .availability, .holding, .status",
      ),
    )
      .map(parseHolding)
      .filter((item): item is LibraryRawHolding => item !== null)
      .slice(0, 20);
    return {
      record_id: recordId,
      title,
      authors: visibleValues(
        ".xc-creator, .author, .authors, .creator, [data-author]",
        200,
      ),
      subjects: visibleValues(".subject, .subjects, [data-subject]", 200),
      isbn:
        text.match(/(?:ISBN(?:-\d+)?\s*[:：]?\s*)([0-9Xx-]{10,17})/u)?.[1] ??
        null,
      publisher:
        visibleValues(".publisher, .pub, [data-publisher]", 200)[0] ?? null,
      publication_year: yearMatch ? Number(yearMatch[0]) : null,
      format: /電子書籍|ebook/i.test(text)
        ? "ebook"
        : /雑誌|journal/i.test(text)
          ? "journal"
          : "unknown",
      campus: /豊洲|toyosu/i.test(text)
        ? "toyosu"
        : /大宮|omiya/i.test(text)
          ? "omiya"
          : "any",
      url: `https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/${encodeURIComponent(recordId)}`,
      holdings,
      related_records: [],
    };
  };
  try {
    const validCatalogPath =
      location.pathname.startsWith("/opc/") ||
      location.pathname === "/cgi-bin/nbk/nbk_seek.cgi" ||
      location.pathname === "/cgi-bin/loan_best10/loan_best10.cgi";
    if (
      location.origin !== "https://library.shibaura-it.ac.jp" ||
      !validCatalogPath
    ) {
      return { status: "unavailable", reason_code: "unexpected_opac_result" };
    }
    const loadingElement = document.querySelector(
      '[aria-busy="true"], .loading, .spinner',
    );
    if (
      (loadingElement && isVisible(loadingElement)) ||
      (document.body &&
        /読み込み中|loading/i.test(visibleText(document.body, 100_000)))
    ) {
      return { status: "loading" };
    }
    const linkedRecords = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[href]"),
    )
      .map(parseRecord)
      .filter((item): item is LibraryRawRecord => item !== null)
      .filter(
        (item, index, all) =>
          all.findIndex(
            (candidate) => candidate.record_id === item.record_id,
          ) === index,
      )
      .slice(0, 10);
    let records = linkedRecords;
    if (location.pathname.startsWith("/opc/recordID/catalog.bib/")) {
      const currentId = recordIdFromUrl(location.href);
      const mainTable = document.querySelector("dl.mainTable");
      const titleElement = document.querySelector(
        "h1.page-title, #content h3, .node h3",
      );
      const title = titleElement ? visibleText(titleElement, 300) : "";
      if (
        !currentId ||
        !mainTable ||
        !isVisible(mainTable) ||
        !titleElement ||
        !isVisible(titleElement) ||
        !title
      ) {
        return {
          status: "unavailable",
          reason_code: "record_structure_not_found",
        };
      }
      const definition = (labels: RegExp): string | null => {
        const term = Array.from(mainTable.querySelectorAll("dt")).find(
          (item) =>
            isVisible(item) &&
            labels.test(visibleText(item, 100).replace(/[:：]$/u, "")),
        );
        const value = term?.nextElementSibling;
        return value?.tagName === "DD" && isVisible(value)
          ? visibleText(value, 500)
          : null;
      };
      const splitValues = (value: string | null): string[] =>
        (value ?? "")
          .split(/[;；]/u)
          .map((item) => clean(item, 200))
          .filter((item) => item.length > 0)
          .slice(0, 20);
      const publication = definition(/^(?:出版情報|publication)$/iu);
      const yearMatch = publication?.match(/(?:19|20)\d{2}/u);
      const formatText = definition(/^(?:フォーマット|format)$/iu) ?? "";
      const pageText = document.body ? visibleText(document.body, 100_000) : "";
      const current: LibraryRawRecord = {
        record_id: currentId,
        title,
        authors: splitValues(
          definition(/^(?:著者名|責任表示|author|creator)$/iu),
        ),
        subjects: splitValues(definition(/^(?:件名|主題|subject)$/iu)),
        isbn: definition(/^ISBN$/iu)?.match(/([0-9Xx-]{10,17})/u)?.[1] ?? null,
        publisher: publication,
        publication_year: yearMatch ? Number(yearMatch[0]) : null,
        format: /電子書籍|ebook/i.test(formatText)
          ? "ebook"
          : /雑誌|journal/i.test(formatText)
            ? "journal"
            : /図書|book/i.test(formatText)
              ? "book"
              : "unknown",
        campus: /豊洲|toyosu/i.test(pageText)
          ? "toyosu"
          : /大宮|omiya/i.test(pageText)
            ? "omiya"
            : "any",
        url: `https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/${encodeURIComponent(currentId)}`,
        holdings: Array.from(
          document.querySelectorAll(
            "[data-availability], .xc-availability, .availability, .holding, .status",
          ),
        )
          .map(parseHolding)
          .filter((item): item is LibraryRawHolding => item !== null)
          .slice(0, 20),
        related_records: linkedRecords
          .filter((record) => record.record_id !== currentId)
          .map((record) => ({
            record_id: record.record_id,
            title: record.title,
            relation: "related" as const,
          }))
          .slice(0, 20),
      };
      records = [current];
    }
    const noResults =
      /該当する資料はありません|検索結果はありません|no\s+results/i.test(
        document.body ? visibleText(document.body, 100_000) : "",
      );
    if (!records.length && !noResults) {
      return {
        status: "unavailable",
        reason_code: "result_structure_not_found",
      };
    }
    return { status: "known", records };
  } catch {
    return { status: "unavailable", reason_code: "catalog_projection_failed" };
  }
}

function submitLibraryDiscoverySearchInPage(query: string): {
  status: "submitted" | "unavailable";
  reason_code?: string;
} {
  try {
    const isVisible = (element: Element): boolean => {
      for (
        let current: Element | null = element;
        current;
        current = current.parentElement
      ) {
        if (
          current.hasAttribute("hidden") ||
          current.getAttribute("aria-hidden") === "true"
        ) {
          return false;
        }
        const inlineStyle = (current.getAttribute("style") ?? "")
          .replace(/\s+/gu, "")
          .toLowerCase();
        if (
          /(?:^|;)display:none(?:;|$)/u.test(inlineStyle) ||
          /(?:^|;)visibility:(?:hidden|collapse)(?:;|$)/u.test(inlineStyle) ||
          /(?:^|;)opacity:0(?:;|$)/u.test(inlineStyle)
        ) {
          return false;
        }
        if (typeof getComputedStyle === "function") {
          const style = getComputedStyle(current);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            style.opacity === "0"
          ) {
            return false;
          }
        }
      }
      return true;
    };
    if (
      location.origin !== "https://slib.shibaura-it.ac.jp" ||
      !location.pathname.startsWith("/sublib/")
    ) {
      return {
        status: "unavailable",
        reason_code: "unexpected_discovery_entry",
      };
    }
    const form = Array.from(
      document.querySelectorAll<HTMLFormElement>("form"),
    ).find(
      (candidate) =>
        isVisible(candidate) &&
        candidate.querySelector('[name="kw"]') !== null &&
        candidate.querySelector('[name="searchTarget"]') !== null &&
        candidate.querySelector('[name="form_id"]') !== null,
    );
    if (!form)
      return { status: "unavailable", reason_code: "discovery_form_not_found" };
    const keyword = form.querySelector<HTMLInputElement>('[name="kw"]');
    if (!keyword || !isVisible(keyword))
      return {
        status: "unavailable",
        reason_code: "discovery_query_not_found",
      };
    keyword.value = query;
    const target = form.querySelector<HTMLSelectElement | HTMLInputElement>(
      '[name="searchTarget"]',
    );
    if (!target || !isVisible(target))
      return {
        status: "unavailable",
        reason_code: "discovery_target_not_found",
      };
    target.value = "0";
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
    return { status: "submitted" };
  } catch {
    return { status: "unavailable", reason_code: "discovery_submit_failed" };
  }
}

function readLibraryDiscoveryInPage(): {
  status: "known" | "loading" | "unavailable";
  items?: Array<{
    title: string;
    authors: string[];
    source_label: string | null;
    url: string;
    snippet: string | null;
    record_id: string | null;
  }>;
  reason_code?: string;
} {
  const clean = (value: string | null | undefined, limit: number): string =>
    (value ?? "").replace(/\s+/gu, " ").trim().slice(0, limit);
  const isVisible = (element: Element): boolean => {
    for (
      let current: Element | null = element;
      current;
      current = current.parentElement
    ) {
      if (
        current.hasAttribute("hidden") ||
        current.getAttribute("aria-hidden") === "true"
      ) {
        return false;
      }
      const inlineStyle = (current.getAttribute("style") ?? "")
        .replace(/\s+/gu, "")
        .toLowerCase();
      if (
        /(?:^|;)display:none(?:;|$)/u.test(inlineStyle) ||
        /(?:^|;)visibility:(?:hidden|collapse)(?:;|$)/u.test(inlineStyle) ||
        /(?:^|;)opacity:0(?:;|$)/u.test(inlineStyle)
      ) {
        return false;
      }
      if (typeof getComputedStyle === "function") {
        const style = getComputedStyle(current);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          style.opacity === "0"
        ) {
          return false;
        }
      }
    }
    return true;
  };
  const visibleText = (root: Element, limit: number): string => {
    const parts: string[] = [];
    let length = 0;
    const visit = (node: Node): void => {
      if (length >= limit) return;
      if (node.nodeType === 3) {
        const parent = node.parentElement;
        if (parent && isVisible(parent)) {
          const text = node.textContent ?? "";
          parts.push(text);
          length += text.length + 1;
        }
        return;
      }
      if (node.nodeType === 1 && !isVisible(node as Element)) return;
      for (const child of Array.from(node.childNodes)) visit(child);
    };
    visit(root);
    return clean(parts.join(" "), limit);
  };
  try {
    if (
      location.origin !== "https://slib.shibaura-it.ac.jp" ||
      !location.pathname.startsWith("/sublib/")
    ) {
      return {
        status: "unavailable",
        reason_code: "unexpected_discovery_result",
      };
    }
    const loadingElement = document.querySelector(
      '[aria-busy="true"], .loading, .spinner',
    );
    if (
      (loadingElement && isVisible(loadingElement)) ||
      (document.body &&
        /読み込み中|loading/i.test(visibleText(document.body, 100_000)))
    ) {
      return { status: "loading" };
    }
    const resultRows = Array.from(
      document.querySelectorAll<Element>(".result-row"),
    ).filter(isVisible);
    const resultLinks = resultRows.flatMap((row) =>
      row.matches("a[href]")
        ? [row as HTMLAnchorElement]
        : Array.from(row.querySelectorAll<HTMLAnchorElement>("a[href]")),
    );
    const items = resultLinks
      .map((link) => {
        if (!isVisible(link)) return null;
        const row = link.closest(".result-row");
        if (!row || !isVisible(row)) return null;
        if (
          link.closest(
            "nav, header, footer, .facet, .facets, .filter, .refine, .navigation, .pagination",
          )
        ) {
          return null;
        }
        const url = new URL(link.href, location.href);
        const normalizedOpacPath = url.pathname.replace(
          /^\/opc\/{2,}/u,
          "/opc/",
        );
        const official =
          url.origin === "https://slib.shibaura-it.ac.jp" &&
          url.pathname.startsWith("/sublib/");
        const opac =
          url.origin === "https://library.shibaura-it.ac.jp" &&
          normalizedOpacPath.startsWith("/opc/recordID/catalog.bib/");
        if ((!official && !opac) || url.username || url.password) return null;
        const title = visibleText(link, 300);
        const navigationText = clean(
          `${title} ${link.getAttribute("aria-label") ?? ""} ${link.getAttribute("title") ?? ""}`,
          500,
        );
        const lowerPath = url.pathname.toLowerCase();
        const lowerState = `${url.search}${url.hash}`.toLowerCase();
        if (
          /(?:^|\/)(?:help|english|facet|facets|filter|refine|navigation|menu|login)(?:\/|$)/u.test(
            lowerPath,
          ) ||
          /(?:^|[?&#])(?:facet|filter|refine|page|help|lang|language|english)(?:=|&|#|$)/u.test(
            lowerState,
          ) ||
          /^(?:help|english|language|menu|navigation|facet|facets|filter|refine|home|ログイン|検索|ヘルプ|絞り込み|ナビゲーション)$/iu.test(
            navigationText,
          )
        ) {
          return null;
        }
        // SIT Search may render per-session query parameters. They are not
        // needed by the model and must never cross the Agent API boundary.
        if (opac) url.pathname = normalizedOpacPath;
        url.search = "";
        url.hash = "";
        if (!title) return null;
        const text = visibleText(row, 600);
        const record_id = opac
          ? decodeURIComponent(
              normalizedOpacPath.slice("/opc/recordID/catalog.bib/".length),
            )
          : null;
        return {
          title,
          authors: Array.from(
            row.querySelectorAll(".author, .authors, .creator, [data-author]"),
          )
            .filter(isVisible)
            .map((element) => visibleText(element, 200))
            .filter((value) => value.length > 0)
            .filter((value, index, values) => values.indexOf(value) === index)
            .slice(0, 20),
          source_label:
            clean(
              (() => {
                const source = row.querySelector(
                  ".source, .database, .publisher",
                );
                return source && isVisible(source)
                  ? visibleText(source, 200)
                  : null;
              })(),
              200,
            ) || null,
          url: url.href,
          snippet: clean(text.replace(title, ""), 500) || null,
          record_id,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .filter(
        (item, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.url === item.url && candidate.title === item.title,
          ) === index,
      )
      .slice(0, 10);
    const noResults = /該当する|結果はありません|no\s+results/i.test(
      document.body ? visibleText(document.body, 100_000) : "",
    );
    if (!items.length && !noResults) {
      return {
        status: "unavailable",
        reason_code: "discovery_structure_not_found",
      };
    }
    return { status: "known", items };
  } catch {
    return {
      status: "unavailable",
      reason_code: "discovery_projection_failed",
    };
  }
}

function libraryUnavailable(reason_code: string): {
  status: "unavailable";
  reason_code: string;
} {
  return { status: "unavailable", reason_code };
}

function readLibraryActionOptionsInPage(): LibraryActionPageProjection {
  try {
    const current = new URL(location.href);
    if (
      current.origin !== LIBRARY_OPAC_ORIGIN ||
      !current.pathname.startsWith(LIBRARY_RECORD_PATH_PREFIX) ||
      current.pathname.slice(LIBRARY_RECORD_PATH_PREFIX.length).length === 0 ||
      current.search !== "" ||
      current.hash !== ""
    ) {
      return { status: "unavailable", reason_code: "unexpected_record_page" };
    }
    if (document.querySelector('input[type="password"]')) {
      return { status: "reauth_required", reason_code: "login_required" };
    }
    const visible = (element: Element): boolean => {
      for (
        let currentElement: Element | null = element;
        currentElement;
        currentElement = currentElement.parentElement
      ) {
        if (
          currentElement.hasAttribute("hidden") ||
          currentElement.getAttribute("aria-hidden") === "true"
        ) {
          return false;
        }
        const style = (currentElement.getAttribute("style") ?? "")
          .replace(/\s+/gu, "")
          .toLowerCase();
        if (
          /(?:^|;)display:none(?:;|$)/u.test(style) ||
          /(?:^|;)visibility:(?:hidden|collapse)(?:;|$)/u.test(style) ||
          /(?:^|;)opacity:0(?:;|$)/u.test(style)
        ) {
          return false;
        }
      }
      return true;
    };
    const text = (element: Element | null): string =>
      (element?.textContent ?? "").replace(/\s+/gu, " ").trim();
    const bodyText = text(document.body);
    if (!bodyText) {
      return { status: "unavailable", reason_code: "record_not_rendered" };
    }
    const campusValue = (value: string): boolean =>
      /(?:豊洲|大宮|toyosu|omiya)/iu.test(value.replace(/[\s　]/gu, ""));
    const isCampusLabel = (value: string): boolean =>
      /^(?:所蔵館|所蔵場所|配置場所|所在|キャンパス|館)$/iu.test(value);
    const isCallNumberLabel = (value: string): boolean =>
      /^(?:請求記号|call\s*(?:no\.?|number))$/iu.test(value);
    const hasExplicitHoldingRow = (row: Element): boolean => {
      if (!visible(row)) return false;
      const labels = Array.from(row.querySelectorAll("dt, th"));
      let location: string | null = null;
      let callNumber: string | null = null;
      for (const label of labels) {
        const labelText = text(label);
        const value = label.nextElementSibling;
        if (!value || !visible(value)) continue;
        if (isCampusLabel(labelText)) location = text(value);
        if (isCallNumberLabel(labelText)) callNumber = text(value);
      }
      if (location !== null && callNumber !== null) {
        return campusValue(location) && callNumber.length > 0;
      }
      const headerRows = Array.from(row.querySelectorAll("tr"));
      for (const header of headerRows) {
        const headers = Array.from(header.querySelectorAll("th")).map(text);
        const locationIndex = headers.findIndex(isCampusLabel);
        const callIndex = headers.findIndex(isCallNumberLabel);
        if (locationIndex < 0 || callIndex < 0) continue;
        const dataRows = Array.from(
          header.parentElement?.querySelectorAll("tr") ?? [],
        );
        for (const dataRow of dataRows) {
          if (dataRow === header || !visible(dataRow)) continue;
          const cells = Array.from(dataRow.querySelectorAll("td"));
          const locationCell = cells[locationIndex];
          const callCell = cells[callIndex];
          if (
            locationCell &&
            callCell &&
            campusValue(text(locationCell)) &&
            text(callCell).length > 0
          ) {
            return true;
          }
        }
      }
      return false;
    };
    const holding_visible = Array.from(
      document.querySelectorAll("dl, table"),
    ).some(hasExplicitHoldingRow);
    const viewerLink = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[href]"),
    ).find((link) => {
      if (!visible(link)) return false;
      const label = text(link);
      if (!/電子|本文|閲覧|viewer|view/iu.test(label)) return false;
      try {
        const url = new URL(link.href, current.href);
        return (
          url.protocol === "https:" &&
          (url.origin === LIBRARY_OPAC_ORIGIN ||
            url.origin === LIBRARY_SIT_SEARCH_ORIGIN) &&
          url.search === "" &&
          url.hash === "" &&
          url.href !== current.href
        );
      } catch {
        return false;
      }
    });
    return {
      status: "known",
      holding_visible,
      official_viewer_visible: viewerLink !== undefined,
      official_viewer_url: viewerLink
        ? new URL(viewerLink.href, current.href).href
        : null,
    };
  } catch {
    return { status: "unavailable", reason_code: "action_options_read_failed" };
  }
}

function readMyLibraryActionOptionsInPage(
  scope: MyLibraryScope,
  targetRawId: string,
): MyLibraryActionPageProjection {
  try {
    if (
      location.origin !== MY_LIBRARY_ORIGIN ||
      location.pathname !== MY_LIBRARY_STATUS_PATH ||
      location.search !== "" ||
      location.hash !== ""
    ) {
      return { status: "unavailable", reason_code: "unexpected_page" };
    }
    if (document.querySelector('input[type="password"]')) {
      return { status: "reauth_required", reason_code: "login_required" };
    }
    const clean = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/gu, " ").trim();
    const visible = (element: Element): boolean => {
      for (
        let currentElement: Element | null = element;
        currentElement;
        currentElement = currentElement.parentElement
      ) {
        if (
          currentElement.hasAttribute("hidden") ||
          currentElement.getAttribute("aria-hidden") === "true"
        ) {
          return false;
        }
        const style = (currentElement.getAttribute("style") ?? "")
          .replace(/\s+/gu, "")
          .toLowerCase();
        if (
          /(?:^|;)display:none(?:;|$)/u.test(style) ||
          /(?:^|;)visibility:(?:hidden|collapse)(?:;|$)/u.test(style) ||
          /(?:^|;)opacity:0(?:;|$)/u.test(style)
        ) {
          return false;
        }
      }
      return true;
    };
    const tableSelector =
      scope === "current_loans"
        ? "#lendList"
        : scope === "reservations"
          ? "#reservationList"
          : "table";
    const table = document.querySelector(tableSelector);
    if (!table || !visible(table)) {
      return { status: "unavailable", reason_code: "scope_table_not_found" };
    }
    const rows = Array.from(table.querySelectorAll("tbody tr")).filter(visible);
    if (rows.length === 0) {
      return { status: "unavailable", reason_code: "scope_row_unparseable" };
    }
    const targetRows = rows.filter((row) => {
      const visibleIds: string[] = [];
      for (const label of Array.from(row.querySelectorAll("dt, th"))) {
        if (!visible(label)) continue;
        if (
          !/^(?:資料ID|資料番号|受付番号|依頼番号|申請番号|整理番号|ILL番号)$/u.test(
            clean(label.textContent),
          )
        ) {
          continue;
        }
        const value = label.nextElementSibling;
        if (value && visible(value)) visibleIds.push(clean(value.textContent));
      }
      for (const checkbox of Array.from(
        row.querySelectorAll<HTMLInputElement>(
          'input[type="checkbox"][name="checkBoxBookNumber"]',
        ),
      )) {
        if (!visible(checkbox) || checkbox.disabled) continue;
        if (clean(checkbox.value) === targetRawId) visibleIds.push(targetRawId);
        if (checkbox.id) {
          const label = Array.from(row.querySelectorAll("label")).find(
            (candidate) => candidate.htmlFor === checkbox.id,
          );
          if (label && clean(label.textContent) === targetRawId) {
            visibleIds.push(targetRawId);
          }
        }
      }
      return visibleIds.some((value) => value === targetRawId);
    });
    if (targetRows.length !== 1) {
      return {
        status: "known",
        target_found: false,
        target_renewable: false,
        any_overdue: false,
        target_reserved: false,
        viewer_visible: false,
      };
    }
    const dateFromText = (value: string): string | null => {
      const match = value.match(/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})/u);
      if (!match) return null;
      const year = match[1];
      const month = match[2];
      const day = match[3];
      if (!year || !month || !day) return null;
      return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    };
    const now = new Date();
    const today = `${now.getFullYear()}-${(now.getMonth() + 1)
      .toString()
      .padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}`;
    const allDates = rows.map((row) => dateFromText(clean(row.textContent)));
    const any_overdue = allDates.some((date) => date !== null && date < today);
    const target = targetRows[0];
    if (!target) {
      return {
        status: "known",
        target_found: false,
        target_renewable: false,
        any_overdue: false,
        target_reserved: false,
        viewer_visible: false,
      };
    }
    const targetText = clean(target.textContent);
    const target_renewable =
      scope === "current_loans" &&
      Array.from(
        target.querySelectorAll<HTMLInputElement>(
          'input[type="checkbox"][name="checkBoxBookNumber"]',
        ),
      ).some((element) => {
        if (!visible(element) || element.disabled) return false;
        if (clean(element.value) === targetRawId) return true;
        if (!element.id) return false;
        const label = Array.from(target.querySelectorAll("label")).find(
          (candidate) => candidate.htmlFor === element.id,
        );
        return label !== undefined && clean(label.textContent) === targetRawId;
      });
    const target_reserved =
      scope === "reservations" || /予約|取置/iu.test(targetText);
    const viewer_visible = Array.from(
      target.querySelectorAll<HTMLAnchorElement>("a[href]"),
    ).some((link) =>
      /電子|本文|閲覧|viewer|view/iu.test(clean(link.textContent)),
    );
    return {
      status: "known",
      target_found: true,
      target_renewable,
      any_overdue,
      target_reserved,
      viewer_visible,
    };
  } catch {
    return { status: "unavailable", reason_code: "action_options_read_failed" };
  }
}

type LibraryWriteSurfaceProjection =
  | {
      status: "validated";
      exact_origin: string;
      exact_path: string;
      target_found: boolean;
      form_post: boolean;
      form_path: string;
      csrf_present: boolean;
      state_fingerprint: string;
    }
  | { status: "reauth_required"; reason_code: string }
  | { status: "unavailable"; reason_code: string };

/** Validate only the live write surface shape; this function never submits. */
function validateMyLibraryWriteSurfaceInPage(
  scope: MyLibraryScope,
  targetRawId: string,
): LibraryWriteSurfaceProjection {
  try {
    if (
      location.origin !== MY_LIBRARY_ORIGIN ||
      location.pathname !== MY_LIBRARY_STATUS_PATH ||
      location.search !== "" ||
      location.hash !== ""
    ) {
      return { status: "unavailable", reason_code: "unexpected_page" };
    }
    if (document.querySelector('input[type="password"]')) {
      return { status: "reauth_required", reason_code: "login_required" };
    }
    const clean = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/gu, " ").trim();
    const visible = (element: Element): boolean => {
      for (
        let current: Element | null = element;
        current;
        current = current.parentElement
      ) {
        if (
          current.hasAttribute("hidden") ||
          current.getAttribute("aria-hidden") === "true"
        ) {
          return false;
        }
        const style = (current.getAttribute("style") ?? "")
          .replace(/\s+/gu, "")
          .toLowerCase();
        if (
          /(?:^|;)display:none(?:;|$)/u.test(style) ||
          /(?:^|;)visibility:(?:hidden|collapse)(?:;|$)/u.test(style) ||
          /(?:^|;)opacity:0(?:;|$)/u.test(style)
        ) {
          return false;
        }
      }
      return true;
    };
    const tableSelector =
      scope === "current_loans"
        ? "#lendList"
        : scope === "reservations"
          ? "#reservationList"
          : "table";
    const table = document.querySelector(tableSelector);
    if (!table || !visible(table)) {
      return { status: "unavailable", reason_code: "scope_table_not_found" };
    }
    const targetRows = Array.from(table.querySelectorAll("tbody tr")).filter(
      (row) => {
        if (!visible(row)) return false;
        const values: string[] = [];
        for (const label of Array.from(row.querySelectorAll("dt, th"))) {
          if (
            /^(?:資料ID|資料番号|受付番号|依頼番号|申請番号|整理番号|ILL番号)$/u.test(
              clean(label.textContent),
            )
          ) {
            const value = label.nextElementSibling;
            if (value && visible(value)) values.push(clean(value.textContent));
          }
        }
        for (const checkbox of Array.from(
          row.querySelectorAll<HTMLInputElement>(
            'input[type="checkbox"][name="checkBoxBookNumber"]',
          ),
        )) {
          if (!visible(checkbox) || checkbox.disabled) continue;
          if (clean(checkbox.value) === targetRawId) values.push(targetRawId);
          if (checkbox.id) {
            const label = Array.from(row.querySelectorAll("label")).find(
              (candidate) => candidate.htmlFor === checkbox.id,
            );
            if (label && clean(label.textContent) === targetRawId) {
              values.push(targetRawId);
            }
          }
        }
        return values.some((value) => value === targetRawId);
      },
    );
    if (targetRows.length !== 1) {
      return { status: "unavailable", reason_code: "target_not_current" };
    }
    const form = document.querySelector<HTMLFormElement>("form#frmMain");
    if (!form)
      return { status: "unavailable", reason_code: "write_form_missing" };
    const method = (form.getAttribute("method") ?? "get").toLowerCase();
    const action = form.getAttribute("action") ?? "";
    const formUrl = new URL(action || location.pathname, location.href);
    const formPost = method === "post";
    if (
      !formPost ||
      action !== "" ||
      formUrl.origin !== MY_LIBRARY_ORIGIN ||
      formUrl.pathname !== MY_LIBRARY_STATUS_PATH ||
      formUrl.search !== "" ||
      formUrl.hash !== ""
    ) {
      return {
        status: "unavailable",
        reason_code: "write_form_shape_unverified",
      };
    }
    const csrfPresent = Array.from(
      form.querySelectorAll<HTMLInputElement>('input[type="hidden"]'),
    ).some(
      (input) =>
        /csrf|token/iu.test(input.name) && input.value.trim().length > 0,
    );
    if (!csrfPresent) {
      return { status: "unavailable", reason_code: "csrf_not_visible" };
    }
    return {
      status: "validated",
      exact_origin: location.origin,
      exact_path: location.pathname,
      target_found: true,
      form_post: true,
      form_path: formUrl.pathname,
      csrf_present: true,
      state_fingerprint: JSON.stringify({
        scope,
        target_found: true,
        form_post: true,
        form_path: formUrl.pathname,
      }),
    };
  } catch {
    return { status: "unavailable", reason_code: "write_surface_read_failed" };
  }
}

function publicLibraryActionOptions(
  resource_ref: string,
  projection: Extract<LibraryActionPageProjection, { status: "known" }>,
): LibraryActionOptionsResponse {
  const unavailableWriteReason = "write_form_not_verified";
  const options: LibraryActionOption[] = [
    {
      action_type: "visit_shelf",
      available: projection.holding_visible,
      reason_code: projection.holding_visible
        ? "available"
        : "holding_not_visible",
      required_inputs: [],
    },
    {
      action_type: "open_online",
      available: projection.official_viewer_visible,
      reason_code: projection.official_viewer_visible
        ? "available"
        : "official_viewer_not_visible",
      required_inputs: [],
    },
    {
      action_type: "reserve",
      available: false,
      reason_code: unavailableWriteReason,
      required_inputs: ["pickup_campus"],
    },
    {
      action_type: "intercampus_transfer",
      available: false,
      reason_code: unavailableWriteReason,
      required_inputs: ["pickup_campus"],
    },
    {
      action_type: "renew",
      available: false,
      reason_code: "not_personal_loan",
      required_inputs: [],
    },
    {
      action_type: "purchase_request",
      available: false,
      reason_code: unavailableWriteReason,
      required_inputs: ["reason"],
    },
    {
      action_type: "ill_loan",
      available: false,
      reason_code: unavailableWriteReason,
      required_inputs: ["receiver", "payment", "fee"],
    },
    {
      action_type: "ill_copy",
      available: false,
      reason_code: unavailableWriteReason,
      required_inputs: ["receiver", "payment", "fee", "page_range"],
    },
  ];
  return {
    status: "known",
    projection: {
      schema_version: "v1",
      status: "known",
      resource_ref,
      options,
      data_classification: "public",
      reason_code: null,
    },
  };
}

function myLibraryActionOptions(
  resource_ref: string,
  projection: Extract<MyLibraryActionPageProjection, { status: "known" }>,
): LibraryActionOptionsResponse {
  const targetReason = projection.target_found
    ? "not_available"
    : "target_not_current";
  const renewable =
    projection.target_found &&
    projection.target_renewable &&
    !projection.any_overdue &&
    !projection.target_reserved;
  const renewReason = renewable
    ? "available"
    : !projection.target_found
      ? "target_not_current"
      : projection.any_overdue
        ? "overdue_items"
        : projection.target_reserved
          ? "target_reserved"
          : "not_renewable";
  const options: LibraryActionOption[] = [
    {
      action_type: "visit_shelf",
      available: false,
      reason_code: "holding_not_visible",
      required_inputs: [],
    },
    {
      action_type: "open_online",
      available: projection.target_found && projection.viewer_visible,
      reason_code:
        projection.target_found && projection.viewer_visible
          ? "available"
          : "official_viewer_not_visible",
      required_inputs: [],
    },
    {
      action_type: "reserve",
      available: false,
      reason_code: targetReason,
      required_inputs: ["pickup_campus"],
    },
    {
      action_type: "intercampus_transfer",
      available: false,
      reason_code: targetReason,
      required_inputs: ["pickup_campus"],
    },
    {
      action_type: "renew",
      available: false,
      reason_code: renewable ? "write_form_not_verified" : renewReason,
      required_inputs: [],
    },
    {
      action_type: "purchase_request",
      available: false,
      reason_code: "write_form_not_verified",
      required_inputs: ["reason"],
    },
    {
      action_type: "ill_loan",
      available: false,
      reason_code: "write_form_not_verified",
      required_inputs: ["receiver", "payment", "fee"],
    },
    {
      action_type: "ill_copy",
      available: false,
      reason_code: "write_form_not_verified",
      required_inputs: ["receiver", "payment", "fee", "page_range"],
    },
  ];
  return {
    status: "known",
    projection: {
      schema_version: "v1",
      status: "known",
      resource_ref,
      options,
      data_classification: "personal",
      reason_code: null,
    },
  };
}

function materializeLibraryRecord(
  raw: LibraryRawRecord,
): LibraryMaterializedRecord | null {
  try {
    const resource_ref = createLibraryResourceRef(raw.record_id);
    const existingRecordId = libraryRecordRefs.get(resource_ref);
    if (existingRecordId !== undefined && existingRecordId !== raw.record_id) {
      // A hash collision must never make one public record resolve to another.
      return null;
    }
    libraryRecordRefs.set(resource_ref, raw.record_id);
    rememberLibraryActionRef(resource_ref);
    let relatedInvalid = false;
    const related_records = raw.related_records
      .map((related) => {
        try {
          const related_ref = createLibraryResourceRef(related.record_id);
          const existingRelatedId = libraryRecordRefs.get(related_ref);
          if (
            existingRelatedId !== undefined &&
            existingRelatedId !== related.record_id
          ) {
            relatedInvalid = true;
            return null;
          }
          libraryRecordRefs.set(related_ref, related.record_id);
          rememberLibraryActionRef(related_ref);
          return {
            resource_ref: related_ref,
            title: related.title,
            relation: related.relation,
          };
        } catch {
          relatedInvalid = true;
          return null;
        }
      })
      .filter(
        (
          item,
        ): item is {
          resource_ref: string;
          title: string;
          relation: "related" | "edition" | "translation" | "other";
        } => item !== null,
      );
    if (relatedInvalid) return null;
    const materialized = {
      resource_ref,
      title: raw.title,
      authors: raw.authors,
      subjects: raw.subjects,
      isbn: raw.isbn,
      publisher: raw.publisher,
      publication_year: raw.publication_year,
      format: raw.format,
      campus: raw.campus,
      url: raw.url,
      holdings:
        raw.holdings.length > 0
          ? raw.holdings
          : [
              {
                campus: "unknown",
                location: null,
                call_number: null,
                status: "unknown",
                due_date: null,
                reservation_count: null,
              },
            ],
      related_records,
    } as LibraryMaterializedRecord;
    libraryRecordSnapshots.set(resource_ref, materialized);
    return materialized;
  } catch {
    return null;
  }
}

async function readLibraryCatalogPage(
  tabId: number,
  mode: "search" | "record" | "browse",
  expectedRecordId?: string,
): Promise<LibraryPageProjection> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        func: readLibraryCatalogSearchInPage,
      });
      const value = injected?.result as LibraryPageProjection | undefined;
      if (!value) return libraryUnavailable("projection_missing");
      if (value.status === "known" && mode === "record" && expectedRecordId) {
        const matching = value.records.filter(
          (record) => record.record_id === expectedRecordId,
        );
        if (!matching.length) {
          return libraryUnavailable("record_structure_not_found");
        }
        const current = matching[0];
        if (!current) return libraryUnavailable("record_structure_not_found");
        return { status: "known", records: [current] };
      }
      if (value.status !== "loading") return value;
    } catch {
      return libraryUnavailable("projection_failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return libraryUnavailable("availability_loading_timeout");
}

async function createLibraryTab(url: string): Promise<number | null> {
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab.id === undefined) return null;
    await waitForTabReady(tab.id);
    return tab.id;
  } catch {
    return null;
  }
}

async function handleLibraryCatalogSearch(
  message: LibraryCatalogSearchMessage,
): Promise<LibraryCatalogSearchResponse> {
  if (
    !(await hasBrowserPermission(
      LIBRARY_OPAC_PERMISSION_PATTERN,
      LIBRARY_OPAC_ORIGIN,
    ))
  ) {
    return {
      status: "permission_required",
      origin: LIBRARY_OPAC_ORIGIN,
      pattern: LIBRARY_OPAC_PERMISSION_PATTERN,
    };
  }
  const tabId = await createLibraryTab(LIBRARY_OPAC_ENTRY_URL);
  if (tabId === null) return libraryUnavailable("entry_tab_create_failed");
  try {
    const submitted = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: submitLibraryCatalogSearchInPage,
      args: [
        {
          query: message.query,
          author: message.author ?? null,
          subject: message.subject ?? null,
          isbn: message.isbn ?? null,
          pub_year: message.pub_year ?? null,
          campus: message.campus ?? "any",
          format: message.format ?? "any",
        },
      ],
    });
    if (submitted[0]?.result?.status !== "submitted") {
      return libraryUnavailable(
        submitted[0]?.result?.reason_code ?? "search_submit_failed",
      );
    }
    await waitForTabReady(tabId);
    const projection = await readLibraryCatalogPage(tabId, "search");
    if (projection.status !== "known") {
      return libraryUnavailable(
        projection.status === "unavailable"
          ? projection.reason_code
          : "availability_loading_timeout",
      );
    }
    const materialized = projection.records.map(materializeLibraryRecord);
    if (materialized.some((item) => item === null)) {
      return libraryUnavailable("record_projection_invalid");
    }
    const items = materialized
      .filter((item): item is LibraryMaterializedRecord => item !== null)
      .slice(0, message.limit ?? 10);
    return {
      status: "known",
      projection: {
        schema_version: "v1",
        status: "known",
        query: message.query,
        items,
        reason_code: null,
      },
    };
  } catch {
    return libraryUnavailable("catalog_search_failed");
  } finally {
    await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}

async function handleLibraryItemRead(
  message: LibraryItemReadMessage,
): Promise<LibraryItemReadResponse> {
  if (!isLibraryResourceRef(message.resource_ref))
    return libraryUnavailable("invalid_resource_ref");
  if (
    !(await hasBrowserPermission(
      LIBRARY_OPAC_PERMISSION_PATTERN,
      LIBRARY_OPAC_ORIGIN,
    ))
  ) {
    return {
      status: "permission_required",
      origin: LIBRARY_OPAC_ORIGIN,
      pattern: LIBRARY_OPAC_PERMISSION_PATTERN,
    };
  }
  const recordId = libraryRecordRefs.get(message.resource_ref);
  if (!recordId) return libraryUnavailable("unknown_resource_ref");
  let tabId: number | null = null;
  try {
    tabId = await createLibraryTab(
      `${LIBRARY_OPAC_ORIGIN}${LIBRARY_RECORD_PATH_PREFIX}${encodeURIComponent(recordId)}`,
    );
    if (tabId === null) return libraryUnavailable("record_tab_create_failed");
    const projection = await readLibraryCatalogPage(tabId, "record", recordId);
    if (projection.status !== "known") {
      return libraryUnavailable(
        projection.status === "unavailable"
          ? projection.reason_code
          : "availability_loading_timeout",
      );
    }
    const record = projection.records[0];
    if (!record) return libraryUnavailable("record_projection_invalid");
    const item = materializeLibraryRecord(record);
    if (!item) return libraryUnavailable("record_projection_invalid");
    return {
      status: "known",
      projection: {
        schema_version: "v1",
        status: "known",
        resource_ref: message.resource_ref,
        item: { ...item, resource_ref: message.resource_ref },
        reason_code: null,
      },
    };
  } catch {
    return libraryUnavailable("item_read_failed");
  } finally {
    if (tabId !== null) await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}

type PublicLibraryActionSurface =
  | {
      status: "known";
      projection: Extract<LibraryActionPageProjection, { status: "known" }>;
      item: LibraryMaterializedRecord | null;
      official_url: string;
    }
  | { status: "reauth_required"; reason_code: string }
  | { status: "unavailable"; reason_code: string };

async function readPublicLibraryActionSurface(
  resourceRef: string,
  recordId: string,
): Promise<PublicLibraryActionSurface> {
  const officialUrl = `${LIBRARY_OPAC_ORIGIN}${LIBRARY_RECORD_PATH_PREFIX}${encodeURIComponent(recordId)}`;
  const tabId = await createLibraryTab(officialUrl);
  if (tabId === null) {
    return { status: "unavailable", reason_code: "record_tab_create_failed" };
  }
  try {
    const page = await readLibraryCatalogPage(tabId, "record", recordId);
    if (page.status !== "known") {
      return {
        status: "unavailable",
        reason_code:
          page.status === "unavailable"
            ? page.reason_code
            : "availability_loading_timeout",
      };
    }
    const raw = page.records[0];
    if (!raw)
      return {
        status: "unavailable",
        reason_code: "record_projection_invalid",
      };
    const item = materializeLibraryRecord(raw);
    if (!item || item.resource_ref !== resourceRef) {
      return { status: "unavailable", reason_code: "resource_ref_mismatch" };
    }
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: readLibraryActionOptionsInPage,
    });
    const projection = injected?.result as
      | LibraryActionPageProjection
      | undefined;
    if (!projection || projection.status === "unavailable") {
      return {
        status: "unavailable",
        reason_code:
          projection?.reason_code ?? "action_options_projection_invalid",
      };
    }
    if (projection.status === "reauth_required") {
      return { status: "reauth_required", reason_code: projection.reason_code };
    }
    return { status: "known", projection, item, official_url: officialUrl };
  } catch {
    return { status: "unavailable", reason_code: "action_options_read_failed" };
  } finally {
    await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}

function emptyLibraryActionPreviewOfficial(): LibraryActionPreviewOfficial {
  return {
    title: null,
    holdings: [],
    pickup_campus: null,
    current_due_date: null,
    resulting_due_date: null,
    receiver: null,
    payment: null,
    fee: null,
    page_range: null,
  };
}

async function readMyLibraryWriteSurface(
  target: MyLibraryResourceTarget,
): Promise<LibraryWriteSurfaceProjection> {
  if (!target.raw_id) {
    return { status: "unavailable", reason_code: "unresolved_resource_ref" };
  }
  const tab = await chrome.tabs.create({
    url: MY_LIBRARY_ENTRY_URL,
    active: false,
  });
  if (tab.id === undefined) {
    return { status: "unavailable", reason_code: "entry_tab_missing" };
  }
  let keepForLogin = false;
  try {
    await waitForTabReady(tab.id);
    const [clicked] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: clickMyLibraryMenuInPage,
      args: [MY_LIBRARY_MENU_IDS[target.scope]],
    });
    if (clicked?.result?.status === "reauth_required") {
      keepForLogin = true;
      await chrome.tabs.update(tab.id, { active: true });
      return { status: "reauth_required", reason_code: "login_required" };
    }
    if (clicked?.result?.status !== "clicked") {
      return { status: "unavailable", reason_code: "menu_result_missing" };
    }
    if (!(await waitForMyLibraryStatusPage(tab.id))) {
      return { status: "unavailable", reason_code: "status_page_timeout" };
    }
    const [validated] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: validateMyLibraryWriteSurfaceInPage,
      args: [target.scope, target.raw_id],
    });
    const projection = validated?.result as
      | LibraryWriteSurfaceProjection
      | undefined;
    return (
      projection ?? {
        status: "unavailable",
        reason_code: "write_surface_projection_invalid",
      }
    );
  } catch {
    return { status: "unavailable", reason_code: "write_surface_read_failed" };
  } finally {
    if (!keepForLogin) await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
}

async function handleLibraryActionPreview(
  message: LibraryActionPreviewMessage,
): Promise<LibraryActionPreviewResponse> {
  if (!isLiveLibraryActionRef(message.operation.resource_ref)) {
    return { status: "unavailable", reason_code: "unknown_resource_ref" };
  }
  const publicRecordId = libraryRecordRefs.get(message.operation.resource_ref);
  const personalTarget = myLibraryResourceRefs.get(
    message.operation.resource_ref,
  );
  if (publicRecordId && personalTarget) {
    return { status: "unavailable", reason_code: "ambiguous_resource_ref" };
  }
  if (!publicRecordId && !personalTarget) {
    return { status: "unavailable", reason_code: "unknown_resource_ref" };
  }
  const writeAction = !["visit_shelf", "open_online"].includes(
    message.operation.action_type,
  );
  if (personalTarget) {
    if (
      !(await hasBrowserPermission(
        MY_LIBRARY_PERMISSION_PATTERN,
        MY_LIBRARY_ORIGIN,
      ))
    ) {
      return {
        status: "permission_required",
        origin: MY_LIBRARY_ORIGIN,
        pattern: MY_LIBRARY_PERMISSION_PATTERN,
      };
    }
    if (writeAction) {
      const surface = await readMyLibraryWriteSurface(personalTarget);
      if (surface.status === "reauth_required") {
        return { status: "reauth_required", reason_code: surface.reason_code };
      }
      return {
        status: "unavailable",
        reason_code:
          surface.status === "validated"
            ? "write_form_not_verified"
            : surface.reason_code,
      };
    }
    return {
      status: "unavailable",
      reason_code: "personal_read_action_unsupported",
    };
  }
  if (
    !(await hasBrowserPermission(
      LIBRARY_OPAC_PERMISSION_PATTERN,
      LIBRARY_OPAC_ORIGIN,
    ))
  ) {
    return {
      status: "permission_required",
      origin: LIBRARY_OPAC_ORIGIN,
      pattern: LIBRARY_OPAC_PERMISSION_PATTERN,
    };
  }
  if (!publicRecordId) {
    return { status: "unavailable", reason_code: "unknown_resource_ref" };
  }
  const surface = await readPublicLibraryActionSurface(
    message.operation.resource_ref,
    publicRecordId,
  );
  if (surface.status === "reauth_required") {
    return { status: "reauth_required", reason_code: surface.reason_code };
  }
  if (surface.status === "unavailable") {
    return { status: "unavailable", reason_code: surface.reason_code };
  }
  if (writeAction) {
    return { status: "unavailable", reason_code: "write_form_not_verified" };
  }
  if (
    message.operation.action_type === "visit_shelf" &&
    (!surface.projection.holding_visible ||
      !surface.item?.holdings.some(
        (holding) =>
          holding.campus !== "unknown" &&
          Boolean(holding.location) &&
          Boolean(holding.call_number),
      ))
  ) {
    return {
      status: "unavailable",
      reason_code: "holding_projection_unparseable",
    };
  }
  if (
    message.operation.action_type === "open_online" &&
    !surface.projection.official_viewer_url
  ) {
    return {
      status: "unavailable",
      reason_code: "official_viewer_not_visible",
    };
  }
  const officialUrl =
    message.operation.action_type === "open_online"
      ? surface.projection.official_viewer_url
      : surface.official_url;
  if (!officialUrl)
    return { status: "unavailable", reason_code: "official_url_missing" };
  const previewId = newLibraryPreviewId();
  const fingerprint = libraryActionStateFingerprint({
    operation: message.operation.action_type,
    projection: surface.projection,
    title: surface.item?.title ?? null,
    holdings:
      surface.item?.holdings
        .filter(
          (holding) =>
            holding.campus !== "unknown" &&
            Boolean(holding.location) &&
            Boolean(holding.call_number),
        )
        .map((holding) => ({
          campus: holding.campus,
          location: holding.location,
          call_number: holding.call_number,
          status: holding.status,
        })) ?? [],
  });
  const previewInputs = readOnlyInputsForOperation(message.operation);
  if (!previewInputs) {
    return { status: "unavailable", reason_code: "write_form_not_verified" };
  }
  libraryActionPreviews.set(previewId, {
    tool_call_id: message.tool_call_id,
    operation: message.operation,
    inputs: previewInputs,
    resource_ref: message.operation.resource_ref,
    action_type: message.operation.action_type,
    exact_origin: LIBRARY_OPAC_ORIGIN,
    exact_path: new URL(surface.official_url).pathname,
    state_fingerprint: fingerprint,
    created_at: Date.now(),
    state: "pending",
    official_url: officialUrl,
  });
  return {
    status: "ready",
    preview_id: previewId,
    action_type: message.operation.action_type,
    official: {
      ...emptyLibraryActionPreviewOfficial(),
      title: surface.item?.title ?? null,
      holdings:
        surface.item?.holdings
          .filter(
            (holding) =>
              holding.campus !== "unknown" &&
              Boolean(holding.location) &&
              Boolean(holding.call_number),
          )
          .map((holding) => ({
            campus: holding.campus,
            location: holding.location,
            call_number: holding.call_number,
          })) ?? [],
    },
    inputs: previewInputs,
  };
}

async function handleLibraryActionSubmit(
  message: LibraryActionSubmitMessage,
): Promise<LibraryActionSubmitResponse> {
  const preview = libraryActionPreviews.get(message.preview_id);
  if (!preview || Date.now() - preview.created_at > LIBRARY_PREVIEW_TTL_MS) {
    libraryActionPreviews.delete(message.preview_id);
    return { status: "expired", reason_code: "preview_expired" };
  }
  if (preview.state !== "pending") {
    return { status: "expired", reason_code: "preview_already_consumed" };
  }
  if (!isLiveLibraryActionRef(preview.resource_ref)) {
    return { status: "expired", reason_code: "resource_ref_expired" };
  }
  if (message.tool_call_id !== preview.tool_call_id) {
    return { status: "unavailable", reason_code: "preview_binding_mismatch" };
  }
  if (
    !isLibraryActionEditableInputs(preview.action_type, message.inputs) ||
    message.inputs.action_type !== preview.action_type
  ) {
    return { status: "unavailable", reason_code: "invalid_editable_inputs" };
  }
  if (
    preview.action_type === "visit_shelf" ||
    preview.action_type === "open_online"
  ) {
    if (message.confirmation_label !== "公式ページを開く") {
      return { status: "unavailable", reason_code: "wrong_confirmation_label" };
    }
  } else if (message.confirmation_label !== "この内容で送信") {
    return { status: "unavailable", reason_code: "wrong_confirmation_label" };
  }
  // No live write surface has a verified submit/read-back path yet. A preview
  // for a write is never created, so this branch is an explicit guard against
  // forged or stale preview IDs and cannot submit a provider form.
  if (!["visit_shelf", "open_online"].includes(preview.action_type)) {
    return { status: "unavailable", reason_code: "write_form_not_verified" };
  }
  const recordId = libraryRecordRefs.get(preview.resource_ref);
  if (!recordId) {
    return { status: "unavailable", reason_code: "unknown_resource_ref" };
  }
  const surface = await readPublicLibraryActionSurface(
    preview.resource_ref,
    recordId,
  );
  if (surface.status === "reauth_required") {
    return { status: "unavailable", reason_code: surface.reason_code };
  }
  if (surface.status === "unavailable") {
    return { status: "unavailable", reason_code: surface.reason_code };
  }
  const currentFingerprint = libraryActionStateFingerprint({
    operation: preview.action_type,
    projection: surface.projection,
    title: surface.item?.title ?? null,
    holdings:
      surface.item?.holdings.map((holding) => ({
        campus: holding.campus,
        location: holding.location,
        call_number: holding.call_number,
        status: holding.status,
      })) ?? [],
  });
  const currentRecordUrl = new URL(surface.official_url);
  if (
    currentRecordUrl.origin !== preview.exact_origin ||
    currentRecordUrl.pathname !== preview.exact_path ||
    currentFingerprint !== preview.state_fingerprint
  ) {
    return { status: "unavailable", reason_code: "official_state_changed" };
  }
  if (
    preview.action_type === "visit_shelf" &&
    (!surface.projection.holding_visible ||
      !surface.item?.holdings.some(
        (holding) =>
          holding.campus !== "unknown" &&
          Boolean(holding.location) &&
          Boolean(holding.call_number),
      ))
  ) {
    return {
      status: "unavailable",
      reason_code: "holding_projection_unparseable",
    };
  }
  if (
    preview.action_type === "open_online" &&
    !surface.projection.official_viewer_url
  ) {
    return {
      status: "unavailable",
      reason_code: "official_viewer_not_visible",
    };
  }
  const latestUrl =
    preview.action_type === "open_online"
      ? surface.projection.official_viewer_url
      : surface.official_url;
  if (!latestUrl || latestUrl !== preview.official_url) {
    return { status: "unavailable", reason_code: "official_state_changed" };
  }
  preview.state = "consumed";
  try {
    const tab = await chrome.tabs.create({ url: latestUrl, active: true });
    if (tab.id === undefined) {
      return {
        status: "unavailable",
        reason_code: "official_tab_create_failed",
      };
    }
    return { status: "verified", action_type: preview.action_type };
  } catch {
    return { status: "unavailable", reason_code: "official_tab_create_failed" };
  }
}

async function handleLibraryActionOptions(
  message: LibraryActionOptionsMessage,
): Promise<LibraryActionOptionsResponse> {
  if (!isLibraryResourceRef(message.resource_ref)) {
    return {
      status: "known",
      projection: unavailableLibraryActionOptions(
        message.resource_ref,
        "invalid_resource_ref",
      ),
    };
  }
  if (!isLiveLibraryActionRef(message.resource_ref)) {
    return {
      status: "known",
      projection: unavailableLibraryActionOptions(
        message.resource_ref,
        "unknown_resource_ref",
      ),
    };
  }
  const publicRecordId = libraryRecordRefs.get(message.resource_ref);
  const personalTarget = myLibraryResourceRefs.get(message.resource_ref);
  if (publicRecordId && personalTarget) {
    return {
      status: "known",
      projection: unavailableLibraryActionOptions(
        message.resource_ref,
        "ambiguous_resource_ref",
      ),
    };
  }
  if (!publicRecordId && !personalTarget) {
    return {
      status: "known",
      projection: unavailableLibraryActionOptions(
        message.resource_ref,
        "unknown_resource_ref",
      ),
    };
  }
  if (publicRecordId) {
    if (
      !(await hasBrowserPermission(
        LIBRARY_OPAC_PERMISSION_PATTERN,
        LIBRARY_OPAC_ORIGIN,
      ))
    ) {
      return {
        status: "permission_required",
        origin: LIBRARY_OPAC_ORIGIN,
        pattern: LIBRARY_OPAC_PERMISSION_PATTERN,
      };
    }
    const tabId = await createLibraryTab(
      `${LIBRARY_OPAC_ORIGIN}${LIBRARY_RECORD_PATH_PREFIX}${encodeURIComponent(
        publicRecordId,
      )}`,
    );
    if (tabId === null) {
      return {
        status: "known",
        projection: unavailableLibraryActionOptions(
          message.resource_ref,
          "record_tab_create_failed",
        ),
      };
    }
    try {
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        func: readLibraryActionOptionsInPage,
      });
      const projection = injected?.result as
        | LibraryActionPageProjection
        | undefined;
      if (!projection || projection.status === "unavailable") {
        return {
          status: "known",
          projection: unavailableLibraryActionOptions(
            message.resource_ref,
            projection?.reason_code ?? "action_options_projection_invalid",
          ),
        };
      }
      if (projection.status === "reauth_required") {
        return {
          status: "reauth_required",
          reason_code: projection.reason_code,
        };
      }
      return publicLibraryActionOptions(message.resource_ref, projection);
    } catch {
      return {
        status: "known",
        projection: unavailableLibraryActionOptions(
          message.resource_ref,
          "action_options_read_failed",
        ),
      };
    } finally {
      await chrome.tabs.remove(tabId).catch(() => undefined);
    }
  }

  if (
    !(await hasBrowserPermission(
      MY_LIBRARY_PERMISSION_PATTERN,
      MY_LIBRARY_ORIGIN,
    ))
  ) {
    return {
      status: "permission_required",
      origin: MY_LIBRARY_ORIGIN,
      pattern: MY_LIBRARY_PERMISSION_PATTERN,
    };
  }
  if (!personalTarget?.raw_id) {
    return {
      status: "known",
      projection: unavailableLibraryActionOptions(
        message.resource_ref,
        "unresolved_resource_ref",
        "personal",
      ),
    };
  }
  const tab = await chrome.tabs.create({
    url: MY_LIBRARY_ENTRY_URL,
    active: false,
  });
  if (tab.id === undefined) {
    return {
      status: "known",
      projection: unavailableLibraryActionOptions(
        message.resource_ref,
        "entry_tab_missing",
        "personal",
      ),
    };
  }
  let keepForLogin = false;
  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const current = await chrome.tabs.get(tab.id);
      if (current.status === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const [clicked] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: clickMyLibraryMenuInPage,
      args: [MY_LIBRARY_MENU_IDS[personalTarget.scope]],
    });
    if (clicked?.result?.status === "reauth_required") {
      keepForLogin = true;
      await chrome.tabs.update(tab.id, { active: true });
      return {
        status: "reauth_required",
        reason_code: clicked.result.reason_code ?? "login_required",
      };
    }
    if (clicked?.result?.status !== "clicked") {
      return {
        status: "known",
        projection: unavailableLibraryActionOptions(
          message.resource_ref,
          clicked?.result?.reason_code ?? "menu_result_missing",
          "personal",
        ),
      };
    }
    if (!(await waitForMyLibraryStatusPage(tab.id))) {
      return {
        status: "known",
        projection: unavailableLibraryActionOptions(
          message.resource_ref,
          "status_page_timeout",
          "personal",
        ),
      };
    }
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readMyLibraryActionOptionsInPage,
      args: [personalTarget.scope, personalTarget.raw_id],
    });
    const projection = injected?.result as
      | MyLibraryActionPageProjection
      | undefined;
    if (!projection || projection.status === "unavailable") {
      return {
        status: "known",
        projection: unavailableLibraryActionOptions(
          message.resource_ref,
          projection?.reason_code ?? "action_options_projection_invalid",
          "personal",
        ),
      };
    }
    if (projection.status === "reauth_required") {
      return { status: "reauth_required", reason_code: projection.reason_code };
    }
    return myLibraryActionOptions(message.resource_ref, projection);
  } catch {
    return {
      status: "known",
      projection: unavailableLibraryActionOptions(
        message.resource_ref,
        "action_options_read_failed",
        "personal",
      ),
    };
  } finally {
    if (!keepForLogin) await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
}

async function handleLibraryCatalogBrowse(
  message: LibraryCatalogBrowseMessage,
): Promise<LibraryCatalogBrowseResponse> {
  if (
    !(await hasBrowserPermission(
      LIBRARY_OPAC_PERMISSION_PATTERN,
      LIBRARY_OPAC_ORIGIN,
    ))
  ) {
    return {
      status: "permission_required",
      origin: LIBRARY_OPAC_ORIGIN,
      pattern: LIBRARY_OPAC_PERMISSION_PATTERN,
    };
  }
  const tabId = await createLibraryTab(
    message.kind === "new_books"
      ? LIBRARY_NEW_BOOKS_URL
      : LIBRARY_LOAN_RANKING_URL,
  );
  if (tabId === null) return libraryUnavailable("browse_tab_create_failed");
  try {
    const projection = await readLibraryCatalogPage(tabId, "browse");
    if (projection.status !== "known") {
      return libraryUnavailable(
        projection.status === "unavailable"
          ? projection.reason_code
          : "availability_loading_timeout",
      );
    }
    let records = projection.records;
    if (message.campus && message.campus !== "any") {
      records = records.filter((item) => item.campus === message.campus);
      if (!records.length && projection.records.length > 0) {
        return libraryUnavailable("campus_filter_not_rendered");
      }
    }
    const materialized = records.map(materializeLibraryRecord);
    if (materialized.some((item) => item === null)) {
      return libraryUnavailable("record_projection_invalid");
    }
    const items = materialized
      .filter((item): item is LibraryMaterializedRecord => item !== null)
      .slice(0, message.limit ?? 10);
    return {
      status: "known",
      projection: {
        schema_version: "v1",
        status: "known",
        kind: message.kind,
        campus: message.campus ?? "any",
        items,
        reason_code: null,
      },
    };
  } catch {
    return libraryUnavailable("catalog_browse_failed");
  } finally {
    await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}

async function handleLibraryDiscoverySearch(
  message: LibraryDiscoverySearchMessage,
): Promise<LibraryDiscoverySearchResponse> {
  if (
    !(await hasBrowserPermission(
      LIBRARY_SIT_SEARCH_PERMISSION_PATTERN,
      LIBRARY_SIT_SEARCH_ORIGIN,
    ))
  ) {
    return {
      status: "permission_required",
      origin: LIBRARY_SIT_SEARCH_ORIGIN,
      pattern: LIBRARY_SIT_SEARCH_PERMISSION_PATTERN,
    };
  }
  const tabId = await createLibraryTab(LIBRARY_SIT_SEARCH_ENTRY_URL);
  if (tabId === null) return libraryUnavailable("discovery_tab_create_failed");
  try {
    const submitted = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: submitLibraryDiscoverySearchInPage,
      args: [message.query],
    });
    if (submitted[0]?.result?.status !== "submitted") {
      return libraryUnavailable(
        submitted[0]?.result?.reason_code ?? "discovery_submit_failed",
      );
    }
    await waitForTabReady(tabId);
    let projection: ReturnType<typeof readLibraryDiscoveryInPage> | undefined;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        func: readLibraryDiscoveryInPage,
      });
      projection = injected?.result as
        | ReturnType<typeof readLibraryDiscoveryInPage>
        | undefined;
      if (projection?.status !== "loading") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (projection?.status !== "known") {
      return libraryUnavailable(
        projection?.reason_code ?? "discovery_loading_timeout",
      );
    }
    const items: Array<{
      title: string;
      authors: string[];
      source_label: string | null;
      url: string;
      snippet: string | null;
      resource_ref: string | null;
    }> = [];
    for (const item of (projection.items ?? []).filter((candidate) =>
      isOfficialDiscoveryUrl(candidate.url),
    )) {
      let resource_ref: string | null = null;
      if (item.record_id) {
        try {
          resource_ref = createLibraryResourceRef(item.record_id);
        } catch {
          return libraryUnavailable("discovery_record_ref_invalid");
        }
        const existingRecordId = libraryRecordRefs.get(resource_ref);
        if (
          existingRecordId !== undefined &&
          existingRecordId !== item.record_id
        ) {
          return libraryUnavailable("resource_ref_collision");
        }
        libraryRecordRefs.set(resource_ref, item.record_id);
        rememberLibraryActionRef(resource_ref);
      }
      items.push({
        title: item.title,
        authors: item.authors,
        source_label: item.source_label,
        url: item.url,
        snippet: item.snippet,
        resource_ref,
      });
    }
    items.splice(message.limit ?? 10);
    return {
      status: "known",
      projection: {
        schema_version: "v1",
        status: "known",
        query: message.query,
        items,
        reason_code: null,
      },
    };
  } catch {
    return libraryUnavailable("discovery_search_failed");
  } finally {
    await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}

async function handleBrowserRead(
  message: import("../shared/messages").BrowserReadMessage,
): Promise<BrowserReadResponse> {
  const target = browserOrigin(message.url);
  if (!target) return unavailableBrowser("invalid_url");
  if (!(await hasBrowserPermission(target.pattern, target.origin))) {
    return { status: "permission_required", ...target };
  }

  const classification =
    target.origin === SYLLABUS_SEARCH_ORIGIN ? "public" : "personal";
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: message.url, active: false });
    tabId = tab.id;
    if (tabId === undefined) return unavailableBrowser("tab_create_failed");
    await waitForTabReady(tabId);
    if (typeof chrome.scripting?.executeScript !== "function") {
      return unavailableBrowser("scripting_unavailable");
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["browser-reader.js"],
    });
    const projection = await chrome.tabs.sendMessage(tabId, {
      type: "orbit-extract-browser-document",
      tool_call_id: message.tool_call_id,
      data_classification: classification,
    });
    if (
      typeof projection !== "object" ||
      projection === null ||
      (projection as { schema_version?: unknown }).schema_version !== "v1" ||
      (projection as { status?: unknown }).status !== "known" ||
      typeof (projection as { text?: unknown }).text !== "string" ||
      !Array.isArray((projection as { links?: unknown }).links)
    ) {
      return unavailableBrowser("invalid_projection");
    }
    return { status: "known", projection } as BrowserReadResponse;
  } catch {
    return unavailableBrowser("read_failed");
  } finally {
    if (tabId !== undefined) {
      try {
        await chrome.tabs.remove?.(tabId);
      } catch {
        // The temporary tab may already have been closed by the user.
      }
    }
  }
}

async function readSitrusGradeTextInPage(): Promise<
  | {
      status: "known";
      text_items: Array<{
        str: string;
        x: number;
        y: number;
        width: number;
        height: number;
      }>;
    }
  | { status: "unavailable"; reason_code: string }
> {
  try {
    const current = window as Window & {
      id_data?: { GakusekiNo?: unknown };
      gakuseiInfo?: Array<{ gakuseki_no?: unknown }>;
      pdfjsLib?: {
        getDocument: (source: { data: Uint8Array }) => {
          promise: Promise<{
            getPage: (pageNumber: number) => Promise<{
              getTextContent: () => Promise<{
                items: Array<Record<string, unknown>>;
              }>;
            }>;
          }>;
        };
      };
      "pdfjs-dist/build/pdf"?: {
        getDocument: (source: { data: Uint8Array }) => {
          promise: Promise<{
            getPage: (pageNumber: number) => Promise<{
              getTextContent: () => Promise<{
                items: Array<Record<string, unknown>>;
              }>;
            }>;
          }>;
        };
      };
    };
    const studentId =
      current.id_data?.GakusekiNo ??
      current.gakuseiInfo?.[0]?.gakuseki_no ??
      new URL(current.location.href).searchParams.get("N");
    if (
      typeof studentId !== "string" ||
      !/^[A-Za-z0-9_-]{3,32}$/u.test(studentId)
    ) {
      return { status: "unavailable", reason_code: "student_id_unavailable" };
    }
    const response = await fetch(
      `../../app/SITRUS/Seiseki?gakusei_no=${encodeURIComponent(studentId)}`,
      { credentials: "include" },
    );
    if (!response.ok) {
      return { status: "unavailable", reason_code: "grade_endpoint_failed" };
    }
    const raw: unknown = await response.json();
    const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (
      !payload ||
      typeof payload !== "object" ||
      (payload as { Result?: unknown }).Result !== "true" ||
      typeof (payload as { Message?: unknown }).Message !== "string"
    ) {
      return { status: "unavailable", reason_code: "grade_data_unavailable" };
    }
    const pdfjs = current.pdfjsLib ?? current["pdfjs-dist/build/pdf"];
    if (!pdfjs?.getDocument) {
      return { status: "unavailable", reason_code: "pdfjs_unavailable" };
    }
    const binary = atob((payload as { Message: string }).Message);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const pdf = await pdfjs.getDocument({ data: bytes }).promise;
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const text_items = content.items
      .map((item) => {
        const transform = Array.isArray(item.transform) ? item.transform : [];
        return {
          str: typeof item.str === "string" ? item.str : "",
          x: Number(transform[4]) || 0,
          y: Number(transform[5]) || 0,
          width: Number(item.width) || 0,
          height: Number(item.height) || 0,
        };
      })
      .filter((item) => item.str)
      .slice(0, 10_000);
    return { status: "known", text_items };
  } catch {
    return { status: "unavailable", reason_code: "grade_read_failed" };
  }
}

/** Read only the visible grade table on the exact SITRUS summary page. */
async function readSitrusGradeTableInPage(): Promise<
  | { status: "known"; rows: SitrusTableRow[] }
  | { status: "unavailable"; reason_code: string }
> {
  try {
    const rows: SitrusTableRow[] = [];
    const allowedGrades = new Set([
      "S",
      "A",
      "B",
      "C",
      "D",
      "F",
      "G",
      "N",
      "X",
      "#",
    ]);
    for (const row of Array.from(
      document.querySelectorAll('[role="grid"] [role="row"]'),
    )) {
      const cells = Array.from(row.querySelectorAll('[role="gridcell"]'))
        .map((cell) => (cell.textContent ?? "").replace(/\s+/gu, " ").trim())
        .filter(Boolean);
      if (cells.length < 3) continue;
      const result = cells[0] ?? "";
      const grade = (cells[1] ?? "").toUpperCase();
      const subject = cells[2] ?? "";
      if (result && subject && allowedGrades.has(grade)) {
        rows.push({ result, grade, subject });
      }
      if (rows.length >= 200) break;
    }
    return rows.length > 0
      ? { status: "known", rows }
      : { status: "unavailable", reason_code: "grade_table_not_visible" };
  } catch {
    return { status: "unavailable", reason_code: "grade_table_read_failed" };
  }
}

async function handleSitrusRead(
  message: import("../shared/messages").SitrusReadMessage,
): Promise<SitrusReadResponse> {
  if (!isSitrusGradeUrl(message.page_url)) {
    return { status: "unavailable", reason_code: "invalid_grade_url" };
  }
  const target = browserOrigin(message.page_url);
  if (!target || !(await hasBrowserPermission(target.pattern, target.origin))) {
    return {
      status: "permission_required",
      origin: target?.origin ?? "https://sitrus.sic.shibaura-it.ac.jp",
      pattern: target?.pattern ?? "https://sitrus.sic.shibaura-it.ac.jp/*",
    };
  }
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (
      !activeTab ||
      activeTab.id === undefined ||
      !isSitrusGradeUrl(activeTab.url)
    ) {
      return { status: "unavailable", reason_code: "grade_page_not_active" };
    }
    const requested = new URL(message.page_url);
    const active = new URL(activeTab.url ?? "");
    if (
      requested.origin !== active.origin ||
      requested.pathname !== active.pathname
    ) {
      return { status: "unavailable", reason_code: "grade_page_changed" };
    }
    const isSummaryPage =
      active.pathname === "/SITRUS/login/ShutokuTaniShukei.html";
    if (isSummaryPage) {
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        world: "MAIN",
        func: readSitrusGradeTableInPage,
      });
      const value = injected?.result;
      if (value?.status !== "known" || !Array.isArray(value.rows)) {
        return { status: "unavailable", reason_code: "invalid_projection" };
      }
      return {
        status: "known",
        projection: parseSitrusGradeTableProjection(
          value.rows,
          message.page_url,
        ),
      };
    }
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      world: "MAIN",
      func: readSitrusGradeTextInPage,
    });
    const value = injected?.result;
    if (!value) {
      return { status: "unavailable", reason_code: "invalid_projection" };
    }
    if (value.status !== "known") {
      return { status: "unavailable", reason_code: value.reason_code };
    }
    if (!Array.isArray(value.text_items)) {
      return { status: "unavailable", reason_code: "invalid_projection" };
    }
    return {
      status: "known",
      projection: parseSitrusGradeProjection(
        value.text_items,
        message.page_url,
      ),
    };
  } catch {
    return { status: "unavailable", reason_code: "grade_read_failed" };
  }
}

async function readMoodleDashboardInPage(): Promise<
  | { status: "known"; detail: MoodleLocalSnapshot }
  | { status: "unavailable"; reason_code: string }
> {
  try {
    const clean = (value: string | null | undefined, limit: number) =>
      (value ?? "").replace(/\s+/gu, " ").trim().slice(0, limit);
    const parseDueAt = (element: Element): string | null => {
      const raw =
        element.querySelector("time[datetime]")?.getAttribute("datetime") ??
        element.getAttribute("data-timestamp") ??
        element
          .querySelector("[data-timestamp]")
          ?.getAttribute("data-timestamp");
      if (!raw) return null;
      const date = /^\d{10,13}$/u.test(raw)
        ? new Date(Number(raw) * (raw.length === 10 ? 1000 : 1))
        : new Date(raw);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    };
    const courses = Array.from(
      document.querySelectorAll(
        '[data-region="course-content"] .coursename, a[href*="/moodle/course/view.php"]',
      ),
    )
      .map((element) => clean(element.textContent, 200))
      .filter(
        (value, index, values) =>
          value.length > 0 && values.indexOf(value) === index,
      )
      .slice(0, 1000);
    const upcoming = Array.from(
      document.querySelectorAll(
        '[data-region="event-list-content"] [data-region="event-list-item"], .timeline-event-list-item, [data-moodle-activity]',
      ),
    )
      .slice(0, 1000)
      .map((element) => {
        const title = clean(
          element.querySelector(
            '[data-region="event-name"], .event-name, [data-activity-title]',
          )?.textContent ?? element.getAttribute("data-activity-title"),
          300,
        );
        if (!title) return null;
        const course = clean(
          element.querySelector(
            '[data-region="event-course-name"], .course-name',
          )?.textContent,
          200,
        );
        const due_at = parseDueAt(element);
        return {
          title,
          course: course || null,
          due_at,
          overdue: due_at ? new Date(due_at).getTime() < Date.now() : false,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    const notificationText = clean(
      document.querySelector(
        '[data-region="notification-count"], [data-region="count-container"]',
      )?.textContent,
      20,
    );
    const unread = Number.parseInt(notificationText.replace(/\D/gu, ""), 10);
    return {
      status: "known",
      detail: {
        courses,
        upcoming,
        unread_notification_count: Number.isFinite(unread)
          ? Math.min(unread, 10_000)
          : 0,
      },
    };
  } catch {
    return { status: "unavailable", reason_code: "dashboard_read_failed" };
  }
}

async function findMoodleDashboardTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ url: `${MOODLE_DASHBOARD_URL}*` });
  return tabs.find((tab) => tab.id !== undefined) ?? null;
}

async function openMoodleEntry(): Promise<void> {
  const existing = await chrome.tabs.query({
    url: [`${MOODLE_DASHBOARD_URL}*`, `${MOODLE_LOGIN_URL}*`],
  });
  const tab = existing.find((candidate) => candidate.id !== undefined);
  if (tab?.id !== undefined) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined)
      await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: MOODLE_LOGIN_URL, active: true });
}

async function handleMoodleRead(): Promise<MoodleReadResponse> {
  if (!(await hasBrowserPermission(MOODLE_PERMISSION_PATTERN, MOODLE_ORIGIN))) {
    return {
      status: "permission_required",
      origin: MOODLE_ORIGIN,
      pattern: MOODLE_PERMISSION_PATTERN,
    };
  }
  try {
    const tab = await findMoodleDashboardTab();
    if (!tab?.id) {
      await openMoodleEntry();
      return { status: "reauth_required", reason_code: "dashboard_not_open" };
    }
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readMoodleDashboardInPage,
    });
    const value = injected?.result;
    if (value?.status !== "known") {
      return {
        status: "unavailable",
        reason_code: value?.reason_code ?? "invalid_projection",
      };
    }
    return {
      status: "known",
      detail: value.detail,
      projection: projectMoodleForAgent(value.detail),
    };
  } catch {
    return { status: "unavailable", reason_code: "moodle_read_failed" };
  }
}

interface MyLibraryPageRead {
  status: "known" | "reauth_required" | "unavailable";
  scope?: MyLibraryScope;
  kind?: "loans" | "reservations";
  loans?: MyLibraryLocalSnapshot["loans"];
  reservations?: MyLibraryLocalSnapshot["reservations"];
  items?: MyLibraryRawScopedItem[];
  reason_code?: string;
}

type MyLibraryRawScopedItem = MyLibraryScopedItem & { raw_id: string | null };

function clickMyLibraryMenuInPage(menuId: number): {
  status: "clicked" | "reauth_required" | "unavailable";
  reason_code?: string;
} {
  try {
    if (
      location.origin !== "https://library.shibaura-it.ac.jp" ||
      !["/portal/portal/selectLogin/", "/portal/sso/ssoLogin/"].includes(
        location.pathname,
      )
    ) {
      return { status: "unavailable", reason_code: "unexpected_entry_page" };
    }
    if (document.querySelector('input[type="password"]')) {
      return { status: "reauth_required", reason_code: "login_required" };
    }
    const marker = `,${menuId},`;
    const link = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a"),
    ).find((element) => {
      if (
        element.hasAttribute("hidden") ||
        element.getAttribute("aria-hidden") === "true"
      ) {
        return false;
      }
      const handler = element.getAttribute("onclick") ?? "";
      return handler.includes("doSelectMainMenu") && handler.includes(marker);
    });
    if (!link) {
      return { status: "unavailable", reason_code: "menu_not_found" };
    }
    link.click();
    return { status: "clicked" };
  } catch {
    return { status: "unavailable", reason_code: "menu_click_failed" };
  }
}

function readMyLibraryStatusInPage(scope: MyLibraryScope): MyLibraryPageRead {
  const clean = (value: string | null | undefined, limit: number): string =>
    (value ?? "").replace(/\s+/gu, " ").trim().slice(0, limit);
  const isVisible = (element: Element): boolean => {
    for (
      let current: Element | null = element;
      current;
      current = current.parentElement
    ) {
      if (
        current.hasAttribute("hidden") ||
        current.getAttribute("aria-hidden") === "true"
      ) {
        return false;
      }
      const style = (current.getAttribute("style") ?? "")
        .replace(/\s+/gu, "")
        .toLowerCase();
      const className = current.getAttribute("class") ?? "";
      if (
        /(?:^|;)display:none(?:;|$)/u.test(style) ||
        /(?:^|;)visibility:(?:hidden|collapse)(?:;|$)/u.test(style) ||
        /(?:^|;)opacity:0(?:;|$)/u.test(style) ||
        /(?:^|\s)(?:hidden|hide|d-none|invisible|is-hidden|visually-hidden)(?:\s|$)/u.test(
          className,
        )
      ) {
        return false;
      }
      if (typeof getComputedStyle === "function") {
        const computed = getComputedStyle(current);
        if (
          computed.display === "none" ||
          computed.visibility === "hidden" ||
          computed.visibility === "collapse" ||
          computed.opacity === "0"
        ) {
          return false;
        }
      }
    }
    return true;
  };
  const visibleLibraryText = (value: Element | null | undefined): string => {
    if (!value) return "";
    const clone = value.cloneNode(true) as Element;
    clone
      .querySelectorAll("[hidden], [aria-hidden='true']")
      .forEach((element) => {
        element.remove();
      });
    clone.querySelectorAll("[style]").forEach((element) => {
      const style = (element.getAttribute("style") ?? "")
        .replace(/\s+/gu, "")
        .toLowerCase();
      if (
        /(?:^|;)display:none(?:;|$)/u.test(style) ||
        /(?:^|;)visibility:(?:hidden|collapse)(?:;|$)/u.test(style) ||
        /(?:^|;)opacity:0(?:;|$)/u.test(style) ||
        /(?:^|\s)(?:hidden|hide|d-none|invisible|is-hidden|visually-hidden)(?:\s|$)/u.test(
          element.getAttribute("class") ?? "",
        )
      ) {
        element.remove();
      }
    });
    clone.querySelectorAll("[class]").forEach((element) => {
      if (
        /(?:^|\s)(?:hidden|hide|d-none|invisible|is-hidden|visually-hidden)(?:\s|$)/u.test(
          element.getAttribute("class") ?? "",
        )
      ) {
        element.remove();
      }
    });
    return clone.textContent ?? "";
  };
  const isEmptyPlaceholderRow = (row: Element): boolean => {
    const hasEmptyMarker = (element: Element): boolean =>
      /(?:^|\s)(?:dataTables_empty|empty|no-data)(?:\s|$)/u.test(
        element.getAttribute("class") ?? "",
      );
    const cells = Array.from(row.children).filter(
      (cell): cell is Element =>
        cell.tagName.toLowerCase() === "td" ||
        cell.tagName.toLowerCase() === "th",
    );
    const hasActualCellData = cells.some(
      (cell) => !hasEmptyMarker(cell) && clean(visibleLibraryText(cell), 1000),
    );
    if (hasActualCellData) return false;
    return hasEmptyMarker(row) || cells.some(hasEmptyMarker);
  };
  const normalizeDate = (value: string): string | null => {
    const match = value.match(/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})/u);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return `${year.toString().padStart(4, "0")}-${month
      .toString()
      .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
  };
  const splitTitleAuthor = (
    value: string,
  ): { title: string; author: string | null } | null => {
    const parts = clean(value, 500).split(/\s+\/\s+/u);
    const title = clean(parts.shift(), 300);
    if (!title) return null;
    const author = clean(parts.join(" / "), 200);
    return { title, author: author || null };
  };
  const valueForLabel = (row: Element, label: string): Element | null => {
    for (const cell of Array.from(row.querySelectorAll("td"))) {
      if (!isVisible(cell)) continue;
      const value = cell.querySelector("dd");
      if (
        clean(visibleLibraryText(cell.querySelector("dt")), 100) === label &&
        value &&
        isVisible(value)
      ) {
        return value;
      }
    }
    return null;
  };
  const valueForLabels = (
    row: Element,
    labels: readonly string[],
  ): Element | null => {
    for (const label of labels) {
      const value = valueForLabel(row, label);
      if (value) return value;
    }
    for (const heading of Array.from(row.querySelectorAll("th"))) {
      if (labels.includes(clean(visibleLibraryText(heading), 100))) {
        const sibling = heading.nextElementSibling;
        return sibling && isVisible(sibling) ? sibling : null;
      }
    }
    return null;
  };
  const rawIdForRow = (
    row: Element,
    lookup: (
      row: Element,
      labels: readonly string[],
    ) => Element | null = valueForLabels,
  ): string | null => {
    const value = lookup(row, [
      "資料ID",
      "資料番号",
      "受付番号",
      "依頼番号",
      "申請番号",
      "整理番号",
      "ILL番号",
    ]);
    const rawId = clean(visibleLibraryText(value), 200);
    return rawId || null;
  };

  try {
    if (
      location.origin !== "https://library.shibaura-it.ac.jp" ||
      location.pathname !==
        "/portal/admin/selectMenu/doSelectPublicUseMainMenu" ||
      location.search !== "" ||
      location.hash !== ""
    ) {
      return { status: "unavailable", reason_code: "unexpected_page" };
    }
    if (document.querySelector('input[type="password"]')) {
      return { status: "reauth_required", reason_code: "login_required" };
    }
    const loanTable =
      scope === "current_loans" ? document.querySelector("#lendList") : null;
    if (loanTable && isVisible(loanTable)) {
      const today = new Date();
      const todayKey = `${today.getFullYear().toString().padStart(4, "0")}-${(
        today.getMonth() + 1
      )
        .toString()
        .padStart(2, "0")}-${today.getDate().toString().padStart(2, "0")}`;
      const visibleLoanRows = Array.from(
        loanTable.querySelectorAll("tbody tr"),
      ).filter((row) => isVisible(row));
      if (visibleLoanRows.length === 0) {
        return { status: "unavailable", reason_code: "scope_row_unparseable" };
      }
      const parsedLoanRows = visibleLoanRows
        .filter((row) => !isEmptyPlaceholderRow(row))
        .map((row) => {
          const titleAuthor = splitTitleAuthor(
            visibleLibraryText(valueForLabel(row, "書名 / 著者名")),
          );
          if (!titleAuthor) return null;
          const dueDate = normalizeDate(
            visibleLibraryText(valueForLabel(row, "貸出返却期限延長回数")),
          );
          if (!dueDate) return null;
          const checkbox = row.querySelector<HTMLInputElement>(
            'input[type="checkbox"][name="checkBoxBookNumber"]',
          );
          const loan = {
            ...titleAuthor,
            due_date: dueDate,
            renewable: Boolean(checkbox && !checkbox.disabled),
            overdue: dueDate !== null && dueDate < todayKey,
          };
          return {
            loan,
            item: {
              ...titleAuthor,
              status: loan.overdue ? "overdue" : "loaned",
              due_date: dueDate,
              renewable: loan.renewable,
              activity_date: null,
              request_type: null,
              raw_id: rawIdForRow(row),
            } satisfies MyLibraryRawScopedItem,
          };
        });
      if (parsedLoanRows.some((item) => item === null)) {
        return { status: "unavailable", reason_code: "scope_row_unparseable" };
      }
      const loanRows = parsedLoanRows
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .slice(0, 1000);
      return {
        status: "known",
        scope,
        kind: "loans",
        loans: loanRows.map(({ loan }) => loan),
        items: loanRows.map(({ item }) => item),
      };
    }
    const reservationTable =
      scope === "reservations"
        ? document.querySelector("#reservationList")
        : null;
    if (reservationTable && isVisible(reservationTable)) {
      const visibleReservationRows = Array.from(
        reservationTable.querySelectorAll("tbody tr"),
      ).filter((row) => isVisible(row));
      if (visibleReservationRows.length === 0) {
        return { status: "unavailable", reason_code: "scope_row_unparseable" };
      }
      const parsedReservationRows = visibleReservationRows
        .filter((row) => !isEmptyPlaceholderRow(row))
        .map((row) => {
          const titleAuthor = splitTitleAuthor(
            visibleLibraryText(valueForLabel(row, "書名 / 著者名")),
          );
          if (!titleAuthor) return null;
          const holdUntil = normalizeDate(
            visibleLibraryText(valueForLabel(row, "受取館取置期限日")),
          );
          const status =
            clean(visibleLibraryText(valueForLabel(row, "状態")), 100) || null;
          if (!holdUntil || !status) return null;
          return {
            reservation: {
              ...titleAuthor,
              hold_until: holdUntil,
              status,
            },
            item: {
              ...titleAuthor,
              status,
              due_date: holdUntil,
              renewable: null,
              activity_date: null,
              request_type: "reservation",
              raw_id: rawIdForRow(row),
            } satisfies MyLibraryRawScopedItem,
          };
        });
      if (parsedReservationRows.some((item) => item === null)) {
        return { status: "unavailable", reason_code: "scope_row_unparseable" };
      }
      const reservationRows = parsedReservationRows
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .slice(0, 1000);
      return {
        status: "known",
        scope,
        kind: "reservations",
        reservations: reservationRows.map(({ reservation }) => reservation),
        items: reservationRows.map(({ item }) => item),
      };
    }
    if (scope !== "current_loans" && scope !== "reservations") {
      const markers: Record<MyLibraryScope, string[]> = {
        current_loans: ["貸出状況確認"],
        reservations: ["予約状況確認"],
        loan_history: ["貸出履歴一覧"],
        purchase_requests: ["購入依頼状況", "図書購入リクエスト"],
        interlibrary_requests: [
          "ILL（文献複写・貸借）依頼",
          "文献複写・図書貸借申込",
        ],
      };
      const requiredColumns: Record<
        Exclude<MyLibraryScope, "current_loans" | "reservations">,
        readonly (readonly string[])[]
      > = {
        loan_history: [
          ["書名 / 著者名", "書名", "タイトル", "資料名"],
          ["貸出日"],
          ["状態", "ステータス", "処理状況"],
        ],
        purchase_requests: [
          ["書名 / 著者名", "書名", "タイトル", "資料名"],
          ["状態", "ステータス", "処理状況"],
          ["依頼日", "申請日"],
          ["依頼種別", "申請種別", "種類", "区分"],
        ],
        interlibrary_requests: [
          ["書名 / 著者名", "書名", "タイトル", "資料名"],
          ["状態", "ステータス", "処理状況"],
          ["依頼日", "受付日"],
          ["依頼区分", "依頼種別", "種類", "区分"],
        ],
      };
      const markerList = markers[scope];
      const markerTable = Array.from(document.querySelectorAll("table")).find(
        (candidate) => {
          if (!isVisible(candidate)) return false;
          const contextText = clean(
            Array.from(candidate.querySelectorAll("caption, thead"))
              .map((element) => visibleLibraryText(element))
              .concat(
                candidate.previousElementSibling
                  ? [visibleLibraryText(candidate.previousElementSibling)]
                  : [],
              )
              .join(" ") || visibleLibraryText(candidate.querySelector("tr")),
            1000,
          );
          return markerList.some((marker) => contextText.includes(marker));
        },
      );
      if (!markerTable) {
        return { status: "unavailable", reason_code: "scope_table_not_found" };
      }
      const table = [markerTable].find((candidate) => {
        const headerLabels = Array.from(
          candidate.querySelectorAll("thead th, thead td"),
        )
          .map((cell) => clean(visibleLibraryText(cell), 100))
          .filter(Boolean);
        return requiredColumns[scope].every((alternatives) =>
          alternatives.some((label) => headerLabels.includes(label)),
        );
      });
      if (!table) {
        const hasNonEmptyRow = Array.from(
          markerTable.querySelectorAll("tbody tr, tr"),
        ).some(
          (row) =>
            isVisible(row) &&
            !row.querySelector(".dataTables_empty, .empty, .no-data") &&
            clean(visibleLibraryText(row), 1000),
        );
        return {
          status: "unavailable",
          reason_code: hasNonEmptyRow
            ? "scope_row_unparseable"
            : "scope_table_not_found",
        };
      }
      const headerRow = Array.from(table.querySelectorAll("tr")).find(
        (row) => isVisible(row) && row.querySelector("th"),
      );
      const columnLabels = headerRow
        ? Array.from(headerRow.querySelectorAll("th, td")).map((cell) =>
            clean(visibleLibraryText(cell), 100),
          )
        : [];
      const tableValueForLabels = (
        row: Element,
        labels: readonly string[],
      ): Element | null => {
        const structured = valueForLabels(row, labels);
        if (structured) return structured;
        const index = columnLabels.findIndex((label) => labels.includes(label));
        if (index < 0) return null;
        const cells = Array.from(row.children).filter(
          (cell): cell is Element =>
            cell.tagName.toLowerCase() === "td" ||
            cell.tagName.toLowerCase() === "th",
        );
        const value = cells[index];
        return value && isVisible(value) ? value : null;
      };
      const dateFor = (row: Element, labels: string[]): string | null =>
        normalizeDate(visibleLibraryText(tableValueForLabels(row, labels)));
      const visibleRows = Array.from(
        table.querySelectorAll("tbody tr, tr"),
      ).filter((row) => row !== headerRow && isVisible(row));
      if (visibleRows.length === 0) {
        return { status: "unavailable", reason_code: "scope_row_unparseable" };
      }
      const parsedItems = visibleRows
        .filter((row) => !isEmptyPlaceholderRow(row))
        .map((row): MyLibraryRawScopedItem | null => {
          const titleAuthor = splitTitleAuthor(
            visibleLibraryText(
              tableValueForLabels(row, [
                "書名 / 著者名",
                "書名",
                "タイトル",
                "資料名",
              ]),
            ),
          );
          if (!titleAuthor) return null;
          const renewal = Array.from(row.querySelectorAll("button, a")).find(
            (element) =>
              /延長|更新/iu.test(clean(visibleLibraryText(element), 100)),
          );
          const status =
            clean(
              visibleLibraryText(
                tableValueForLabels(row, ["状態", "ステータス", "処理状況"]),
              ),
              100,
            ) || null;
          const activityDate = dateFor(
            row,
            scope === "loan_history"
              ? ["貸出日"]
              : scope === "purchase_requests"
                ? ["申請日", "依頼日"]
                : ["受付日", "依頼日"],
          );
          const requestType =
            clean(
              visibleLibraryText(
                tableValueForLabels(row, [
                  "依頼種別",
                  "申請種別",
                  "種類",
                  "区分",
                ]),
              ),
              100,
            ) || null;
          if (!status || !activityDate) return null;
          if (scope !== "loan_history" && !requestType) return null;
          return {
            ...titleAuthor,
            status,
            due_date: dateFor(row, ["返却期限", "返却日", "期限"]),
            renewable: renewal ? !renewal.hasAttribute("disabled") : null,
            activity_date: activityDate,
            request_type: requestType,
            raw_id: rawIdForRow(row, tableValueForLabels),
          };
        });
      if (parsedItems.some((item) => item === null)) {
        return { status: "unavailable", reason_code: "scope_row_unparseable" };
      }
      const items = parsedItems
        .filter((item): item is MyLibraryRawScopedItem => item !== null)
        .slice(0, 1000);
      return { status: "known", scope, items };
    }
    return { status: "unavailable", reason_code: "status_table_not_found" };
  } catch {
    return { status: "unavailable", reason_code: "status_read_failed" };
  }
}

async function waitForMyLibraryStatusPage(
  tabId: number,
): Promise<chrome.tabs.Tab | null> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete" && tab.url) {
        const url = new URL(tab.url);
        if (
          url.origin === MY_LIBRARY_ORIGIN &&
          url.pathname === MY_LIBRARY_STATUS_PATH &&
          url.search === "" &&
          url.hash === ""
        ) {
          return tab;
        }
      }
    } catch {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function readMyLibrarySection(
  scope: MyLibraryScope,
): Promise<MyLibraryPageRead> {
  const tab = await chrome.tabs.create({
    url: MY_LIBRARY_ENTRY_URL,
    active: false,
  });
  if (tab.id === undefined) {
    return { status: "unavailable", reason_code: "entry_tab_missing" };
  }
  let keepForLogin = false;
  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const current = await chrome.tabs.get(tab.id);
      if (current.status === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const [clicked] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: clickMyLibraryMenuInPage,
      args: [MY_LIBRARY_MENU_IDS[scope]],
    });
    if (clicked?.result?.status === "reauth_required") {
      keepForLogin = true;
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return {
        status: "reauth_required",
        reason_code: clicked.result.reason_code,
      };
    }
    if (clicked?.result?.status !== "clicked") {
      return {
        status: "unavailable",
        reason_code: clicked?.result?.reason_code ?? "menu_result_missing",
      };
    }
    if (!(await waitForMyLibraryStatusPage(tab.id))) {
      return { status: "unavailable", reason_code: "status_page_timeout" };
    }
    const [read] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readMyLibraryStatusInPage,
      args: [scope],
    });
    return (
      read?.result ?? {
        status: "unavailable",
        reason_code: "status_result_missing",
      }
    );
  } catch {
    return { status: "unavailable", reason_code: "my_library_read_failed" };
  } finally {
    if (!keepForLogin) {
      await chrome.tabs.remove(tab.id).catch(() => undefined);
    }
  }
}

function projectMyLibraryPageItems(
  scope: MyLibraryScope,
  rawItems: MyLibraryRawScopedItem[],
): MyLibraryScopedItem[] {
  return rawItems.map((rawItem, index) => {
    const raw_id = rawItem.raw_id;
    const safeItem: MyLibraryScopedItem = {
      title: rawItem.title,
      author: rawItem.author,
      status: rawItem.status,
      due_date: rawItem.due_date,
      renewable: rawItem.renewable,
      activity_date: rawItem.activity_date,
      request_type: rawItem.request_type,
    };
    if (typeof safeItem.title !== "string" || !safeItem.title.trim()) {
      throw new Error("My Library title is unavailable.");
    }
    const normalizedRawId =
      typeof raw_id === "string" ? raw_id.trim() || null : null;
    const key = normalizedRawId
      ? `${scope}|raw|${encodeURIComponent(normalizedRawId)}`
      : `${scope}|unresolved|${index}`;
    const resourceRef = createLibraryResourceRef(key);
    const previousKey = myLibraryResourceRefKeys.get(resourceRef);
    const previousTarget = myLibraryResourceRefs.get(resourceRef);
    const target: MyLibraryResourceTarget = {
      scope,
      raw_id: normalizedRawId,
    };
    if (
      (previousKey !== undefined && previousKey !== key) ||
      (previousTarget !== undefined &&
        (previousTarget.scope !== target.scope ||
          previousTarget.raw_id !== target.raw_id))
    ) {
      throw new Error("My Library resource_ref collision detected.");
    }
    myLibraryResourceRefKeys.set(resourceRef, key);
    myLibraryResourceRefs.set(resourceRef, target);
    rememberLibraryActionRef(resourceRef);
    return { ...safeItem, resource_ref: resourceRef };
  });
}

async function openMyLibraryEntry(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: `${MY_LIBRARY_ORIGIN}/*` });
  const existing = tabs.find((tab) => tab.id !== undefined);
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: MY_LIBRARY_ENTRY_URL, active: true });
}

async function handleMyLibraryRead(
  message: MyLibraryReadMessage,
): Promise<MyLibraryReadResponse> {
  if (
    !(await hasBrowserPermission(
      MY_LIBRARY_PERMISSION_PATTERN,
      MY_LIBRARY_ORIGIN,
    ))
  ) {
    return {
      status: "permission_required",
      origin: MY_LIBRARY_ORIGIN,
      pattern: MY_LIBRARY_PERMISSION_PATTERN,
    };
  }
  // Legacy connection checks did not carry a scope and expected both
  // aggregate sections. Keep that read path for old side-panel builds while
  // every new Agent call reads exactly one requested scope.
  if (message.scope === undefined) {
    const loanPage = await readMyLibrarySection("current_loans");
    if (loanPage.status !== "known" || loanPage.kind !== "loans") {
      return loanPage.status === "reauth_required"
        ? {
            status: "reauth_required",
            reason_code: loanPage.reason_code ?? "login_required",
          }
        : {
            status: "unavailable",
            reason_code: loanPage.reason_code ?? "loan_page_unavailable",
          };
    }
    const reservationPage = await readMyLibrarySection("reservations");
    if (
      reservationPage.status !== "known" ||
      reservationPage.kind !== "reservations"
    ) {
      return reservationPage.status === "reauth_required"
        ? {
            status: "reauth_required",
            reason_code: reservationPage.reason_code ?? "login_required",
          }
        : {
            status: "unavailable",
            reason_code:
              reservationPage.reason_code ?? "reservation_page_unavailable",
          };
    }
    const detail: MyLibraryLocalSnapshot = {
      loans: loanPage.loans ?? [],
      reservations: reservationPage.reservations ?? [],
    };
    return {
      status: "known",
      detail,
      projection: projectMyLibraryForAgent(detail),
    };
  }
  const scope = message.scope;
  const page = await readMyLibrarySection(scope);
  if (page.status !== "known") {
    return page.status === "reauth_required"
      ? {
          status: "reauth_required",
          reason_code: page.reason_code ?? "login_required",
        }
      : {
          status: "unavailable",
          reason_code: page.reason_code ?? "scope_page_unavailable",
        };
  }
  let projectedItems: MyLibraryScopedItem[];
  try {
    projectedItems = projectMyLibraryPageItems(scope, page.items ?? []);
  } catch {
    return { status: "unavailable", reason_code: "resource_ref_collision" };
  }
  const detail: MyLibraryLocalSnapshot = {
    loans: scope === "current_loans" ? (page.loans ?? []) : [],
    reservations: scope === "reservations" ? (page.reservations ?? []) : [],
  };
  if (scope === "current_loans") {
    detail.loans = (page.loans ?? []).map((loan, index) => ({
      ...loan,
      resource_ref: projectedItems[index]?.resource_ref,
    }));
  }
  if (scope === "reservations") {
    detail.reservations = (page.reservations ?? []).map(
      (reservation, index) => ({
        ...reservation,
        resource_ref: projectedItems[index]?.resource_ref,
      }),
    );
  }
  if (scope === "loan_history") detail.loan_history = projectedItems;
  if (scope === "purchase_requests") detail.purchase_requests = projectedItems;
  if (scope === "interlibrary_requests") {
    detail.interlibrary_requests = projectedItems;
  }
  const options: MyLibraryReadOptions = {
    scope,
    query: message.query ?? null,
    offset: message.offset ?? 0,
    limit: message.limit ?? 20,
  };
  try {
    const projection = projectMyLibraryForAgent(detail, options);
    if (projection.status !== "known") {
      return {
        status: "unavailable",
        reason_code: projection.reason_code ?? "projection_failed",
      };
    }
    return { status: "known", detail, projection };
  } catch {
    return { status: "unavailable", reason_code: "resource_ref_collision" };
  }
}

async function readCastDashboardInPage(): Promise<
  | { status: "known"; detail: CastLocalSnapshot }
  | { status: "reauth_required"; reason_code: string }
  | { status: "unavailable"; reason_code: string }
> {
  try {
    const origin = "https://shibaura.pita.services";
    const current = new URL(location.href);
    if (current.origin !== origin) {
      return { status: "unavailable", reason_code: "unexpected_origin" };
    }
    if (
      current.pathname === "/career/session_timeout" ||
      current.pathname === "/career/login" ||
      document.querySelector('input[type="password"]')
    ) {
      return { status: "reauth_required", reason_code: "login_required" };
    }
    if (current.pathname !== "/career/top/student") {
      return { status: "unavailable", reason_code: "unexpected_path" };
    }
    const clean = (value: string | null | undefined, limit: number) =>
      (value ?? "").replace(/\s+/gu, " ").trim().slice(0, limit);
    const count = (selector: string): number | null => {
      const value = clean(document.querySelector(selector)?.textContent, 20);
      if (!/^\d+$/u.test(value)) return null;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) && parsed <= 100_000 ? parsed : null;
    };
    const date = (value: string): string | null => {
      const match = value.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/u);
      if (!match) return null;
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const parsed = new Date(Date.UTC(year, month - 1, day));
      if (
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() !== month - 1 ||
        parsed.getUTCDate() !== day
      ) {
        return null;
      }
      return `${year.toString().padStart(4, "0")}-${month
        .toString()
        .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
    };
    const newJobCount = count("#job_offer_count");
    const newInternshipCount = count("#internship_count");
    const newEventCount = count("#company_session_count");
    if (
      newJobCount === null ||
      newInternshipCount === null ||
      newEventCount === null
    ) {
      return { status: "unavailable", reason_code: "structure_changed" };
    }
    const notices = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(
        'a[href^="/career/notice_detail_view"]:not(.notice-detail)',
      ),
    )
      .map((link) => {
        const title = clean(link.textContent, 300);
        if (!title) return null;
        const row = link.closest(".row");
        if (!row) return null;
        return {
          title,
          published_date: date(row?.textContent ?? ""),
        };
      })
      .filter(
        (item): item is { title: string; published_date: string | null } =>
          item !== null,
      )
      .slice(0, 1000);
    const hasCounselingReservation = Array.from(
      document.querySelectorAll(".myCareerNotice"),
    ).some((element) => {
      const text = clean((element.closest(".row") ?? element).textContent, 500);
      return /(相談|面談)/u.test(text) && /予約/u.test(text);
    });
    return {
      status: "known",
      detail: {
        notices,
        new_job_count: newJobCount,
        new_internship_count: newInternshipCount,
        new_event_count: newEventCount,
        has_counseling_reservation: hasCounselingReservation,
      },
    };
  } catch {
    return { status: "unavailable", reason_code: "dashboard_read_failed" };
  }
}

function isCastEntryTab(tab: chrome.tabs.Tab): boolean {
  if (!tab.url || tab.id === undefined) return false;
  try {
    const url = new URL(tab.url);
    return (
      url.origin === CAST_ORIGIN &&
      ["/career", "/career/top/student", "/career/session_timeout"].includes(
        url.pathname,
      )
    );
  } catch {
    return false;
  }
}

async function openCastEntry(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: `${CAST_ORIGIN}/*` });
  const existing = tabs.find(isCastEntryTab);
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    if (existing.url !== CAST_TOP_URL) {
      await chrome.tabs.update(existing.id, { url: CAST_ENTRY_URL });
    }
    return;
  }
  await chrome.tabs.create({ url: CAST_ENTRY_URL, active: true });
}

async function handleCastRead(): Promise<CastReadResponse> {
  if (!(await hasBrowserPermission(CAST_PERMISSION_PATTERN, CAST_ORIGIN))) {
    return {
      status: "permission_required",
      origin: CAST_ORIGIN,
      pattern: CAST_PERMISSION_PATTERN,
    };
  }
  try {
    const tabs = await chrome.tabs.query({ url: `${CAST_ORIGIN}/*` });
    const tab = tabs.find(
      (candidate) =>
        candidate.url === CAST_TOP_URL && candidate.id !== undefined,
    );
    if (!tab?.id) {
      await openCastEntry();
      return { status: "reauth_required", reason_code: "dashboard_not_open" };
    }
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readCastDashboardInPage,
    });
    const value = injected?.result;
    if (value?.status === "reauth_required") return value;
    if (value?.status !== "known") {
      return {
        status: "unavailable",
        reason_code: value?.reason_code ?? "invalid_projection",
      };
    }
    return {
      status: "known",
      detail: value.detail,
      projection: projectCastForAgent(value.detail),
    };
  } catch {
    return { status: "unavailable", reason_code: "cast_read_failed" };
  }
}

function isTrustedExtensionPageSender(sender: chrome.runtime.MessageSender) {
  if (sender.id !== undefined && sender.id !== chrome.runtime.id) {
    return false;
  }
  if (sender.tab === undefined) {
    return true;
  }
  if (!sender.url) {
    return false;
  }
  try {
    const url = new URL(sender.url);
    return (
      url.protocol === "chrome-extension:" && url.hostname === chrome.runtime.id
    );
  } catch {
    return false;
  }
}

async function readWorkspaceSession(
  sessionId: string,
): Promise<WorkspaceSession | null> {
  if (!isWorkspaceSessionId(sessionId)) {
    return null;
  }
  const key = workspaceSessionKey(sessionId);
  const stored = await chrome.storage.session.get(key);
  const value = stored[key];
  return value && typeof value === "object"
    ? (value as WorkspaceSession)
    : null;
}

async function writeWorkspaceSession(session: WorkspaceSession): Promise<void> {
  await chrome.storage.session.set({
    [workspaceSessionKey(session.sessionId)]: session,
    [workspaceSourceKey(session.sourceTabId)]: session.sessionId,
  });
}

async function workspaceForSourceTab(
  sourceTabId: number,
): Promise<WorkspaceSession | null> {
  const sourceKey = workspaceSourceKey(sourceTabId);
  const stored = await chrome.storage.session.get(sourceKey);
  const sessionId = stored[sourceKey];
  return typeof sessionId === "string" ? readWorkspaceSession(sessionId) : null;
}

async function currentScombzTab(): Promise<chrome.tabs.Tab | null> {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return activeTab?.id !== undefined && isScombzUrl(activeTab.url)
    ? activeTab
    : null;
}

async function openWorkspace(
  message: OpenWorkspaceMessage,
): Promise<OpenWorkspaceResponse> {
  const sourceTab = await currentScombzTab();
  if (sourceTab?.id === undefined) {
    return { ok: false, error: "接続元のScombZタブを確認できません。" };
  }
  const pageContext = await requestPageContextForTab(sourceTab.id);
  if (pageContext?.kind !== "scombz") {
    return { ok: false, error: "ScombZページの情報を取得できません。" };
  }

  const existing = await workspaceForSourceTab(sourceTab.id);
  if (
    existing?.workspaceTabId !== null &&
    existing?.workspaceTabId !== undefined
  ) {
    try {
      const workspaceTab = await chrome.tabs.get(existing.workspaceTabId);
      const refreshed = {
        ...existing,
        pageContext,
        sourceAvailable: true,
        updatedAt: new Date().toISOString(),
      };
      await writeWorkspaceSession(refreshed);
      await chrome.tabs.update(existing.workspaceTabId, { active: true });
      await chrome.windows.update(workspaceTab.windowId, { focused: true });
      await chrome.runtime
        .sendMessage({
          type: MESSAGE_TYPES.workspaceOwnershipChanged,
          active: true,
          session: refreshed,
        })
        .catch(() => undefined);
      return { ok: true, session: refreshed };
    } catch {
      // The workspace tab disappeared without an onRemoved notification.
    }
  }

  const sessionId = existing?.sessionId ?? crypto.randomUUID();
  const session: WorkspaceSession = {
    sessionId,
    sourceTabId: sourceTab.id,
    sourceWindowId: sourceTab.windowId,
    workspaceTabId: null,
    pageContext,
    stableState: message.stable_state,
    sourceAvailable: true,
    updatedAt: new Date().toISOString(),
  };
  await writeWorkspaceSession(session);

  const workspaceUrl = chrome.runtime.getURL(
    `workspace.html?session=${encodeURIComponent(sessionId)}`,
  );
  const workspaceTab = await chrome.tabs.create({
    openerTabId: sourceTab.id,
    windowId: sourceTab.windowId,
    active: false,
  });
  if (workspaceTab.id === undefined) {
    return { ok: false, error: "全画面タブを作成できませんでした。" };
  }
  const opened = {
    ...session,
    workspaceTabId: workspaceTab.id,
    updatedAt: new Date().toISOString(),
  };
  await writeWorkspaceSession(opened);
  try {
    await chrome.tabs.update(workspaceTab.id, {
      url: workspaceUrl,
      active: true,
    });
  } catch {
    await writeWorkspaceSession({
      ...opened,
      workspaceTabId: null,
      updatedAt: new Date().toISOString(),
    });
    return { ok: false, error: "全画面タブを表示できませんでした。" };
  }
  await chrome.runtime
    .sendMessage({
      type: MESSAGE_TYPES.workspaceOwnershipChanged,
      active: true,
      session: opened,
    })
    .catch(() => undefined);
  return { ok: true, session: opened };
}

async function getWorkspaceSession(
  sessionId: string,
): Promise<WorkspaceSessionResponse> {
  const session = await readWorkspaceSession(sessionId);
  return session
    ? { ok: true, session }
    : { ok: false, error: "全画面セッションが見つかりません。" };
}

async function getWorkspaceStatus(): Promise<WorkspaceStatusResponse> {
  const sourceTab = await currentScombzTab();
  if (sourceTab?.id === undefined) {
    return { active: false, session: null, sourceTabId: null };
  }
  const session = await workspaceForSourceTab(sourceTab.id);
  return {
    active:
      session?.workspaceTabId !== null && session?.workspaceTabId !== undefined,
    session,
    sourceTabId: sourceTab.id,
  };
}

async function updateWorkspaceSession(
  message: UpdateWorkspaceSessionMessage,
  sender: chrome.runtime.MessageSender,
): Promise<WorkspaceSessionResponse> {
  const session = await readWorkspaceSession(message.session_id);
  if (
    !session ||
    sender.tab?.id === undefined ||
    sender.tab.id !== session.workspaceTabId
  ) {
    return { ok: false, error: "全画面セッションの更新を拒否しました。" };
  }
  const updated = {
    ...session,
    stableState: message.stable_state,
    updatedAt: new Date().toISOString(),
  };
  await writeWorkspaceSession(updated);
  return { ok: true, session: updated };
}

async function releaseWorkspaceTab(tabId: number): Promise<void> {
  const stored = await chrome.storage.session.get(null);
  const sessions = Object.values(stored).filter(
    (value): value is WorkspaceSession =>
      typeof value === "object" &&
      value !== null &&
      "workspaceTabId" in value &&
      (value as WorkspaceSession).workspaceTabId === tabId,
  );
  await Promise.all(
    sessions.map(async (session) => {
      const released = {
        ...session,
        workspaceTabId: null,
        updatedAt: new Date().toISOString(),
      };
      await writeWorkspaceSession(released);
      await chrome.runtime
        .sendMessage({
          type: MESSAGE_TYPES.workspaceOwnershipChanged,
          active: false,
          session: released,
        })
        .catch(() => undefined);
    }),
  );
}

async function markSourceUnavailable(tabId: number): Promise<void> {
  const session = await workspaceForSourceTab(tabId);
  if (!session) {
    return;
  }
  const unavailable = {
    ...session,
    sourceAvailable: false,
    updatedAt: new Date().toISOString(),
  };
  await writeWorkspaceSession(unavailable);
  await chrome.runtime
    .sendMessage({
      type: MESSAGE_TYPES.workspaceSourceUnavailable,
      session_id: session.sessionId,
    })
    .catch(() => undefined);
}

function unavailableCalendarResult(): CalendarConnectorResult {
  return {
    status: "unavailable",
    message:
      "Google Calendarを利用できません。時間をおいて再試行してください。",
  };
}

function unavailableDriveResult(): DriveConnectorResult {
  return {
    status: "unavailable",
    selections: [],
    message:
      "Google Driveのファイル選択はまだ利用できません。ライブProviderは未設定です。",
    retryable: false,
  };
}

async function handleCalendarCommand(
  message: CalendarCommandMessage,
): Promise<CalendarConnectorResult> {
  try {
    switch (message.type) {
      case MESSAGE_TYPES.calendarConnect:
        return await googleCalendarConnector.connect();
      case MESSAGE_TYPES.calendarRefresh:
        return await googleCalendarConnector.refresh();
      case MESSAGE_TYPES.calendarReauthenticate:
        return await googleCalendarConnector.reauthenticate();
      case MESSAGE_TYPES.calendarDisconnect:
        return await googleCalendarConnector.disconnect();
    }
  } catch {
    return unavailableCalendarResult();
  }
}

async function handleDriveCommand(
  message: DriveCommandMessage,
): Promise<DriveConnectorResult> {
  try {
    switch (message.type) {
      case MESSAGE_TYPES.driveSelect:
        return await googleDriveConnector.select();
      case MESSAGE_TYPES.driveRead:
        return await googleDriveConnector.read(message.selection_id);
      case MESSAGE_TYPES.driveDeselect:
        return await googleDriveConnector.deselect(message.selection_id);
      case MESSAGE_TYPES.driveRefresh:
        return await googleDriveConnector.refresh();
    }
  } catch {
    return unavailableDriveResult();
  }
}

async function setTabPanelEnabled(
  tabId: number,
  url: string | undefined,
): Promise<void> {
  try {
    await chrome.sidePanel.setOptions({
      tabId,
      path: "sidepanel.html",
      enabled: isScombzUrl(url) || isSitrusGradeUrl(url),
    });
  } catch {
    // The tab can disappear while Chrome is switching windows.
  }
}

async function updateTabPanel(tabId: number, url?: string): Promise<void> {
  if (url !== undefined) {
    await setTabPanelEnabled(tabId, url);
    return;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    await setTabPanelEnabled(tabId, tab.url);
  } catch {
    // The tab can disappear before it is read.
  }
}

async function requestPageContextForTab(
  tabId: number,
): Promise<PageContext | null> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isScombzUrl(tab.url)) {
      return null;
    }

    const context = await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE_TYPES.requestPageContext,
    });
    return isPageContext(context) ? context : null;
  } catch {
    return null;
  }
}

async function requestActivePageContext(): Promise<PageContext | null> {
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (activeTab?.id === undefined) {
      return null;
    }

    return requestPageContextForTab(activeTab.id);
  } catch {
    return null;
  }
}

async function broadcastActivePageContext(
  tabId: number,
  context: PageContext | null,
): Promise<void> {
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (activeTab?.id !== tabId) {
      return;
    }

    await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.pageContextUpdated,
      context,
    });
  } catch {
    // The active tab or side panel can disappear while Chrome is switching.
  }
}

function configureActionClick(): void {
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => undefined);
}

configureActionClick();
chrome.runtime.onInstalled.addListener(configureActionClick);
chrome.runtime.onStartup.addListener(() => {
  clearMyLibraryResourceMaps();
  clearLibraryRecordMaps();
  clearLibraryActionPreviews();
  configureActionClick();
});
chrome.runtime.onSuspend?.addListener(() => {
  clearMyLibraryResourceMaps();
  clearLibraryRecordMaps();
  clearLibraryActionPreviews();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url !== undefined || changeInfo.status !== undefined) {
    void updateTabPanel(tabId, changeInfo.url ?? tab.url);
  }
  if (changeInfo.url !== undefined && !isScombzUrl(changeInfo.url)) {
    void markSourceUnavailable(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void releaseWorkspaceTab(tabId);
  void markSourceUnavailable(tabId);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void updateTabPanel(tabId);
  void requestPageContextForTab(tabId).then((context) =>
    broadcastActivePageContext(tabId, context),
  );
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isCalendarCommandMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse(unavailableCalendarResult());
      return true;
    }
    void handleCalendarCommand(message).then(sendResponse);
    return true;
  }

  if (isDriveCommandMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse(unavailableDriveResult());
      return true;
    }
    void handleDriveCommand(message).then(sendResponse);
    return true;
  }

  if (isBrowserReadMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse(unavailableBrowser("untrusted_sender"));
      return true;
    }
    void handleBrowserRead(message).then(sendResponse);
    return true;
  }

  if (isSitrusReadMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse({ status: "unavailable", reason_code: "untrusted_sender" });
      return true;
    }
    void handleSitrusRead(message).then(sendResponse);
    return true;
  }

  if (isMoodleReadMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse({ status: "unavailable", reason_code: "untrusted_sender" });
      return true;
    }
    void handleMoodleRead().then(sendResponse);
    return true;
  }

  if (isMoodleOpenMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse({ ok: false });
      return true;
    }
    void openMoodleEntry()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (isMyLibraryReadMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse({ status: "unavailable", reason_code: "untrusted_sender" });
      return true;
    }
    void handleMyLibraryRead(message).then(sendResponse);
    return true;
  }

  if (isMyLibraryDisconnectMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse({ ok: false });
      return true;
    }
    clearMyLibraryResourceMaps();
    sendResponse({ ok: true });
    return true;
  }

  if (isMyLibraryOpenMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse({ ok: false });
      return true;
    }
    void openMyLibraryEntry()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (isCastReadMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse({ status: "unavailable", reason_code: "untrusted_sender" });
      return true;
    }
    void handleCastRead().then(sendResponse);
    return true;
  }

  if (isCastOpenMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse({ ok: false });
      return true;
    }
    void openCastEntry()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (isSyllabusSearchMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse({
        schema_version: "v1",
        status: "unavailable",
        query: message.query,
        year: message.year ?? null,
        faculty: message.faculty ?? null,
        results: [],
        reason_code: "untrusted_sender",
      });
      return true;
    }
    void searchOfficialSyllabus(
      message.query,
      message.year ?? null,
      message.faculty ?? null,
    ).then(sendResponse);
    return true;
  }

  if (isLibraryCatalogSearchMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse(libraryUnavailable("untrusted_sender"));
      return true;
    }
    void handleLibraryCatalogSearch(message).then(sendResponse);
    return true;
  }

  if (isLibraryItemReadMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse(libraryUnavailable("untrusted_sender"));
      return true;
    }
    void handleLibraryItemRead(message).then(sendResponse);
    return true;
  }

  if (isLibraryActionOptionsMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse({
        status: "known",
        projection: unavailableLibraryActionOptions(
          message.resource_ref,
          "untrusted_sender",
        ),
      });
      return true;
    }
    void handleLibraryActionOptions(message).then(sendResponse);
    return true;
  }

  if (isLibraryActionPreviewMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse({ status: "unavailable", reason_code: "untrusted_sender" });
      return true;
    }
    void handleLibraryActionPreview(message).then(sendResponse);
    return true;
  }

  if (isLibraryActionSubmitMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse({ status: "unavailable", reason_code: "untrusted_sender" });
      return true;
    }
    void handleLibraryActionSubmit(message).then(sendResponse);
    return true;
  }

  if (isLibraryCatalogBrowseMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse(libraryUnavailable("untrusted_sender"));
      return true;
    }
    void handleLibraryCatalogBrowse(message).then(sendResponse);
    return true;
  }

  if (isLibraryDiscoverySearchMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse(libraryUnavailable("untrusted_sender"));
      return true;
    }
    void handleLibraryDiscoverySearch(message).then(sendResponse);
    return true;
  }

  if (isOpenWorkspaceMessage(message)) {
    if (!isTrustedExtensionPageSender(sender) || sender.tab !== undefined) {
      sendResponse({ ok: false, error: "全画面表示の開始を拒否しました。" });
      return true;
    }
    void openWorkspace(message).then(sendResponse);
    return true;
  }

  if (isGetWorkspaceSessionMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse({ ok: false, error: "全画面セッションを取得できません。" });
      return true;
    }
    void getWorkspaceSession(message.session_id).then(sendResponse);
    return true;
  }

  if (isUpdateWorkspaceSessionMessage(message)) {
    if (!isTrustedExtensionPageSender(sender)) {
      sendResponse({ ok: false, error: "全画面セッションを更新できません。" });
      return true;
    }
    void updateWorkspaceSession(message, sender).then(sendResponse);
    return true;
  }

  if (isGetWorkspaceStatusMessage(message)) {
    if (!isTrustedExtensionPageSender(sender) || sender.tab !== undefined) {
      sendResponse({ active: false, session: null, sourceTabId: null });
      return true;
    }
    void getWorkspaceStatus().then(sendResponse);
    return true;
  }

  if (isGetPageContextMessage(message)) {
    void requestActivePageContext().then(sendResponse);
    return true;
  }

  if (isPageContextUpdatedMessage(message) && sender.tab !== undefined) {
    void broadcastActivePageContext(sender.tab.id ?? -1, message.context);
  }
});
