export const SCOMBZ_ORIGIN = "https://scombz.shibaura-it.ac.jp";

export type PageKind = "scombz" | "other";

export type ScombzRoute =
  | "home"
  | "tasks"
  | "timetable"
  | "announcements"
  | "calendar"
  | "course"
  | "other";

export interface ScombzTask {
  course: string;
  title: string;
  deadline: string;
  url: string | null;
}

export interface ScombzAnnouncement {
  title: string;
  url: string | null;
}

export interface ScombzCalendar {
  googleCalendarUrl: string | null;
  icsUrl: string | null;
}

export interface ScombzLink {
  label: string;
  url: string;
}

export interface ScombzCourse {
  name: string;
  url: string;
}

export interface ScombzPageData {
  route: ScombzRoute;
  tasks: ScombzTask[];
  announcements: ScombzAnnouncement[];
  calendar: ScombzCalendar;
  currentCourse: ScombzCourse | null;
  relatedLinks: ScombzLink[];
}

/** The only ScombZ values permitted in a deferred Agent tool result. */
export interface ScombzPageSummary {
  route: ScombzRoute;
  task_count: number;
  announcement_count: number;
  related_link_count: number;
  has_current_course: boolean;
}

export interface PageContext {
  title: string;
  url: string;
  kind: PageKind;
  scombz?: ScombzPageData;
}

export interface PageSnapshot {
  title: string;
  url: string;
}

/**
 * Project a parsed ScombZ context into the strict, title/URL-free v1 result.
 * Unparsed or non-ScombZ contexts cannot advertise this client tool.
 */
export function projectScombzPageSummary(
  context: PageContext | null | undefined,
): ScombzPageSummary | null {
  if (context?.kind !== "scombz" || context.scombz === undefined) {
    return null;
  }
  return {
    route: context.scombz.route,
    task_count: context.scombz.tasks.length,
    announcement_count: context.scombz.announcements.length,
    related_link_count: context.scombz.relatedLinks.length,
    has_current_course: context.scombz.currentCourse !== null,
  };
}

export function isScombzUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.origin === SCOMBZ_ORIGIN;
  } catch {
    return false;
  }
}

export function classifyPageKind(value: string | undefined): PageKind {
  return isScombzUrl(value) ? "scombz" : "other";
}

export function mapPageContext(snapshot: PageSnapshot): PageContext {
  const title = snapshot.title.trim();
  const url = snapshot.url.trim();

  return {
    title: title || "無題のページ",
    url,
    kind: classifyPageKind(url),
  };
}

export function parseScombzPageContext(
  snapshot: PageSnapshot,
  document: Document,
): PageContext {
  const context = mapPageContext(snapshot);
  if (context.kind !== "scombz") {
    return context;
  }

  const route = classifyScombzRoute(context.url);
  return {
    ...context,
    scombz: {
      route,
      tasks: route === "tasks" ? parseTasks(document, context.url) : [],
      announcements:
        route === "home" || route === "announcements"
          ? parseAnnouncements(document, context.url, route === "announcements")
          : [],
      calendar:
        route === "home" || route === "calendar"
          ? parseCalendar(document, context.url)
          : emptyCalendar(),
      currentCourse:
        route === "course" ? parseCurrentCourse(document, context.url) : null,
      relatedLinks:
        route === "home" ? parseRelatedLinks(document, context.url) : [],
    },
  };
}

function classifyScombzRoute(value: string): ScombzRoute {
  let pathname: string;
  try {
    pathname = new URL(value).pathname;
  } catch {
    return "other";
  }

  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  if (normalizedPath === "/portal/home") {
    return "home";
  }
  if (normalizedPath === "/lms/task") {
    return "tasks";
  }
  if (normalizedPath === "/lms/timetable") {
    return "timetable";
  }
  if (
    normalizedPath === "/portal/notice" ||
    normalizedPath.startsWith("/portal/notice/") ||
    normalizedPath === "/portal/announcements" ||
    normalizedPath.startsWith("/portal/announcements/") ||
    normalizedPath === "/portal/home/information/list" ||
    normalizedPath.startsWith("/portal/home/information/list/")
  ) {
    return "announcements";
  }
  if (
    normalizedPath === "/portal/calendar" ||
    normalizedPath.startsWith("/portal/calendar/")
  ) {
    return "calendar";
  }
  if (
    normalizedPath === "/course" ||
    normalizedPath.startsWith("/course/") ||
    normalizedPath === "/lms/course" ||
    normalizedPath.startsWith("/lms/course/")
  ) {
    return "course";
  }
  return "other";
}

