/**
 * Reader for the authenticated CAST career-supporter page.
 *
 * CAST does not expose an official API. This module accepts only the visible
 * DOM of the page the user has already opened. Names and contact details stay
 * in the local snapshot; the agent projection contains generalized values.
 */

import type { PseudonymizationMission } from "../privacy/pseudonymization";

export const CAST_ALUMNI_SCHEMA_VERSION = "v1" as const;
export const CAST_ALUMNI_INTERNAL_MESSAGE = "orbit-extract-cast-alumni";

export type CastAlumniRole = "alumni" | "supporter" | "unknown";
export type CastAlumniFrequency =
  | "weekly"
  | "monthly"
  | "occasional"
  | "unknown";
export type CastAlumniMeetingMode = "online" | "in_person" | "unknown";

export interface CastAlumniLocalProfile {
  local_id: string;
  display_name: string | null;
  role: CastAlumniRole;
  answerable_topics: string[];
  availability_frequency: CastAlumniFrequency;
  meeting_modes: CastAlumniMeetingMode[];
  shareable_insights: string[];
  contact_present: boolean;
}

export interface CastAlumniDiscoveredLink {
  label: string;
  path: string;
}

export interface CastAlumniLocalSnapshot {
  schema_version: typeof CAST_ALUMNI_SCHEMA_VERSION;
  page_path: string;
  profiles: CastAlumniLocalProfile[];
  discovered_links: CastAlumniDiscoveredLink[];
}

export interface CastAlumniAgentProjection {
  schema_version: typeof CAST_ALUMNI_SCHEMA_VERSION;
  status: "known" | "reauth_required" | "unavailable";
  data_classification: "personal" | "restricted";
  profile_count: number;
  profiles?: Array<{
    alias: string;
    role: CastAlumniRole;
    company?: string;
    technical_domains: string[];
    job_types: string[];
    location_area?: string;
    graduation_year_bucket?: string;
    evidence_id?: string;
  }>;
  topic_categories: string[];
  availability_frequencies: CastAlumniFrequency[];
  meeting_modes: CastAlumniMeetingMode[];
  shareable_insight_categories: string[];
  contact_present: boolean;
  discovered_link_count: number;
  reason_code: string | null;
}

export type CastAlumniPageReadResult =
  | { status: "known"; detail: CastAlumniLocalSnapshot }
  | { status: "reauth_required"; reason_code: string }
  | { status: "unavailable"; reason_code: string };

export interface CastAlumniPromptPerson {
  alias: string;
  role: CastAlumniRole;
  topic_categories: string[];
  availability_frequency: CastAlumniFrequency;
  meeting_modes: CastAlumniMeetingMode[];
  shareable_insight_categories: string[];
}

export interface CastAlumniPromptProjection {
  schema_version: typeof CAST_ALUMNI_SCHEMA_VERSION;
  people: CastAlumniPromptPerson[];
}

const CAST_ORIGIN = "https://shibaura.pita.services";
const MAX_PROFILES = 64;
const MAX_TOPICS = 12;
const MAX_INSIGHTS = 12;
const MAX_LINKS = 32;
const ALUMNI_LINK_LABEL =
  /(?:就活サポーター|キャリアサポーター|OB\s*[・/]?\s*OG|卒業生|アラムナイ|面談|相談|共有|回答|テーマ)/iu;
const PROFILE_MARKER =
  /(?:回答可能|相談できる|面談|頻度|テーマ|共有(?:可能)?|就活サポーター|OB\s*[・/]?\s*OG|卒業生)/u;
const CONTACT_PATTERN =
  /(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:\+81|0)[-\d() ]{8,})/iu;
const STUDENT_ID_PATTERN = /\b[A-Z]{1,5}[-_ ]?\d{5,}\b/iu;

function compact(value: string | null | undefined, max = 300): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function visible(element: Element): boolean {
  if (
    element.hasAttribute("hidden") ||
    element.getAttribute("aria-hidden")?.toLowerCase() === "true"
  ) {
    return false;
  }
  const html = element as HTMLElement;
  const style = globalThis.getComputedStyle?.(html);
  return (
    style?.display !== "none" &&
    style?.visibility !== "hidden" &&
    !element.closest("[hidden], [aria-hidden='true']")
  );
}

function visibleText(element: Element | null | undefined, max = 1000): string {
  if (!element || !visible(element)) return "";
  return compact(element.textContent, max);
}

function pagePath(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    if (
      url.origin !== CAST_ORIGIN ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith("/career/")
    ) {
      return null;
    }
    return url.pathname;
  } catch {
    return null;
  }
}

