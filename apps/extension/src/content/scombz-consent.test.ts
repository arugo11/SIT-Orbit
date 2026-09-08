import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearScombzStudentSessionConsent,
  grantScombzStudentSessionConsent,
  hasScombzStudentSessionConsent,
  SCOMBZ_STUDENT_SESSION_CONSENT_KEY,
} from "./scombz-consent";

describe("SCombZ student disclosure consent", () => {
  let localValues: Record<string, unknown>;
  let localGet: ReturnType<typeof vi.fn>;
  let localSet: ReturnType<typeof vi.fn>;
  let localRemove: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localValues = {};
    localGet = vi.fn(async (key: string | string[] | null) => {
      if (key === null) return { ...localValues };
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(
        keys
          .filter((item) => item in localValues)
          .map((item) => [item, localValues[item]]),
      );
    });
    localSet = vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(localValues, values);
    });
    localRemove = vi.fn(async (key: string | string[]) => {
      for (const item of Array.isArray(key) ? key : [key]) {
        delete localValues[item];
      }
    });
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: localGet,
          set: localSet,
          remove: localRemove,
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores only a grant timestamp in local storage and can be revoked", async () => {
    expect(await hasScombzStudentSessionConsent()).toBe(false);
    await expect(grantScombzStudentSessionConsent()).resolves.toBe(true);
    expect(localSet).toHaveBeenCalledTimes(1);
    const stored = localValues[SCOMBZ_STUDENT_SESSION_CONSENT_KEY];
    expect(stored).toEqual({ granted_at: expect.any(String) });
    expect(JSON.stringify(stored)).not.toMatch(
      /cookie|token|course|student|pdf|html/iu,
    );
    expect(await hasScombzStudentSessionConsent()).toBe(true);
    await expect(clearScombzStudentSessionConsent()).resolves.toBe(true);
    expect(localRemove).toHaveBeenCalledWith(
      SCOMBZ_STUDENT_SESSION_CONSENT_KEY,
    );
    expect(await hasScombzStudentSessionConsent()).toBe(false);
  });

  it("fails closed when local storage is unavailable", async () => {
    vi.stubGlobal("chrome", { storage: {} });
    expect(await hasScombzStudentSessionConsent()).toBe(false);
    expect(await grantScombzStudentSessionConsent()).toBe(false);
    await expect(clearScombzStudentSessionConsent()).resolves.toBe(false);
  });

  it("reports a failed write or read-back instead of granting consent", async () => {
    localSet.mockRejectedValueOnce(new Error("storage write rejected"));
    await expect(grantScombzStudentSessionConsent()).resolves.toBe(false);

    localSet.mockImplementationOnce(async (values: Record<string, unknown>) => {
      Object.assign(localValues, values);
    });
    localGet.mockRejectedValueOnce(new Error("storage read rejected"));
    await expect(grantScombzStudentSessionConsent()).resolves.toBe(false);
  });

  it("reports a failed revoke instead of claiming consent was disabled", async () => {
    localValues[SCOMBZ_STUDENT_SESSION_CONSENT_KEY] = {
      granted_at: new Date().toISOString(),
    };
    localRemove.mockRejectedValueOnce(new Error("storage remove rejected"));
    await expect(clearScombzStudentSessionConsent()).resolves.toBe(false);
    expect(await hasScombzStudentSessionConsent()).toBe(true);
  });

  it("rejects malformed or expanded consent records", async () => {
    localValues[SCOMBZ_STUDENT_SESSION_CONSENT_KEY] = {
      granted_at: "not-a-timestamp",
    };
    expect(await hasScombzStudentSessionConsent()).toBe(false);
    localValues[SCOMBZ_STUDENT_SESSION_CONSENT_KEY] = {
      granted_at: new Date().toISOString(),
      account: "must-not-be-stored",
    };
    expect(await hasScombzStudentSessionConsent()).toBe(false);
  });
});