function parseTasks(document: Document, baseUrl: string): ScombzTask[] {
  return Array.from(
    document.querySelectorAll("#taskList .result_list_line"),
  ).flatMap((row) => {
    if (isHidden(row)) {
      return [];
    }

    const titleAnchor = row.querySelector(".tasklist-title a:nth-child(1)");
    const task = {
      course: normalizedText(row.querySelector(".course")),
      title: normalizedText(titleAnchor),
      deadline: normalizedText(
        row.querySelector(".tasklist-deadline .deadline"),
      ),
      url: safeHttpUrl(titleAnchor?.getAttribute("href"), baseUrl),
    } satisfies ScombzTask;

    return task.course || task.title || task.deadline ? [task] : [];
  });
}

function parseAnnouncements(
  document: Document,
  baseUrl: string,
  allowListFallback: boolean,
): ScombzAnnouncement[] {
  const root = document.querySelector("#top_information3");
  if (!root && !allowListFallback) {
    return [];
  }

  if (root) {
    const announcements = Array.from(
      root.querySelectorAll(".portal-info-content-part"),
    ).flatMap((item) => {
      if (isHidden(item)) {
        return [];
      }

      const anchor = item.matches("a") ? item : item.querySelector("a");
      const title = normalizedText(anchor ?? item);
      if (!title || title === "一覧へ") {
        return [];
      }

      return [
        {
          title,
          url: safeHttpUrl(anchor?.getAttribute("href"), baseUrl),
        },
      ];
    });
    if (announcements.length > 0 || !allowListFallback) {
      return announcements;
    }
  }

  return Array.from(
    document.querySelectorAll(
      "#informationDataList .result-list, .information-contents-list .result-list",
    ),
  ).flatMap((row) => {
    if (isHidden(row)) {
      return [];
    }

    const title = normalizedText(
      row.querySelector(".portal-information-list-title .link-txt"),
    );
    return title ? [{ title, url: null }] : [];
  });
}

function parseCalendar(document: Document, baseUrl: string): ScombzCalendar {
  return {
    googleCalendarUrl: safeHttpUrl(
      firstVisibleElement(
        document,
        "a.portal-calendar-event-add-a",
      )?.getAttribute("href"),
      baseUrl,
    ),
    icsUrl: safeHttpUrl(
      firstVisibleElement(
        document,
        "a.portal-calendar-event-export-a",
      )?.getAttribute("href"),
      baseUrl,
    ),
  };
}

function firstVisibleElement(
  document: Document,
  selector: string,
): Element | null {
  return (
    Array.from(document.querySelectorAll(selector)).find(
      (element) => !isHidden(element),
    ) ?? null
  );
}

function parseRelatedLinks(document: Document, baseUrl: string): ScombzLink[] {
  const primary = Array.from(
    document.querySelectorAll(
      "#school_link_list a.portal-subblock-link-main-a",
    ),
  );
  const anchors =
    primary.length > 0
      ? primary
      : Array.from(
          document.querySelectorAll(
            "#top_notice a.portal-subblock-link-main-a",
          ),
        );
  const seen = new Set<string>();

  return anchors.flatMap((anchor) => {
    if (isHidden(anchor)) {
      return [];
    }

    const label = normalizedText(anchor);
    const url = safeHttpUrl(anchor.getAttribute("href"), baseUrl);
    if (!label || !url) {
      return [];
    }

    const key = `${url}\u0000${label}`;
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [{ label, url }];
  });
}

function parseCurrentCourse(
  document: Document,
  baseUrl: string,
): ScombzCourse | null {
  const name = normalizedText(document.querySelector(".course-title-txt"));
  const url = safeHttpUrl(baseUrl, baseUrl);
  return name && url ? { name, url } : null;
}

function emptyCalendar(): ScombzCalendar {
  return { googleCalendarUrl: null, icsUrl: null };
}

function normalizedText(element: Element | null): string {
  return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function isHidden(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (
      current.hasAttribute("hidden") ||
      current.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
      current.classList.contains("portal-info-content-hide")
    ) {
      return true;
    }

    const style = current.getAttribute("style") ?? "";
    if (
      /(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/i.test(style) ||
      /(?:^|;)\s*visibility\s*:\s*(?:hidden|collapse)\s*(?:;|$)/i.test(style)
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function safeHttpUrl(
  value: string | null | undefined,
  baseUrl: string,
): string | null {
  const href = value?.trim();
  if (!href) {
    return null;
  }

  try {
    const url = new URL(href, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}
