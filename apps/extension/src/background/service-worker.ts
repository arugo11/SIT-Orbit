import {
  type CalendarConnectorResult,
  GoogleCalendarConnector,
} from "../connectors/google-calendar";
import {
  type DriveConnectorResult,
  GoogleDriveConnector,
} from "../connectors/google-drive";
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
  MY_LIBRARY_ORIGIN,
  MY_LIBRARY_STATUS_PATH,
  type MyLibraryLocalSnapshot,
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
  isMoodleOpenMessage,
  isMoodleReadMessage,
  isMyLibraryOpenMessage,
  isMyLibraryReadMessage,
  isOpenWorkspaceMessage,
  isPageContext,
  isPageContextUpdatedMessage,
  isSitrusReadMessage,
  isSyllabusSearchMessage,
  isUpdateWorkspaceSessionMessage,
  MESSAGE_TYPES,
  type MoodleReadResponse,
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
  kind?: "loans" | "reservations";
  loans?: MyLibraryLocalSnapshot["loans"];
  reservations?: MyLibraryLocalSnapshot["reservations"];
  reason_code?: string;
}

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

function readMyLibraryStatusInPage(): MyLibraryPageRead {
  const clean = (value: string | null | undefined, limit: number): string =>
    (value ?? "").replace(/\s+/gu, " ").trim().slice(0, limit);
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
      if (clean(cell.querySelector("dt")?.textContent, 100) === label) {
        return cell.querySelector("dd");
      }
    }
    return null;
  };

  try {
    if (
      location.origin !== "https://library.shibaura-it.ac.jp" ||
      location.pathname !== "/portal/admin/selectMenu/doSelectPublicUseMainMenu"
    ) {
      return { status: "unavailable", reason_code: "unexpected_page" };
    }
    if (document.querySelector('input[type="password"]')) {
      return { status: "reauth_required", reason_code: "login_required" };
    }
    const loanTable = document.querySelector("#lendList");
    if (loanTable) {
      const today = new Date();
      const todayKey = `${today.getFullYear().toString().padStart(4, "0")}-${(
        today.getMonth() + 1
      )
        .toString()
        .padStart(2, "0")}-${today.getDate().toString().padStart(2, "0")}`;
      const loans = Array.from(loanTable.querySelectorAll("tbody tr"))
        .filter(
          (row) => !row.querySelector(".dataTables_empty, .empty, .no-data"),
        )
        .map((row) => {
          const titleAuthor = splitTitleAuthor(
            valueForLabel(row, "書名 / 著者名")?.textContent ?? "",
          );
          if (!titleAuthor) return null;
          const dueDate = normalizeDate(
            valueForLabel(row, "貸出返却期限延長回数")?.textContent ?? "",
          );
          const checkbox = row.querySelector<HTMLInputElement>(
            'input[type="checkbox"][name="checkBoxBookNumber"]',
          );
          return {
            ...titleAuthor,
            due_date: dueDate,
            renewable: Boolean(checkbox && !checkbox.disabled),
            overdue: dueDate !== null && dueDate < todayKey,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .slice(0, 1000);
      return { status: "known", kind: "loans", loans };
    }
    const reservationTable = document.querySelector("#reservationList");
    if (reservationTable) {
      const reservations = Array.from(
        reservationTable.querySelectorAll("tbody tr"),
      )
        .filter(
          (row) => !row.querySelector(".dataTables_empty, .empty, .no-data"),
        )
        .map((row) => {
          const titleAuthor = splitTitleAuthor(
            valueForLabel(row, "書名 / 著者名")?.textContent ?? "",
          );
          if (!titleAuthor) return null;
          return {
            ...titleAuthor,
            hold_until: normalizeDate(
              valueForLabel(row, "受取館取置期限日")?.textContent ?? "",
            ),
            status: clean(valueForLabel(row, "状態")?.textContent, 100) || null,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .slice(0, 1000);
      return { status: "known", kind: "reservations", reservations };
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
          url.pathname === MY_LIBRARY_STATUS_PATH
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

async function readMyLibrarySection(menuId: 5 | 6): Promise<MyLibraryPageRead> {
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
      args: [menuId],
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

async function handleMyLibraryRead(): Promise<MyLibraryReadResponse> {
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
  const loanPage = await readMyLibrarySection(5);
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
  const reservationPage = await readMyLibrarySection(6);
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
chrome.runtime.onStartup.addListener(configureActionClick);

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
    void handleMyLibraryRead().then(sendResponse);
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
