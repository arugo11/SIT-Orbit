import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEventsUrl,
  calculateAvailability,
  createCalendarWindow,
  GOOGLE_CALENDAR_EVENTS_ENDPOINT,
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_OAUTH_REVOKE_ENDPOINT,
  GoogleCalendarConnector,
  type IdentityAdapter,
  parseCalendarEvent,
} from "./google-calendar";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function calendarEvent(
  id: string,
  start: Record<string, string>,
  end: Record<string, string>,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    status: "confirmed",
    summary: id,
    start,
    end,
    endTimeUnspecified: false,
    transparency: "opaque",
    eventType: "default",
    ...extra,
  };
}

function identityWithTokens(tokens: string[]): IdentityAdapter {
  return {
    getAuthToken: vi.fn(async () => {
      const token = tokens.shift();
      if (token === undefined) {
        throw new Error("reauthentication required");
      }
      return token;
    }),
    removeCachedAuthToken: vi.fn(async () => undefined),
  };
}

const NOW = new Date("2026-08-15T12:00:00+09:00");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google Calendar connector adversarial boundaries", () => {
  it("[CAL-001] uses only the locked scope, primary endpoint, and seven-day local window", async () => {
    const token = "calendar-test-token";
    const identity = identityWithTokens([token]);
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        expect(url.origin + url.pathname).toBe(GOOGLE_CALENDAR_EVENTS_ENDPOINT);
        expect(url.pathname).not.toContain("calendarlist");
        expect(url.pathname).not.toBe("/calendar/v3/calendars");
        expect(url.searchParams.get("timeMin")).toBe(
          "2026-08-15T00:00:00+09:00",
        );
        expect(url.searchParams.get("timeMax")).toBe(
          "2026-08-22T00:00:00+09:00",
        );
        expect(url.searchParams.get("timeZone")).toBe("Asia/Tokyo");
        expect(url.searchParams.get("singleEvents")).toBe("true");
        expect(url.searchParams.get("orderBy")).toBe("startTime");
        expect(url.searchParams.get("maxResults")).toBe("100");
        expect(url.searchParams.get("pageToken")).toBeNull();
        if (init?.headers === undefined) {
          throw new Error("Expected request headers.");
        }
        expect((init.headers as Record<string, string>).Authorization).toBe(
          `Bearer ${token}`,
        );
        return jsonResponse({ items: [] });
      },
    );
    const connector = new GoogleCalendarConnector({
      identity,
      fetcher,
      now: () => NOW,
      timeZone: "Asia/Tokyo",
    });

    expect(GOOGLE_CALENDAR_SCOPE).toBe(
      "https://www.googleapis.com/auth/calendar.events.owned.readonly",
    );
    expect(GOOGLE_CALENDAR_SCOPE).not.toContain("calendar.readonly");
    expect(GOOGLE_CALENDAR_SCOPE).not.toContain("calendarlist");
    expect(
      new URL(buildEventsUrl(createCalendarWindow(NOW, "Asia/Tokyo"))).pathname,
    ).toBe("/calendar/v3/calendars/primary/events");

    await expect(connector.connect()).resolves.toMatchObject({
      status: "connected",
    });
    expect(identity.getAuthToken).toHaveBeenCalledTimes(1);
    expect(identity.getAuthToken).toHaveBeenCalledWith({
      interactive: true,
      scopes: [GOOGLE_CALENDAR_SCOPE],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("[CAL-002] keeps ordinary tests on injected identity/fetch and never uses live global fetch", async () => {
    const globalFetch = vi.fn(async () => {
      throw new Error("live Google fetch must not run in ordinary tests");
    });
    vi.stubGlobal("fetch", globalFetch);

    const token = "injected-calendar-token";
    const identity = identityWithTokens([token]);
    const injectedFetcher = vi.fn(async () => jsonResponse({ items: [] }));
    const connector = new GoogleCalendarConnector({
      identity,
      fetcher: injectedFetcher,
      now: () => NOW,
      timeZone: "Asia/Tokyo",
    });

    const result = await connector.connect();

    expect(result.status).toBe("connected");
    expect(injectedFetcher).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("[CAL-003] parses timed and all-day events while failing closed on malformed intervals", async () => {
    const timed = calendarEvent(
      "timed",
      { dateTime: "2026-08-15T09:00:00+09:00" },
      { dateTime: "2026-08-15T10:00:00+09:00" },
    );
    const allDay = calendarEvent(
      "all-day",
      { date: "2026-08-16" },
      { date: "2026-08-17" },
    );
    const malformed = calendarEvent(
      "malformed",
      { dateTime: "2026-08-15T11:00:00+09:00" },
      { dateTime: "2026-08-15T10:00:00+09:00" },
    );

    expect(parseCalendarEvent(timed, "Asia/Tokyo")).toMatchObject({
      id: "timed",
      allDay: false,
    });
    expect(parseCalendarEvent(allDay, "Asia/Tokyo")).toMatchObject({
      id: "all-day",
      allDay: true,
    });

    const window = createCalendarWindow(NOW, "Asia/Tokyo");
    const malformedView = {
      id: "malformed",
      status: "confirmed",
      summary: "malformed",
      start: "2026-08-15T11:00:00+09:00",
      end: "2026-08-15T10:00:00+09:00",
      allDay: false,
      endTimeUnspecified: false,
      transparency: "opaque",
      eventType: "default",
    };
    const availability = calculateAvailability(
      [malformedView],
      window,
      "Asia/Tokyo",
    );
    expect(availability).toMatchObject({
      status: "unknown",
      availableMinutes: null,
      busyMinutes: null,
    });

    const connector = new GoogleCalendarConnector({
      identity: identityWithTokens(["calendar-test-token"]),
      fetcher: vi.fn(async () =>
        jsonResponse({ items: [timed, malformed, allDay] }),
      ),
      now: () => NOW,
      timeZone: "Asia/Tokyo",
    });
    const result = await connector.connect();
    expect(result.snapshot?.events.map((event) => event.id)).toEqual([
      "timed",
      "all-day",
    ]);
    expect(result.snapshot?.availability).toMatchObject({
      status: "unknown",
      availableMinutes: null,
      busyMinutes: null,
    });
  });

  it("[CAL-004] treats transparent events as free, opaque events as busy, and malformed data as unknown", () => {
    const window = createCalendarWindow(NOW, "Asia/Tokyo");
    const opaque = calendarEvent(
      "opaque",
      { dateTime: "2026-08-15T09:00:00+09:00" },
      { dateTime: "2026-08-15T10:00:00+09:00" },
    );
    const transparent = calendarEvent(
      "transparent",
      { dateTime: "2026-08-15T11:00:00+09:00" },
      { dateTime: "2026-08-15T12:00:00+09:00" },
      { transparency: "transparent" },
    );
    const parsedOpaque = parseCalendarEvent(opaque, "Asia/Tokyo");
    const parsedTransparent = parseCalendarEvent(transparent, "Asia/Tokyo");
    if (parsedOpaque === null || parsedTransparent === null) {
      throw new Error("Expected valid calendar events.");
    }

    const availability = calculateAvailability(
      [parsedOpaque, parsedTransparent],
      window,
      "Asia/Tokyo",
    );
    expect(availability.status).toBe("known");
    expect(availability.busyMinutes).toBe(60);
    expect(availability.availableMinutes).toBe(10020);
  });

  it("[CAL-005] caps pagination at three pages and marks availability unknown when truncated", async () => {
    const identity = identityWithTokens(["calendar-test-token"]);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ items: [], nextPageToken: "page-2" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ items: [], nextPageToken: "page-3" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ items: [], nextPageToken: "page-4" }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [] }));
    const connector = new GoogleCalendarConnector({
      identity,
      fetcher,
      now: () => NOW,
      timeZone: "Asia/Tokyo",
    });

    const result = await connector.connect();

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get("pageToken"),
    ).toBeNull();
    expect(
      new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get("pageToken"),
    ).toBe("page-2");
    expect(
      new URL(String(fetcher.mock.calls[2]?.[0])).searchParams.get("pageToken"),
    ).toBe("page-3");
    expect(result.snapshot).toMatchObject({
      truncated: true,
      availability: {
        status: "unknown",
        availableMinutes: null,
        busyMinutes: null,
      },
    });
  });

  it("[CAL-006] marks an overlarge page truncated instead of claiming all time is free", async () => {
    const items = Array.from({ length: 101 }, (_, index) =>
      calendarEvent(
        `event-${index}`,
        { dateTime: "2026-08-15T09:00:00+09:00" },
        { dateTime: "2026-08-15T10:00:00+09:00" },
      ),
    );
    const connector = new GoogleCalendarConnector({
      identity: identityWithTokens(["calendar-test-token"]),
      fetcher: vi.fn(async () => jsonResponse({ items })),
      now: () => NOW,
      timeZone: "Asia/Tokyo",
    });

    const result = await connector.connect();

    expect(result.snapshot?.truncated).toBe(true);
    expect(result.snapshot?.availability.status).toBe("unknown");
    expect(result.snapshot?.availability.availableMinutes).toBeNull();
  });

  it("[CAL-007] removes the expired token and retries one time non-interactively after 401", async () => {
    const identity = identityWithTokens(["expired-token", "fresh-token"]);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: {} }, 401))
      .mockResolvedValueOnce(jsonResponse({ items: [] }));
    const connector = new GoogleCalendarConnector({
      identity,
      fetcher,
      now: () => NOW,
      timeZone: "Asia/Tokyo",
    });

    const result = await connector.connect();

    expect(result.status).toBe("connected");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(identity.removeCachedAuthToken).toHaveBeenCalledTimes(1);
    expect(identity.removeCachedAuthToken).toHaveBeenCalledWith({
      token: "expired-token",
    });
    expect(identity.getAuthToken).toHaveBeenCalledTimes(2);
    expect(identity.getAuthToken).toHaveBeenNthCalledWith(2, {
      interactive: false,
      scopes: [GOOGLE_CALENDAR_SCOPE],
    });
    expect(JSON.stringify(result)).not.toContain("expired-token");
    expect(JSON.stringify(result)).not.toContain("fresh-token");
  });

  it("[CAL-008] returns reauth_required after exactly one retry also receives 401", async () => {
    const identity = identityWithTokens(["expired-token", "fresh-token"]);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: {} }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: {} }, 401))
      .mockResolvedValueOnce(jsonResponse({ items: [] }));
    const connector = new GoogleCalendarConnector({
      identity,
      fetcher,
      now: () => NOW,
      timeZone: "Asia/Tokyo",
    });

    const result = await connector.connect();

    expect(result).toMatchObject({ status: "reauth_required" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(identity.getAuthToken).toHaveBeenCalledTimes(2);
    expect(identity.removeCachedAuthToken).toHaveBeenCalledTimes(2);
    expect(identity.removeCachedAuthToken).toHaveBeenNthCalledWith(2, {
      token: "fresh-token",
    });
  });

  it("[CAL-009] does not broaden scope after a permission 403", async () => {
    const identity = identityWithTokens(["calendar-test-token"]);
    const fetcher = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            status: "PERMISSION_DENIED",
            errors: [{ reason: "insufficientPermissions" }],
          },
        },
        403,
      ),
    );
    const connector = new GoogleCalendarConnector({
      identity,
      fetcher,
      now: () => NOW,
      timeZone: "Asia/Tokyo",
    });

    const result = await connector.connect();

    expect(result).toMatchObject({ status: "unavailable", retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(identity.getAuthToken).toHaveBeenCalledTimes(1);
    expect(identity.getAuthToken).toHaveBeenCalledWith({
      interactive: true,
      scopes: [GOOGLE_CALENDAR_SCOPE],
    });
    expect(JSON.stringify(result)).not.toContain("calendar.readonly");
    expect(JSON.stringify(result)).not.toContain("calendarlist");
  });

  it("[CAL-010] marks 429 unavailable and retryable without a second Google call", async () => {
    const identity = identityWithTokens(["calendar-test-token"]);
    const fetcher = vi.fn(async () => jsonResponse({}, 429));
    const connector = new GoogleCalendarConnector({
      identity,
      fetcher,
      now: () => NOW,
      timeZone: "Asia/Tokyo",
    });

    const result = await connector.connect();

    expect(result).toMatchObject({ status: "unavailable", retryable: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(identity.getAuthToken).toHaveBeenCalledTimes(1);
  });

  it("[CAL-011] revokes only on explicit disconnect, clears state, and keeps the token out of the result", async () => {
    const token = "disconnect-secret-token";
    const identity = identityWithTokens([token]);
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(GOOGLE_OAUTH_REVOKE_ENDPOINT);
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(`token=${encodeURIComponent(token)}`);
        return jsonResponse({}, 200);
      },
    );
    const connector = new GoogleCalendarConnector({ identity, fetcher });

    const result = await connector.disconnect();

    expect(result).toEqual({ status: "not_connected" });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(identity.getAuthToken).toHaveBeenCalledWith({
      interactive: false,
      scopes: [GOOGLE_CALENDAR_SCOPE],
    });
    expect(identity.removeCachedAuthToken).toHaveBeenCalledWith({ token });
  });
});
