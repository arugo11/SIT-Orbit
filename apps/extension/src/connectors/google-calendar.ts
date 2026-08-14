export const GOOGLE_CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.owned.readonly";

export const GOOGLE_CALENDAR_EVENTS_ENDPOINT =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export const GOOGLE_OAUTH_REVOKE_ENDPOINT =
  "https://oauth2.googleapis.com/revoke";

const CALENDAR_FIELDS =
  "nextPageToken,timeZone,items(id,status,summary,start,end,endTimeUnspecified,transparency,eventType)";
const MAX_PAGES = 3;
const MAX_EVENTS = 300;
const MAX_EVENTS_PER_PAGE = 100;
const DAYS_AHEAD = 7;

export type CalendarConnectorStatus =
  | "not_connected"
  | "connected"
  | "reauth_required"
  | "unavailable";

export type CalendarAvailabilityStatus = "known" | "unknown";

export interface IdentityTokenRequest {
  interactive: boolean;
  scopes: string[];
}

export interface IdentityAdapter {
  getAuthToken(details: IdentityTokenRequest): Promise<string>;
  removeCachedAuthToken(details: { token: string }): Promise<void>;
}

export type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface CalendarInterval {
  start: string;
  end: string;
}

export interface CalendarEventView {
  id: string;
  status: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  endTimeUnspecified: boolean;
  transparency: string;
  eventType: string;
}

export interface CalendarAvailabilitySummary {
  status: CalendarAvailabilityStatus;
  availableMinutes: number | null;
  busyMinutes: number | null;
  intervals: CalendarInterval[];
  reason?: string;
}

export interface CalendarSnapshot {
  timeZone: string;
  timeMin: string;
  timeMax: string;
  events: CalendarEventView[];
  availability: CalendarAvailabilitySummary;
  truncated: boolean;
  fetchedAt: string;
}

export interface CalendarConnectorResult {
  status: CalendarConnectorStatus;
  snapshot?: CalendarSnapshot;
  message?: string;
  retryable?: boolean;
}

export interface GoogleCalendarConnectorOptions {
  identity?: IdentityAdapter;
  fetcher?: Fetcher;
  now?: () => Date;
  timeZone?: string | (() => string);
}

export interface CalendarConnector {
  connect(): Promise<CalendarConnectorResult>;
  refresh(): Promise<CalendarConnectorResult>;
  reauthenticate(): Promise<CalendarConnectorResult>;
  disconnect(): Promise<CalendarConnectorResult>;
}

interface CalendarWindow {
  timeMin: Date;
  timeMax: Date;
  timeMinText: string;
  timeMaxText: string;
  timeZone: string;
}

interface ParsedEvent {
  view: CalendarEventView;
  start: Date;
  end: Date;
}

interface CalendarItemsPage {
  nextPageToken?: string;
  timeZone?: string;
  items: unknown[];
}

interface HttpFailure {
  status: number;
  retryable: boolean;
  message: string;
}

const DEFAULT_FETCHER: Fetcher = (input, init) => {
  if (typeof globalThis.fetch !== "function") {
    return Promise.reject(new Error("fetch is unavailable"));
  }
  return globalThis.fetch(input, init);
};

const CHROME_IDENTITY_ADAPTER: IdentityAdapter = {
  async getAuthToken(details) {
    const result = await chrome.identity.getAuthToken(details);
    const token = result.token;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("Google authorization token is unavailable.");
    }
    return token;
  },
  async removeCachedAuthToken(details) {
    await chrome.identity.removeCachedAuthToken(details);
  },
};

export function createChromeIdentityAdapter(): IdentityAdapter {
  return CHROME_IDENTITY_ADAPTER;
}

export class GoogleCalendarConnector implements CalendarConnector {
  private readonly identity: IdentityAdapter;
  private readonly fetcher: Fetcher;
  private readonly now: () => Date;
  private readonly timeZone: string | (() => string) | undefined;

