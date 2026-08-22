export const CAST_ORIGIN = "https://shibaura.pita.services";
export const CAST_ENTRY_URL = `${CAST_ORIGIN}/career`;
export const CAST_TOP_URL = `${CAST_ORIGIN}/career/top/student`;
export const CAST_SESSION_TIMEOUT_PATH = "/career/session_timeout";

export interface CastNotice {
  title: string;
  published_date: string | null;
}

export interface CastLocalSnapshot {
  notices: CastNotice[];
  new_job_count: number;
  new_internship_count: number;
  new_event_count: number;
  has_counseling_reservation: boolean;
}

export interface CastAgentProjection {
  schema_version: "v1";
  status: "known" | "reauth_required" | "unavailable";
  notice_count: number;
  new_job_count: number;
  new_internship_count: number;
  new_event_count: number;
  has_counseling_reservation: boolean;
  nearest_notice_date: string | null;
  reason_code: string | null;
}

function compactText(
  value: string | null | undefined,
  maxLength: number,
): string {
  return (value ?? "").replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

function normalizeDate(value: string): string | null {
  const match = value.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/u);
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
}

function exactPath(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin === CAST_ORIGIN ? url.pathname : null;
  } catch {
    return null;
  }
}

export function isCastTopUrl(value: string | null | undefined): boolean {
  return exactPath(value) === "/career/top/student";
}

export function isCastReauthenticationUrl(
  value: string | null | undefined,
): boolean {
  const path = exactPath(value);
  return path === CAST_SESSION_TIMEOUT_PATH || path === "/career/login";
}

function numericCount(document: Document, selector: string): number | null {
  const value = compactText(document.querySelector(selector)?.textContent, 20);
  if (!/^\d+$/u.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count <= 100_000 ? count : null;
}

export function extractCastDashboard(
  document: Document,
  pageUrl: string,
): CastLocalSnapshot | null {
  if (
    !isCastTopUrl(pageUrl) ||
    document.querySelector('input[type="password"]')
  ) {
    return null;
  }
  const newJobCount = numericCount(document, "#job_offer_count");
  const newInternshipCount = numericCount(document, "#internship_count");
  const newEventCount = numericCount(document, "#company_session_count");
  if (
    newJobCount === null ||
    newInternshipCount === null ||
    newEventCount === null
  ) {
    return null;
  }
  const notices = Array.from(
    document.querySelectorAll<HTMLAnchorElement>(
      'a[href^="/career/notice_detail_view"]:not(.notice-detail)',
    ),
  )
    .map((link): CastNotice | null => {
      const title = compactText(link.textContent, 300);
      if (!title) return null;
      const row = link.closest(".row");
      if (!row) return null;
      return {
        title,
        published_date: normalizeDate(row?.textContent ?? ""),
      };
    })
    .filter((item): item is CastNotice => item !== null)
    .slice(0, 1000);
  const hasCounselingReservation = Array.from(
    document.querySelectorAll(".myCareerNotice"),
  ).some((element) => {
    const text = compactText(
      (element.closest(".row") ?? element).textContent,
      500,
    );
    return /(相談|面談)/u.test(text) && /予約/u.test(text);
  });
  return {
    notices,
    new_job_count: newJobCount,
    new_internship_count: newInternshipCount,
    new_event_count: newEventCount,
    has_counseling_reservation: hasCounselingReservation,
  };
}

export function projectCastForAgent(
  snapshot: CastLocalSnapshot,
): CastAgentProjection {
  const dates = snapshot.notices
    .map((notice) => notice.published_date)
    .filter((value): value is string => value !== null)
    .sort()
    .reverse();
  return {
    schema_version: "v1",
    status: "known",
    notice_count: snapshot.notices.length,
    new_job_count: snapshot.new_job_count,
    new_internship_count: snapshot.new_internship_count,
    new_event_count: snapshot.new_event_count,
    has_counseling_reservation: snapshot.has_counseling_reservation,
    nearest_notice_date: dates[0] ?? null,
    reason_code: null,
  };
}
