import { describe, expect, it, vi } from "vitest";
import {
  buildEventsUrl,
  type CalendarEventView,
  calculateAvailability,
  createCalendarWindow,
  GOOGLE_CALENDAR_EVENTS_ENDPOINT,
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_OAUTH_REVOKE_ENDPOINT,
  GoogleCalendarConnector,
  type IdentityAdapter,
  parseCalendarEvent,
  projectCalendarAvailability,
} from "./google-calendar";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function event(
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
      if (!token) {
        throw new Error("reauthentication required");
      }
      return token;
    }),
    removeCachedAuthToken: vi.fn(async () => undefined),
  };
}

function parsedEventOrThrow(
  value: unknown,
  timeZone: string,
): CalendarEventView {
  const parsed = parseCalendarEvent(value, timeZone);
  if (parsed === null) {
    throw new Error("Expected a valid calendar event.");
  }
  return parsed;
}

describe("Google Calendar connector", () => {
  const now = new Date("2026-08-15T12:00:00+09:00");

  it("builds the bounded local window and fixed events.list contract", () => {
    const window = createCalendarWindow(now, "Asia/Tokyo");
    expect(window.timeMinText).toBe("2026-08-15T00:00:00+09:00");
    expect(window.timeMaxText).toBe("2026-08-22T00:00:00+09:00");

    const url = new URL(buildEventsUrl(window));
    expect(url.origin + url.pathname).toBe(GOOGLE_CALENDAR_EVENTS_ENDPOINT);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      timeMin: "2026-08-15T00:00:00+09:00",
      timeMax: "2026-08-22T00:00:00+09:00",
      timeZone: "Asia/Tokyo",
      singleEvents: "true",
      orderBy: "startTime",
      showDeleted: "false",
      maxResults: "100",
      fields:
        "nextPageToken,timeZone,items(id,status,summary,start,end,endTimeUnspecified,transparency,eventType)",
    });
  });

  it("parses timed and all-day boundaries while rejecting malformed intervals", () => {
    expect(
      parsedEventOrThrow(
        event(
          "timed",
          { dateTime: "2026-08-15T09:00:00+09:00" },
          { dateTime: "2026-08-15T10:00:00+09:00" },
        ),
        "Asia/Tokyo",
      ),
    ).toMatchObject({ id: "timed", allDay: false });
    expect(
      parsedEventOrThrow(
        event("all-day", { date: "2026-08-16" }, { date: "2026-08-17" }),
        "Asia/Tokyo",
      ),
    ).toMatchObject({ id: "all-day", allDay: true });
    expect(
      parseCalendarEvent(
        event(
          "malformed",
          { dateTime: "2026-08-15T10:00:00+09:00" },
          { dateTime: "2026-08-15T09:00:00+09:00" },
        ),
        "Asia/Tokyo",
      ),
    ).toBeNull();
  });

  it("treats transparent events as non-blocking and reports local availability", () => {
    const window = createCalendarWindow(now, "Asia/Tokyo");
    const events: CalendarEventView[] = [
      parsedEventOrThrow(
        event(
          "opaque",
          { dateTime: "2026-08-15T09:00:00+09:00" },
          { dateTime: "2026-08-15T10:00:00+09:00" },
        ),
        "Asia/Tokyo",
      ),
      parsedEventOrThrow(
        event(
          "transparent",
          { dateTime: "2026-08-15T11:00:00+09:00" },
          { dateTime: "2026-08-15T12:00:00+09:00" },
          { transparency: "transparent" },
        ),
        "Asia/Tokyo",
      ),
    ];
    const availability = calculateAvailability(events, window, "Asia/Tokyo");
    expect(availability.status).toBe("known");
    expect(availability.busyMinutes).toBe(60);
    expect(availability.availableMinutes).toBe(10020);

    const projection = projectCalendarAvailability({
      timeZone: "Asia/Tokyo",
      timeMin: window.timeMinText,
      timeMax: window.timeMaxText,
      events,
      availability,
      truncated: false,
      fetchedAt: "2026-08-15T03:00:00.000Z",
    });
    expect(projection).toMatchObject({
      schema_version: "v1",
      status: "known",
      busy_minutes: 60,
      available_minutes: 10020,
    });
    expect(JSON.stringify(projection)).not.toContain("opaque");
    expect(JSON.stringify(projection)).not.toContain("transparent");
  });

  it("connects only with the explicit call and sends no token outside the request", async () => {
    const identity = identityWithTokens(["access-token"]);
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toContain(GOOGLE_CALENDAR_EVENTS_ENDPOINT);
        if (init === undefined) {
          throw new Error("Expected request options.");
        }
        expect((init.headers as Record<string, string>).Authorization).toBe(
          "Bearer access-token",
        );
        return response({ items: [] });
      },
    );
    const connector = new GoogleCalendarConnector({
      identity,
      fetcher,
      now: () => now,
      timeZone: "Asia/Tokyo",
    });

    expect(fetcher).not.toHaveBeenCalled();
    const result = await connector.connect();
    expect(result.status).toBe("connected");
    expect(result).not.toHaveProperty("token");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(identity.getAuthToken).toHaveBeenCalledWith({
      interactive: true,
      scopes: [GOOGLE_CALENDAR_SCOPE],
    });
  });

  it("retries a 401 once with a non-interactive token and marks a second 401 for reauth", async () => {
    const identity = identityWithTokens(["expired", "fresh"]);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response({ error: { status: "UNAUTHENTICATED" } }, 401),
      )
      .mockResolvedValueOnce(response({ items: [] }));
    const connector = new GoogleCalendarConnector({
      identity,
      fetcher,
      now: () => now,
      timeZone: "Asia/Tokyo",
    });

    expect((await connector.connect()).status).toBe("connected");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(identity.removeCachedAuthToken).toHaveBeenCalledTimes(1);
    expect(identity.getAuthToken).toHaveBeenNthCalledWith(2, {
      interactive: false,
      scopes: [GOOGLE_CALENDAR_SCOPE],
    });

    const secondIdentity = identityWithTokens(["expired", "fresh"]);
    const secondFetcher = vi
      .fn()
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({}, 401));
    const second = new GoogleCalendarConnector({
      identity: secondIdentity,
      fetcher: secondFetcher,
      now: () => now,
      timeZone: "Asia/Tokyo",
    });
    expect((await second.connect()).status).toBe("reauth_required");
    expect(secondFetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    [403, "rateLimitExceeded", true],
    [429, "", true],
    [403, "insufficientPermissions", false],
  ] as const)(
    "classifies Google failure status %i without broadening scope",
    async (status, reason, retryable) => {
      const identity = identityWithTokens(["access-token"]);
      const fetcher = vi.fn(async () =>
        response(
          {
            error: {
              status: "PERMISSION_DENIED",
              errors: [{ reason }],
            },
          },
          status,
        ),
      );
      const connector = new GoogleCalendarConnector({
        identity,
        fetcher,
        now: () => now,
        timeZone: "Asia/Tokyo",
      });
      const result = await connector.connect();
      expect(result).toMatchObject({ status: "unavailable", retryable });
      expect(identity.getAuthToken).toHaveBeenCalledWith({
        interactive: true,
        scopes: [GOOGLE_CALENDAR_SCOPE],
      });
      expect(identity.getAuthToken).toHaveBeenCalledTimes(1);
    },
  );

  it("follows at most three pages and fails closed for availability when truncated", async () => {
    const identity = identityWithTokens(["access-token"]);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ items: [], nextPageToken: "page-2" }))
      .mockResolvedValueOnce(response({ items: [], nextPageToken: "page-3" }))
      .mockResolvedValueOnce(response({ items: [], nextPageToken: "page-4" }))
      .mockResolvedValueOnce(response({ items: [] }));
    const connector = new GoogleCalendarConnector({
      identity,
      fetcher,
      now: () => now,
      timeZone: "Asia/Tokyo",
    });
    const result = await connector.connect();
    expect(result.status).toBe("connected");
    expect(result.snapshot?.truncated).toBe(true);
    expect(result.snapshot?.availability.status).toBe("unknown");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not claim free time from an overlarge provider page", async () => {
    const items = Array.from({ length: 101 }, (_, index) =>
      event(
        `event-${index}`,
        { dateTime: "2026-08-15T09:00:00+09:00" },
        { dateTime: "2026-08-15T10:00:00+09:00" },
      ),
    );
    const connector = new GoogleCalendarConnector({
      identity: identityWithTokens(["access-token"]),
      fetcher: vi.fn(async () => response({ items })),
      now: () => now,
      timeZone: "Asia/Tokyo",
    });

    const result = await connector.connect();
    expect(result.snapshot).toMatchObject({
      truncated: true,
      availability: {
        status: "unknown",
        availableMinutes: null,
        busyMinutes: null,
      },
    });
  });

  it("revokes and removes a token on explicit disconnect, then clears state", async () => {
    const identity = identityWithTokens(["access-token"]);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(GOOGLE_OAUTH_REVOKE_ENDPOINT);
      return response({}, 200);
    });
    const connector = new GoogleCalendarConnector({ identity, fetcher });
    const result = await connector.disconnect();
    expect(result).toEqual({ status: "not_connected" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(identity.removeCachedAuthToken).toHaveBeenCalledWith({
      token: "access-token",
    });
  });
});
