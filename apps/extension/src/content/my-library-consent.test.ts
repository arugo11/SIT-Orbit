import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMyLibrarySessionConsent,
  grantMyLibrarySessionConsent,
  hasMyLibrarySessionConsent,
  MY_LIBRARY_SESSION_CONSENT_KEY,
} from "./my-library-consent";

describe("My Library session consent", () => {
  let sessionValues: Record<string, unknown>;
  let sessionGet: ReturnType<typeof vi.fn>;
  let sessionSet: ReturnType<typeof vi.fn>;
  let sessionRemove: ReturnType<typeof vi.fn>;
  let permissionState: Set<string>;

  beforeEach(() => {
    sessionValues = {};
    permissionState = new Set();
    sessionGet = vi.fn(async (key: string | string[] | null) => {
      if (key === null) return { ...sessionValues };
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(
        keys
          .filter((item) => item in sessionValues)
          .map((item) => [item, sessionValues[item]]),
      );
    });
    sessionSet = vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(sessionValues, values);
    });
    sessionRemove = vi.fn(async (key: string | string[]) => {
      for (const item of Array.isArray(key) ? key : [key]) {
        delete sessionValues[item];
      }
    });
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          get: sessionGet,
          set: sessionSet,
          remove: sessionRemove,
        },
      },
      permissions: {
        contains: vi.fn(async ({ origins }: { origins: string[] }) =>
          origins.every((origin) => permissionState.has(origin)),
        ),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps consent independent from Full access, spans chats, and clears on disconnect", async () => {
    permissionState.add("https://*/*");

    // A broad browser permission is not a disclosure consent.
    expect(await hasMyLibrarySessionConsent()).toBe(false);
    expect(sessionValues).toEqual({});

    await expect(grantMyLibrarySessionConsent()).resolves.toBe(true);
    expect(sessionValues).toEqual({
      [MY_LIBRARY_SESSION_CONSENT_KEY]: true,
    });
    expect(sessionSet).toHaveBeenCalledWith({
      [MY_LIBRARY_SESSION_CONSENT_KEY]: true,
    });
    expect(Object.keys(sessionValues)).toEqual([
      MY_LIBRARY_SESSION_CONSENT_KEY,
    ]);

    // A later Chat instance reads the same session flag without a new grant.
    expect(await hasMyLibrarySessionConsent()).toBe(true);

    // Disconnect removes the flag and nothing else; no snapshot or account
    // data is ever written to session storage.
    await clearMyLibrarySessionConsent();
    expect(sessionRemove).toHaveBeenCalledWith(MY_LIBRARY_SESSION_CONSENT_KEY);
    expect(sessionValues).toEqual({});
    expect(await hasMyLibrarySessionConsent()).toBe(false);
  });

  it("fails closed when session storage is unavailable", async () => {
    vi.stubGlobal("chrome", { storage: {} });
    expect(await hasMyLibrarySessionConsent()).toBe(false);
    expect(await grantMyLibrarySessionConsent()).toBe(false);
    await expect(clearMyLibrarySessionConsent()).resolves.toBeUndefined();
  });
});