  constructor(options: GoogleCalendarConnectorOptions = {}) {
    this.identity = options.identity ?? CHROME_IDENTITY_ADAPTER;
    this.fetcher = options.fetcher ?? DEFAULT_FETCHER;
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone;
  }

  async connect(): Promise<CalendarConnectorResult> {
    return this.readCalendar(true);
  }

  async refresh(): Promise<CalendarConnectorResult> {
    return this.readCalendar(false);
  }

  async reauthenticate(): Promise<CalendarConnectorResult> {
    return this.readCalendar(true);
  }

  async disconnect(): Promise<CalendarConnectorResult> {
    let token: string | undefined;
    let revokeFailed = false;

    try {
      token = await this.identity.getAuthToken({
        interactive: false,
        scopes: [GOOGLE_CALENDAR_SCOPE],
      });
    } catch {
      // A missing cached token still leaves the connector safely disconnected.
    }

    if (typeof token === "string" && token.length > 0) {
      try {
        const response = await this.fetcher(GOOGLE_OAUTH_REVOKE_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: `token=${encodeURIComponent(token)}`,
        });
        if (!response.ok) {
          revokeFailed = true;
        }
      } catch {
        revokeFailed = true;
      }

      try {
        await this.identity.removeCachedAuthToken({ token });
      } catch {
        // Clearing the UI remains the safe outcome even if Chrome rejects this.
      }
    }

    return {
      status: "not_connected",
      ...(revokeFailed
        ? {
            message:
              "Google Calendarを切断しました。Google側の失効確認は完了しませんでした。",
          }
        : {}),
    };
  }

  private async readCalendar(
    interactive: boolean,
  ): Promise<CalendarConnectorResult> {
    let token: string;
    try {
      token = await this.identity.getAuthToken({
        interactive,
        scopes: [GOOGLE_CALENDAR_SCOPE],
      });
      if (token.length === 0) {
        throw new Error("Google authorization token is unavailable.");
      }
    } catch {
      return interactive
        ? unavailableResult(
            "Google Calendarを接続できませんでした。登録済みのOAuth設定と権限を確認してください。",
          )
        : reauthRequiredResult();
    }

    let window: CalendarWindow;
    try {
      window = createCalendarWindow(
        this.now(),
        resolveRequestedTimeZone(this.timeZone),
      );
    } catch {
      return unavailableResult(
        "ローカルのタイムゾーンを確認できないため、Google Calendarを読み取れません。",
      );
    }
    let response = await this.fetchEvents(token, window);

    if (response.kind === "http" && response.failure.status === 401) {
      try {
        await this.identity.removeCachedAuthToken({ token });
      } catch {
        // Continue with the required single non-interactive token refresh.
      }

      let replacementToken: string;
      try {
        replacementToken = await this.identity.getAuthToken({
          interactive: false,
          scopes: [GOOGLE_CALENDAR_SCOPE],
        });
        if (replacementToken.length === 0) {
          throw new Error("Google authorization token is unavailable.");
        }
      } catch {
        return reauthRequiredResult();
      }

      response = await this.fetchEvents(replacementToken, window);
      if (response.kind === "http" && response.failure.status === 401) {
        try {
          await this.identity.removeCachedAuthToken({
            token: replacementToken,
          });
        } catch {
          // The UI still needs an explicit reauthentication state.
        }
      }
    }

    if (response.kind === "http") {
      if (response.failure.status === 401) {
        return reauthRequiredResult();
      }
      return unavailableResult(
        response.failure.message,
        response.failure.retryable,
      );
    }

    if (response.kind === "network") {
      return unavailableResult(
        "Google Calendarに接続できませんでした。時間をおいて再試行してください。",
        true,
      );
    }

    const parsed = buildCalendarSnapshot(response.pages, window, this.now());
    if (parsed === null) {
      return unavailableResult(
        "Google Calendarの応答を安全に読み取れませんでした。",
      );
    }

    return { status: "connected", snapshot: parsed };
  }

  private async fetchEvents(
    token: string,
    window: CalendarWindow,
  ): Promise<
    | { kind: "success"; pages: CalendarItemsPage[] }
    | { kind: "http"; failure: HttpFailure }
    | { kind: "network" }
  > {
    const pages: CalendarItemsPage[] = [];
    let pageToken: string | undefined;

    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const url = buildEventsUrl(window, pageToken);
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
          },
        });
      } catch {
        return { kind: "network" };
      }

      if (!response.ok) {
        return {
          kind: "http",
          failure: await classifyHttpFailure(response),
        };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return {
          kind: "http",
          failure: {
            status: 200,
            retryable: false,
            message: "Google Calendarの応答を安全に読み取れませんでした。",
          },
        };
      }

      const page = parseItemsPage(body);
      if (page === null) {
        return {
          kind: "http",
          failure: {
            status: 200,
            retryable: false,
            message: "Google Calendarの応答を安全に読み取れませんでした。",
          },
        };
      }
      pages.push(page);

      if (page.items.length > MAX_EVENTS || page.nextPageToken === undefined) {
        break;
      }
      pageToken = page.nextPageToken;
    }

    return { kind: "success", pages };
  }
}

