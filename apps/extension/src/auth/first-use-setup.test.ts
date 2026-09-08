import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAMPUS_LOGIN_TARGETS,
  clearFirstUseSetup,
  FIRST_USE_SETUP_STORAGE_KEY,
  managedIdentityAvailable,
  markFirstUseSetupCompleted,
  markFirstUseSetupStarted,
  openCampusLoginTabs,
  readFirstUseSetup,
} from "./first-use-setup";

describe("first-use campus login setup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens each campus login origin once and reuses existing tabs", async () => {
    const created: Array<{ url?: string; active?: boolean }> = [];
    const existingOrigins = new Set<string>();
    vi.stubGlobal("chrome", {
      identity: {
        getRedirectURL: vi.fn(),
        launchWebAuthFlow: vi.fn(),
      },
      storage: { local: { get: vi.fn(), set: vi.fn() } },
      tabs: {
        query: vi.fn(async ({ url }: { url: string }) => {
          const origin = url.replace(/\/\*$/u, "");
          return existingOrigins.has(origin) ? [{ id: 1 }] : [];
        }),
        create: vi.fn(async (options: { url?: string; active?: boolean }) => {
          created.push(options);
          if (options.url) existingOrigins.add(new URL(options.url).origin);
          return { id: created.length };
        }),
      },
    });

    const result = await openCampusLoginTabs();

    expect(result).toEqual({
      opened: CAMPUS_LOGIN_TARGETS.map((target) => target.id),
      failed: [],
    });
    expect(created).toHaveLength(CAMPUS_LOGIN_TARGETS.length);
    expect(created[0]?.active).toBe(true);
    expect(created.slice(1).every((tab) => tab.active === false)).toBe(true);

    const second = await openCampusLoginTabs();
    expect(second).toEqual(result);
    expect(created).toHaveLength(CAMPUS_LOGIN_TARGETS.length);
  });

  it("stores only first-use timestamps and never credentials", async () => {
    const stored: Record<string, unknown> = {};
    vi.stubGlobal("chrome", {
      identity: {
        getRedirectURL: vi.fn(),
        launchWebAuthFlow: vi.fn(),
      },
      storage: {
        local: {
          get: vi.fn(async () => stored),
          set: vi.fn(async (value: Record<string, unknown>) => {
            Object.assign(stored, value);
          }),
          remove: vi.fn(async (key: string) => {
            delete stored[key];
          }),
        },
      },
    });

    expect(managedIdentityAvailable()).toBe(true);
    await markFirstUseSetupStarted();
    const started = await readFirstUseSetup();
    expect(started?.startedAt).toBeTypeOf("string");
    expect(JSON.stringify(stored)).not.toMatch(
      /password|token|authorization|verifier|secret/iu,
    );

    await markFirstUseSetupCompleted();
    const completed = await readFirstUseSetup();
    expect(completed?.completedAt).toBeTypeOf("string");
    expect(Object.keys(stored)).toEqual([FIRST_USE_SETUP_STORAGE_KEY]);

    await clearFirstUseSetup();
    await expect(readFirstUseSetup()).resolves.toBeNull();
  });

  it("fails closed when setup storage is unavailable or does not persist", async () => {
    vi.stubGlobal("chrome", { storage: {} });
    await expect(markFirstUseSetupStarted()).resolves.toBe(false);
    await expect(markFirstUseSetupCompleted()).resolves.toBe(false);

    const set = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      storage: { local: { get: vi.fn(async () => ({})), set } },
    });
    await expect(markFirstUseSetupStarted()).resolves.toBe(false);
    await expect(markFirstUseSetupCompleted()).resolves.toBe(false);

    const rejectedSet = vi.fn(async () => {
      throw new Error("storage write rejected");
    });
    vi.stubGlobal("chrome", {
      storage: {
        local: { get: vi.fn(async () => ({})), set: rejectedSet },
      },
    });
    await expect(markFirstUseSetupStarted()).resolves.toBe(false);
    await expect(markFirstUseSetupCompleted()).resolves.toBe(false);
  });
});