function isReauthenticationPage(document: Document, path: string): boolean {
  return (
    path === "/career/login" ||
    path === "/career/session_timeout" ||
    Boolean(document.querySelector('input[type="password"]'))
  );
}

function normalizeFrequency(value: string): CastAlumniFrequency {
  if (/(?:週|weekly|毎週|週一|週1)/iu.test(value)) return "weekly";
  if (/(?:月|monthly|毎月|月一|月1)/iu.test(value)) return "monthly";
  if (/(?:随時|occasion|時々|不定期|必要に応じ)/iu.test(value)) {
    return "occasional";
  }
  return "unknown";
}

function normalizeModes(value: string): CastAlumniMeetingMode[] {
  const modes: CastAlumniMeetingMode[] = [];
  if (/(?:オンライン|online|zoom|遠隔)/iu.test(value)) modes.push("online");
  if (/(?:対面|来校|in[ -]?person|面会)/iu.test(value)) modes.push("in_person");
  if (modes.length === 0) modes.push("unknown");
  return Array.from(new Set(modes));
}

function categories(value: string): string[] {
  const source = compact(value, 1600);
  const known: Array<[RegExp, string]> = [
    [/(?:選考|面接|ES|エントリーシート)/iu, "選考・応募書類"],
    [/(?:研究|技術|開発|エンジニア)/iu, "技術・研究"],
    [/(?:職種|仕事|配属|キャリア)/iu, "職種・キャリア"],
    [/(?:業界|企業|会社)/iu, "業界・企業理解"],
    [/(?:働き方|勤務地|海外|リモート)/iu, "働き方・勤務地"],
    [/(?:インターン|説明会|就活)/iu, "就職活動全般"],
  ];
  return known
    .filter(([pattern]) => pattern.test(source))
    .map(([, label]) => label);
}

function insightCategories(value: string): string[] {
  const source = compact(value, 1600);
  const known: Array<[RegExp, string]> = [
    [/(?:選考|面接|ES|質問)/iu, "選考体験"],
    [/(?:業務|仕事|配属|職場)/iu, "仕事理解"],
    [/(?:技術|研究|開発|学習)/iu, "技術・学習"],
    [/(?:準備|勉強|対策|アドバイス)/iu, "準備・助言"],
  ];
  return known
    .filter(([pattern]) => pattern.test(source))
    .map(([, label]) => label);
}

function roleFor(element: Element, text: string): CastAlumniRole {
  const value = compact(
    `${element.getAttribute("data-role") ?? ""} ${text}`,
    600,
  );
  if (
    /(?:就活サポーター|キャリアサポーター|卒業生|OB\s*[・/]?\s*OG|alumni)/iu.test(
      value,
    )
  ) {
    return "alumni";
  }
  if (/(?:担当|相談員|スタッフ|supporter)/iu.test(value)) return "supporter";
  return "unknown";
}