export function buildEventsUrl(
  window: Pick<CalendarWindow, "timeMinText" | "timeMaxText" | "timeZone">,
  pageToken?: string,
): string {
  const url = new URL(GOOGLE_CALENDAR_EVENTS_ENDPOINT);
  url.searchParams.set("timeMin", window.timeMinText);
  url.searchParams.set("timeMax", window.timeMaxText);
  url.searchParams.set("timeZone", window.timeZone);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("showDeleted", "false");
  url.searchParams.set("maxResults", "100");
  url.searchParams.set("fields", CALENDAR_FIELDS);
  if (pageToken !== undefined) {
    url.searchParams.set("pageToken", pageToken);
  }
  return url.toString();
}

export function createCalendarWindow(
  now: Date,
  timeZone = resolveTimeZone(),
): {
  timeMin: Date;
  timeMax: Date;
  timeMinText: string;
  timeMaxText: string;
  timeZone: string;
} {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Invalid current time.");
  }
  const localDate = getLocalDateParts(now, timeZone);
  const startDate = toDateParts(localDate.year, localDate.month, localDate.day);
  const endDate = addCalendarDays(startDate, DAYS_AHEAD);
  const timeMin = localMidnight(startDate, timeZone);
  const timeMax = localMidnight(endDate, timeZone);

  return {
    timeMin,
    timeMax,
    timeMinText: formatRfc3339(timeMin, timeZone),
    timeMaxText: formatRfc3339(timeMax, timeZone),
    timeZone,
  };
}

export function parseCalendarEvent(
  value: unknown,
  timeZone: string,
): ParsedCalendarEvent | null {
  const parsed = parseEvent(value, timeZone);
  return parsed?.view ?? null;
}

export interface ParsedCalendarEvent extends CalendarEventView {}

