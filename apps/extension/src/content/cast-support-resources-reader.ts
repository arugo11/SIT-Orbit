import {
  type CastLocalSnapshot,
  type CastNotice,
  extractCastDashboard,
  isCastTopUrl,
} from "./cast-reader";

export type CastSupportResourceKind =
  | "video"
  | "event"
  | "counseling"
  | "supporter"
  | "guide";

export interface CastSupportResource {
  kind: CastSupportResourceKind;
  title: string;
  url: string;
  published_date: string | null;
}

export interface CastSupportLocalSnapshot {
  schema_version: "v1";
  notices: CastNotice[];
  resources: CastSupportResource[];
  counseling_link_available: boolean;
  supporter_link_available: boolean;
}

export interface CastSupportAgentProjection {
  schema_version: "v1";
  status: "known" | "reauth_required" | "unavailable";
  notice_count: number;
  resource_count: number;
  video_count: number;
  event_count: number;
  counseling_count: number;
  supporter_count: number;
  nearest_notice_date: string | null;
  reason_code: string | null;
}

const CAST_ORIGIN = "https://shibaura.pita.services";
export const CAST_TOP_URL = `${CAST_ORIGIN}/career/top/student`;
const ALLOWED_EXTERNAL_ORIGINS = new Set([
  "https://shibaura-it.notion.site",
  "https://www.shibaura-it.ac.jp",
  "https://www3.sspi.jp",
]);

function compactText(
  value: string | null | undefined,
  maxLength: number,
): string {
  return (value ?? "").replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

function normalizeDate(value: string | null | undefined): string | null {
  const match = compactText(value, 120).match(
    /(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/u,
  );
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

function normalizeResourceUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, CAST_ORIGIN);
    if (url.protocol !== "https:" || !url.hostname) return null;
    if (
      url.origin !== CAST_ORIGIN &&
      !ALLOWED_EXTERNAL_ORIGINS.has(url.origin)
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function resourceKind(title: string): CastSupportResourceKind {
  if (/録画|動画/u.test(title)) return "video";
  if (/説明会|会社見学会|スケジュール|イベント/u.test(title)) return "event";
  if (/カウンセラー|相談/u.test(title)) return "counseling";
  if (/スタッフ紹介|就活サポーター|OB・OG/u.test(title)) return "supporter";
  return "guide";
}

function publishedDate(link: Element): string | null {
  const rowText = compactText(link.closest(".row")?.textContent, 300);
  return normalizeDate(rowText);
}

function isSupportLink(link: HTMLAnchorElement): boolean {
  const title = compactText(link.textContent, 300);
  return /録画|動画|講座|説明会|会社見学会|カウンセラー|スタッフ紹介|就活サポーター|OB・OG|FAQ|ガイド|履歴書|SPI/u.test(
    title,
  );
}

function mapSupportResource(
  link: HTMLAnchorElement,
): CastSupportResource | null {
  const title = compactText(link.textContent, 300);
  const hrefAttribute = link.getAttribute("href");
  if (hrefAttribute?.startsWith("/career/notice_detail_view")) return null;
  const url = normalizeResourceUrl(hrefAttribute);
  if (!title || !url || !isSupportLink(link)) return null;
  return {
    kind: resourceKind(title),
    title,
    url,
    published_date: publishedDate(link),
  };
}

function uniqueResources(
  resources: CastSupportResource[],
): CastSupportResource[] {
  const seen = new Set<string>();
  return resources.filter((resource) => {
    const key = `${resource.kind}:${resource.url}:${resource.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractCastSupportResources(
  document: Document,
  pageUrl: string,
): CastSupportLocalSnapshot | null {
  if (
    !isCastTopUrl(pageUrl) ||
    document.querySelector('input[type="password"]')
  ) {
    return null;
  }
  const dashboard: CastLocalSnapshot | null = extractCastDashboard(
    document,
    pageUrl,
  );
  if (!dashboard) return null;
  const resources = uniqueResources(
    Array.from(document.querySelectorAll<HTMLAnchorElement>("a"))
      .map(mapSupportResource)
      .filter((resource): resource is CastSupportResource => resource !== null)
      .slice(0, 500),
  );
  const counselingLinkAvailable = resources.some(
    (resource) => resource.kind === "counseling",
  );
  const supporterLinkAvailable = resources.some(
    (resource) => resource.kind === "supporter",
  );
  if (resources.length === 0 && dashboard.notices.length === 0) return null;
  return {
    schema_version: "v1",
    notices: dashboard.notices,
    resources,
    counseling_link_available: counselingLinkAvailable,
    supporter_link_available: supporterLinkAvailable,
  };
}

export function projectCastSupportForAgent(
  snapshot: CastSupportLocalSnapshot,
): CastSupportAgentProjection {
  const dates = snapshot.notices
    .map((notice) => notice.published_date)
    .filter((value): value is string => value !== null)
    .sort()
    .reverse();
  const count = (kind: CastSupportResourceKind) =>
    snapshot.resources.filter((resource) => resource.kind === kind).length;
  return {
    schema_version: "v1",
    status: "known",
    notice_count: snapshot.notices.length,
    resource_count: snapshot.resources.length,
    video_count: count("video"),
    event_count: count("event"),
    counseling_count: count("counseling"),
    supporter_count: count("supporter"),
    nearest_notice_date: dates[0] ?? null,
    reason_code: null,
  };
}
