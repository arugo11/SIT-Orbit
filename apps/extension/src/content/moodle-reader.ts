import { exactTrustedPagePath } from "./trusted-page-url";

export const MOODLE_ORIGIN = "https://moodle.sic.shibaura-it.ac.jp";
export const MOODLE_DASHBOARD_PATH = "/moodle/my/";
export const MOODLE_LOGIN_URL = `${MOODLE_ORIGIN}/moodle/login/index.php`;
export const MOODLE_DASHBOARD_URL = `${MOODLE_ORIGIN}${MOODLE_DASHBOARD_PATH}`;

export interface MoodleLocalActivity {
  title: string;
  course: string | null;
  due_at: string | null;
  overdue: boolean;
}

export interface MoodleLocalSnapshot {
  courses: string[];
  upcoming: MoodleLocalActivity[];
  unread_notification_count: number;
}

export interface MoodleAgentProjection {
  schema_version: "v1";
  status: "known" | "reauth_required" | "unavailable";
  course_count: number;
  upcoming_item_count: number;
  overdue_count: number;
  earliest_due_at: string | null;
  unread_notification_count: number;
  reason_code: string | null;
}

function compactText(
  value: string | null | undefined,
  maxLength: number,
): string {
  return (value ?? "").replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

export function isMoodleDashboardUrl(
  value: string | null | undefined,
): boolean {
  return (
    exactTrustedPagePath(value, {
      origin: MOODLE_ORIGIN,
      paths: new Set([MOODLE_DASHBOARD_PATH]),
    }) !== null
  );
}

function parseDueAt(element: Element): string | null {
  const time = element
    .querySelector("time[datetime]")
    ?.getAttribute("datetime");
  const timestamp =
    element.getAttribute("data-timestamp") ??
    element.querySelector("[data-timestamp]")?.getAttribute("data-timestamp");
  const raw = time ?? timestamp;
  if (!raw) return null;
  const parsed = /^\d{10,13}$/u.test(raw)
    ? new Date(Number(raw) * (raw.length === 10 ? 1000 : 1))
    : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function extractMoodleDashboard(
  document: Document,
  pageUrl: string,
  now = new Date(),
): MoodleLocalSnapshot | null {
  if (!isMoodleDashboardUrl(pageUrl)) return null;

  const courses = Array.from(
    document.querySelectorAll(
      '[data-region="course-content"] .coursename, a[href*="/moodle/course/view.php"]',
    ),
  )
    .map((element) => compactText(element.textContent, 200))
    .filter(
      (value, index, values) =>
        value.length > 0 && values.indexOf(value) === index,
    )
    .slice(0, 1000);

  const activityElements = Array.from(
    document.querySelectorAll(
      '[data-region="event-list-content"] [data-region="event-list-item"], .timeline-event-list-item, [data-moodle-activity]',
    ),
  ).slice(0, 1000);
  const upcoming = activityElements
    .map((element): MoodleLocalActivity | null => {
      const title = compactText(
        element.querySelector(
          '[data-region="event-name"], .event-name, [data-activity-title]',
        )?.textContent ?? element.getAttribute("data-activity-title"),
        300,
      );
      if (!title) return null;
      const course = compactText(
        element.querySelector('[data-region="event-course-name"], .course-name')
          ?.textContent,
        200,
      );
      const due_at = parseDueAt(element);
      return {
        title,
        course: course || null,
        due_at,
        overdue: due_at ? new Date(due_at).getTime() < now.getTime() : false,
      };
    })
    .filter((item): item is MoodleLocalActivity => item !== null);

  const notificationText = compactText(
    document.querySelector(
      '[data-region="notification-count"], [data-region="count-container"]',
    )?.textContent,
    20,
  );
  const parsedNotifications = Number.parseInt(
    notificationText.replace(/\D/gu, ""),
    10,
  );

  return {
    courses,
    upcoming,
    unread_notification_count: Number.isFinite(parsedNotifications)
      ? Math.min(parsedNotifications, 10_000)
      : 0,
  };
}

export function projectMoodleForAgent(
  snapshot: MoodleLocalSnapshot,
): MoodleAgentProjection {
  const dueDates = snapshot.upcoming
    .map((item) => item.due_at)
    .filter((value): value is string => value !== null)
    .sort();
  return {
    schema_version: "v1",
    status: "known",
    course_count: snapshot.courses.length,
    upcoming_item_count: snapshot.upcoming.length,
    overdue_count: snapshot.upcoming.filter((item) => item.overdue).length,
    earliest_due_at: dueDates[0] ?? null,
    unread_notification_count: snapshot.unread_notification_count,
    reason_code: null,
  };
}