export function calculateAvailability(
  events: CalendarEventView[],
  window: Pick<CalendarWindow, "timeMin" | "timeMax">,
  timeZone: string,
  options: { truncated?: boolean; malformed?: boolean } = {},
): CalendarAvailabilitySummary {
  if (options.truncated || options.malformed) {
    return {
      status: "unknown",
      availableMinutes: null,
      busyMinutes: null,
      intervals: [],
      reason: options.truncated
        ? "予定の取得件数が上限に達したため、空き時間を確定できません。"
        : "形式を確認できない予定があるため、空き時間を確定できません。",
    };
  }

  const busyIntervals: Array<{ start: Date; end: Date }> = [];
  for (const event of events) {
    if (event.transparency === "transparent" || event.status === "cancelled") {
      continue;
    }
    const start = parseEventViewDate(event.start, event.allDay, timeZone);
    const end = parseEventViewDate(event.end, event.allDay, timeZone);
    if (!validInterval(start, end)) {
      return {
        status: "unknown",
        availableMinutes: null,
        busyMinutes: null,
        intervals: [],
        reason: "形式を確認できない予定があるため、空き時間を確定できません。",
      };
    }
    const clippedStart = new Date(
      Math.max(start.getTime(), window.timeMin.getTime()),
    );
    const clippedEnd = new Date(
      Math.min(end.getTime(), window.timeMax.getTime()),
    );
    if (validInterval(clippedStart, clippedEnd)) {
      busyIntervals.push({ start: clippedStart, end: clippedEnd });
    }
  }

  const merged = mergeIntervals(busyIntervals);
  const available: Array<{ start: Date; end: Date }> = [];
  let cursor = window.timeMin;
  for (const interval of merged) {
    if (cursor.getTime() < interval.start.getTime()) {
      available.push({ start: cursor, end: interval.start });
    }
    if (interval.end.getTime() > cursor.getTime()) {
      cursor = interval.end;
    }
  }
  if (cursor.getTime() < window.timeMax.getTime()) {
    available.push({ start: cursor, end: window.timeMax });
  }

  const windowMinutes = minutesBetween(window.timeMin, window.timeMax);
  const availableMinutes = available.reduce(
    (total, interval) => total + minutesBetween(interval.start, interval.end),
    0,
  );
  return {
    status: "known",
    availableMinutes,
    busyMinutes: Math.max(0, windowMinutes - availableMinutes),
    intervals: available.map((interval) => ({
      start: formatRfc3339(interval.start, timeZone),
      end: formatRfc3339(interval.end, timeZone),
    })),
  };
}

export function formatAvailabilitySummary(
  availability: CalendarAvailabilitySummary,
): string {
  if (availability.status === "unknown") {
    return availability.reason ?? "空き時間を確定できません。";
  }
  return `空き時間 ${availability.availableMinutes ?? 0}分（取得範囲内）`;
}

function buildCalendarSnapshot(
  pages: CalendarItemsPage[],
  window: CalendarWindow,
  now: Date,
): CalendarSnapshot | null {
  const rawEvents = pages.flatMap((page) => page.items);
  const truncated =
    pages.length >= MAX_PAGES &&
    pages[pages.length - 1]?.nextPageToken !== undefined;
  const boundedRawEvents = rawEvents.slice(0, MAX_EVENTS);
  const tooManyEvents =
    rawEvents.length > MAX_EVENTS ||
    pages.some((page) => page.items.length > MAX_EVENTS_PER_PAGE);

  const events: CalendarEventView[] = [];
  let malformed = false;
  for (const rawEvent of boundedRawEvents) {
    const parsed = parseEvent(rawEvent, window.timeZone);
    if (parsed === null) {
      malformed = true;
      continue;
    }
    if (
      parsed.end.getTime() > window.timeMin.getTime() &&
      parsed.start.getTime() < window.timeMax.getTime()
    ) {
      events.push(parsed.view);
    }
  }

  return {
    timeZone: window.timeZone,
    timeMin: window.timeMinText,
    timeMax: window.timeMaxText,
    events,
    availability: calculateAvailability(events, window, window.timeZone, {
      truncated: truncated || tooManyEvents,
      malformed,
    }),
    truncated: truncated || tooManyEvents,
    fetchedAt: now.toISOString(),
  };
}

function parseItemsPage(value: unknown): CalendarItemsPage | null {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return null;
  }
  if (
    value.nextPageToken !== undefined &&
    (typeof value.nextPageToken !== "string" ||
      value.nextPageToken.length === 0)
  ) {
    return null;
  }
  if (value.timeZone !== undefined && typeof value.timeZone !== "string") {
    return null;
  }
  return {
    items: value.items,
    ...(value.nextPageToken !== undefined
      ? { nextPageToken: value.nextPageToken }
      : {}),
    ...(value.timeZone !== undefined ? { timeZone: value.timeZone } : {}),
  };
}

