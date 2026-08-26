import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendOpacDiagnosticEvent,
  clearOpacDiagnosticEvents,
  normalizeOpacDiagnosticQuery,
  OPAC_DIAGNOSTIC_MAX_EVENTS,
  OPAC_DIAGNOSTIC_SCHEMA_VERSION,
  OPAC_DIAGNOSTIC_STORAGE_KEY,
  type OpacDiagnosticEvent,
  readOpacDiagnosticEvents,
} from "./opac-diagnostics";

const storage: Record<string, unknown> = {};
const get = vi.fn(async (key: string) =>
  key in storage ? { [key]: storage[key] } : {},
);
const set = vi.fn(async (values: Record<string, unknown>) => {
  Object.assign(storage, values);
});

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: { storage: { session: { get, set } } },
});

function diagnostic(index: number): OpacDiagnosticEvent {
  return {
    schema_version: OPAC_DIAGNOSTIC_SCHEMA_VERSION,
    occurred_at: "2026-08-24T00:00:00.000Z",
    operation_id: `operation-${index}`,
    query: `公開検索語 ${index}`,
    phase: "search_completed",
    route_kind: "search_results",
    result_count: 1,
    duration_ms: 100,
    status: "known",
    reason_code: null,
  };
}

describe("OPAC session diagnostics", () => {
  beforeEach(() => {
    for (const key of Object.keys(storage)) delete storage[key];
    get.mockClear();
    set.mockClear();
  });

  it("normalizes and bounds copied search terms", () => {
    expect(normalizeOpacDiagnosticQuery("  ROS\n  2   入門  ")).toBe(
      "ROS 2 入門",
    );
    expect(normalizeOpacDiagnosticQuery("本".repeat(250))).toHaveLength(200);
    expect(
      normalizeOpacDiagnosticQuery(
        "https://example.com/book?token=secret#private token=secret-value",
      ),
    ).toBe("https://example.com/book [REDACTED]");
  });

  it("keeps only the newest 200 session events", async () => {
    storage[OPAC_DIAGNOSTIC_STORAGE_KEY] = Array.from(
      { length: OPAC_DIAGNOSTIC_MAX_EVENTS },
      (_, index) => diagnostic(index),
    );

    await appendOpacDiagnosticEvent(diagnostic(200));

    const events = await readOpacDiagnosticEvents();
    expect(events).toHaveLength(OPAC_DIAGNOSTIC_MAX_EVENTS);
    expect(events[0]?.operation_id).toBe("operation-1");
    expect(events.at(-1)?.operation_id).toBe("operation-200");
  });

  it("clears the session log without retaining a second copy", async () => {
    storage[OPAC_DIAGNOSTIC_STORAGE_KEY] = [diagnostic(1)];
    await clearOpacDiagnosticEvents();
    expect(await readOpacDiagnosticEvents()).toEqual([]);
  });

  it("does not expose fields for URLs, records, holdings, or credentials", () => {
    const serialized = JSON.stringify(diagnostic(1));
    expect(serialized).not.toContain("url");
    expect(serialized).not.toContain("record_id");
    expect(serialized).not.toContain("resource_ref");
    expect(serialized).not.toContain("holdings");
    expect(serialized).not.toContain("cookie");
    expect(serialized).not.toContain("token");
  });
});