function localDisplayName(element: Element): string | null {
  const candidate =
    element.getAttribute("data-name") ??
    element.querySelector("[data-name], .name, .person-name, .alumni-name")
      ?.textContent ??
    "";
  const normalized = compact(candidate, 160);
  if (
    !normalized ||
    CONTACT_PATTERN.test(normalized) ||
    STUDENT_ID_PATTERN.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function profileFromElement(
  element: Element,
  index: number,
): CastAlumniLocalProfile | null {
  if (!visible(element)) return null;
  const text = visibleText(element, 2400);
  if (!PROFILE_MARKER.test(text)) return null;
  const frequencyText = compact(
    `${element.getAttribute("data-frequency") ?? ""} ${text}`,
    800,
  );
  const topics = categories(text).slice(0, MAX_TOPICS);
  const insights = insightCategories(text).slice(0, MAX_INSIGHTS);
  const modes = normalizeModes(
    `${element.getAttribute("data-mode") ?? ""} ${text}`,
  );
  const displayName = localDisplayName(element);
  const contactPresent = CONTACT_PATTERN.test(text);
  if (
    !displayName &&
    topics.length === 0 &&
    insights.length === 0 &&
    !contactPresent
  ) {
    return null;
  }
  return {
    local_id: `cast-alumni-local-${index + 1}`,
    display_name: displayName,
    role: roleFor(element, text),
    answerable_topics: topics,
    availability_frequency: normalizeFrequency(frequencyText),
    meeting_modes: modes,
    shareable_insights: insights,
    contact_present: contactPresent,
  };
}

function discoveredLinks(document: Document): CastAlumniDiscoveredLink[] {
  const seen = new Set<string>();
  const result: CastAlumniDiscoveredLink[] = [];
  for (const anchor of Array.from(
    document.querySelectorAll<HTMLAnchorElement>("a[href]"),
  )) {
    if (!visible(anchor)) continue;
    const label = visibleText(anchor, 200);
    if (!label || !ALUMNI_LINK_LABEL.test(label)) continue;
    let url: URL;
    try {
      url = new URL(anchor.href, globalThis.location?.href ?? CAST_ORIGIN);
    } catch {
      continue;
    }
    if (
      url.origin !== CAST_ORIGIN ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith("/career/")
    ) {
      continue;
    }
    if (seen.has(url.pathname)) continue;
    seen.add(url.pathname);
    result.push({ label, path: url.pathname });
    if (result.length >= MAX_LINKS) break;
  }
  return result;
}

export function extractCastAlumniPage(
  document: Document,
  pageUrl: string,
): CastAlumniPageReadResult {
  const path = pagePath(pageUrl);
  if (!path) return { status: "unavailable", reason_code: "unknown_cast_path" };
  if (isReauthenticationPage(document, path)) {
    return { status: "reauth_required", reason_code: "cast_login_required" };
  }
  const candidates = Array.from(
    document.querySelectorAll<Element>(
      ".alumni-profile, .supporter-profile, [data-role='alumni'], [data-role='supporter'], article, section, tr, li",
    ),
  );
  const profiles: CastAlumniLocalProfile[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const profile = profileFromElement(candidate, profiles.length);
    if (!profile) continue;
    const signature = JSON.stringify({
      display_name: profile.display_name,
      role: profile.role,
      answerable_topics: profile.answerable_topics,
      availability_frequency: profile.availability_frequency,
      meeting_modes: profile.meeting_modes,
      shareable_insights: profile.shareable_insights,
      contact_present: profile.contact_present,
    });
    if (seen.has(signature)) continue;
    seen.add(signature);
    profiles.push(profile);
    if (profiles.length >= MAX_PROFILES) break;
  }
  const links = discoveredLinks(document);
  if (
    profiles.length === 0 &&
    links.length === 0 &&
    !PROFILE_MARKER.test(visibleText(document.body, 4000))
  ) {
    return { status: "unavailable", reason_code: "alumni_structure_not_found" };
  }
  return {
    status: "known",
    detail: {
      schema_version: CAST_ALUMNI_SCHEMA_VERSION,
      page_path: path,
      profiles,
      discovered_links: links,
    },
  };
}

export function projectCastAlumniForAgent(
  snapshot: CastAlumniLocalSnapshot,
): CastAlumniAgentProjection {
  const topics = new Set<string>();
  const frequencies = new Set<CastAlumniFrequency>();
  const modes = new Set<CastAlumniMeetingMode>();
  const insights = new Set<string>();
  let contactPresent = false;
  for (const profile of snapshot.profiles) {
    profile.answerable_topics.forEach((value) => {
      topics.add(value);
    });
    profile.shareable_insights.forEach((value) => {
      insights.add(value);
    });
    frequencies.add(profile.availability_frequency);
    profile.meeting_modes.forEach((value) => {
      modes.add(value);
    });
    contactPresent ||= profile.contact_present;
  }
  return {
    schema_version: CAST_ALUMNI_SCHEMA_VERSION,
    status: "known",
    data_classification: "personal",
    profile_count: snapshot.profiles.length,
    topic_categories: Array.from(topics).sort(),
    availability_frequencies: Array.from(frequencies).sort(),
    meeting_modes: Array.from(modes).sort(),
    shareable_insight_categories: Array.from(insights).sort(),
    contact_present: contactPresent,
    discovered_link_count: snapshot.discovered_links.length,
    reason_code: null,
  };
}

/** Build a mission-scoped local-only Prompt projection with stable aliases. */
export async function buildCastAlumniPromptProjection(
  snapshot: CastAlumniLocalSnapshot,
  mission: PseudonymizationMission,
): Promise<CastAlumniPromptProjection> {
  const people: CastAlumniPromptPerson[] = [];
  for (const profile of snapshot.profiles) {
    const result = await mission.transform({
      schema_version: "v1",
      records: [
        {
          name: profile.display_name ?? undefined,
          source_identifier: profile.local_id,
          role: profile.role === "supporter" ? "alumni" : profile.role,
          technical_domains: profile.answerable_topics,
        },
      ],
    });
    const person = result.payload.people[0];
    if (!person) continue;
    people.push({
      alias: person.alias,
      role: profile.role,
      topic_categories: profile.answerable_topics,
      availability_frequency: profile.availability_frequency,
      meeting_modes: profile.meeting_modes,
      shareable_insight_categories: profile.shareable_insights,
    });
  }
  return { schema_version: CAST_ALUMNI_SCHEMA_VERSION, people };
}