function parseEvent(value: unknown, timeZone: string): ParsedEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readNonEmptyString(value.id);
  const status = readNonEmptyString(value.status);
  const summary =
    typeof value.summary === "string" ? value.summary : "（無題）";
  const transparency =
    typeof value.transparency === "string" ? value.transparency : "opaque";
  const eventType =
    typeof value.eventType === "string" ? value.eventType : "default";
  const endTimeUnspecified =
    value.endTimeUnspecified === undefined
      ? false
      : typeof value.endTimeUnspecified === "boolean"
        ? value.endTimeUnspecified
        : null;
  if (id === null || status === null || endTimeUnspecified === null) {
    return null;
  }

  const startValue = isRecord(value.start) ? value.start : null;
  const endValue = isRecord(value.end) ? value.end : null;
  if (startValue === null || endValue === null) {
    return null;
  }

  const parsedStart = parseCalendarBoundary(startValue, timeZone);
  const parsedEnd = parseCalendarBoundary(endValue, timeZone);
  if (parsedStart === null || parsedEnd === null) {
    return null;
  }
  if (parsedStart.allDay !== parsedEnd.allDay) {
    return null;
  }
  if (!validInterval(parsedStart.date, parsedEnd.date)) {
    return null;
  }

  return {
    start: parsedStart.date,
    end: parsedEnd.date,
    view: {
      id,
      status,
      summary,
      start: parsedStart.raw,
      end: parsedEnd.raw,
      allDay: parsedStart.allDay && parsedEnd.allDay,
      endTimeUnspecified,
      transparency,
      eventType,
    },
  };
}

function parseCalendarBoundary(
  value: Record<string, unknown>,
  timeZone: string,
): { date: Date; raw: string; allDay: boolean } | null {
  if (
    typeof value.dateTime === "string" &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(value.dateTime)
  ) {
    const date = new Date(value.dateTime);
    if (!Number.isFinite(date.getTime())) {
      return null;
    }
    return { date, raw: date.toISOString(), allDay: false };
  }
  if (
    typeof value.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.date)
  ) {
    const [yearText, monthText, dayText] = value.date.split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    try {
      const dateParts = toDateParts(year, month, day);
      const date = localMidnight(dateParts, timeZone);
      if (
        !Number.isFinite(date.getTime()) ||
        formatDateOnly(date, timeZone) !== value.date
      ) {
        return null;
      }
      return { date, raw: value.date, allDay: true };
    } catch {
      return null;
    }
  }
  return null;
}

function parseEventViewDate(
  value: string,
  allDay: boolean,
  timeZone: string,
): Date {
  if (allDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [yearText, monthText, dayText] = value.split("-");
    try {
      return localMidnight(
        toDateParts(Number(yearText), Number(monthText), Number(dayText)),
        timeZone,
      );
    } catch {
      return new Date(Number.NaN);
    }
  }
  return new Date(value);
}

async function classifyHttpFailure(response: Response): Promise<HttpFailure> {
  let reason = "";
  try {
    const responseForJson =
      typeof response.clone === "function" ? response.clone() : response;
    const body: unknown = await responseForJson.json();
    reason = extractErrorReason(body);
  } catch {
    // The status still gives us a safe classification.
  }

  const normalizedReason = reason.toLowerCase().replace(/[^a-z0-9]/g, "");
  const isRateLimit =
    response.status === 429 ||
    (response.status === 403 &&
      [
        "ratelimitexceeded",
        "userratelimitexceeded",
        "quotaexceeded",
        "dailylimitexceeded",
        "backenderror",
        "resourceexhausted",
        "rate_limit_exceeded",
      ].some((marker) =>
        normalizedReason.includes(marker.replace(/[^a-z0-9]/g, "")),
      ));
  if (isRateLimit) {
    return {
      status: response.status,
      retryable: true,
      message:
        "Google Calendarの利用上限または一時的な制限です。時間をおいて再試行してください。",
    };
  }

  return {
    status: response.status,
    retryable: response.status >= 500,
    message:
      response.status === 403
        ? "Google Calendarの権限または設定を確認できません。"
        : "Google Calendarに接続できませんでした。時間をおいて再試行してください。",
  };
}

function extractErrorReason(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.error)) {
    return "";
  }
  const error = value.error;
  const reasons: string[] = [];
  if (typeof error.status === "string") {
    reasons.push(error.status);
  }
  if (typeof error.message === "string") {
    reasons.push(error.message);
  }
  if (Array.isArray(error.errors)) {
    for (const item of error.errors) {
      if (isRecord(item) && typeof item.reason === "string") {
        reasons.push(item.reason);
      }
    }
  }
  return reasons.join(" ");
}

function unavailableResult(
  message: string,
  retryable = false,
): CalendarConnectorResult {
  return { status: "unavailable", message, retryable };
}

function reauthRequiredResult(): CalendarConnectorResult {
  return {
    status: "reauth_required",
    message:
      "Google Calendarの認証が期限切れです。明示的に再認証してください。",
  };
}

function resolveTimeZone(): string {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof timeZone === "string" && timeZone.length > 0
      ? timeZone
      : "UTC";
  } catch {
    return "UTC";
  }
}

function resolveRequestedTimeZone(
  timeZone: string | (() => string) | undefined,
): string {
  const resolved = typeof timeZone === "function" ? timeZone() : timeZone;
  return typeof resolved === "string" && resolved.length > 0
    ? resolved
    : resolveTimeZone();
}

function getLocalDateParts(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const parts = formatDateTimeParts(instant, timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function localMidnight(
  parts: { year: number; month: number; day: number },
  timeZone: string,
): Date {
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
  let guess = localAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offset = timeZoneOffsetMs(new Date(guess), timeZone);
    const next = localAsUtc - offset;
    if (next === guess) {
      break;
    }
    guess = next;
  }
  return new Date(guess);
}

function formatRfc3339(instant: Date, timeZone: string): string {
  const parts = formatDateTimeParts(instant, timeZone);
  const offsetMinutes = Math.round(timeZoneOffsetMs(instant, timeZone) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absoluteOffset / 60)).padStart(2, "0");
  const minutes = String(absoluteOffset % 60).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${sign}${hours}:${minutes}`;
}

function formatDateOnly(instant: Date, timeZone: string): string {
  const parts = formatDateTimeParts(instant, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function formatDateTimeParts(
  instant: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(instant);
  const values = new Map(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  const hour = values.get("hour");
  const minute = values.get("minute");
  const second = values.get("second");
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    throw new Error("Could not format date parts.");
  }
  return { year, month, day, hour, minute, second };
}

function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = formatDateTimeParts(instant, timeZone);
  return (
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ) - instant.getTime()
  );
}

function toDateParts(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new Error("Invalid calendar date.");
  }
  return { year, month, day };
}

function addCalendarDays(
  parts: { year: number; month: number; day: number },
  days: number,
) {
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days),
  );
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function validInterval(start: Date, end: Date): boolean {
  return (
    Number.isFinite(start.getTime()) &&
    Number.isFinite(end.getTime()) &&
    start.getTime() < end.getTime()
  );
}

function mergeIntervals(
  intervals: Array<{ start: Date; end: Date }>,
): Array<{ start: Date; end: Date }> {
  const sorted = [...intervals].sort(
    (left, right) => left.start.getTime() - right.start.getTime(),
  );
  const merged: Array<{ start: Date; end: Date }> = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (
      previous === undefined ||
      interval.start.getTime() > previous.end.getTime()
    ) {
      merged.push({ ...interval });
    } else if (interval.end.getTime() > previous.end.getTime()) {
      previous.end = interval.end;
    }
  }
  return merged;
}

function minutesBetween(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / 60000);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
