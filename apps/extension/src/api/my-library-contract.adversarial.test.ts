import { describe, expect, it } from "vitest";
import { isMyLibraryReadResult } from "./client";

const scopes = [
  "current_loans",
  "reservations",
  "loan_history",
  "purchase_requests",
  "interlibrary_requests",
] as const;

const item = {
  resource_ref: "orbit-library://record/0123456789abcdef",
  title: "端末内資料",
  author: null,
  status: "受付済み",
  due_date: "2026-08-24",
  renewable: null,
  activity_date: "2026-08-01",
  request_type: "図書購入",
};

type Scope = (typeof scopes)[number];

function itemForScope(scope: Scope): Record<string, unknown> {
  if (scope === "current_loans") {
    return {
      ...item,
      status: "貸出中",
      due_date: "2026-08-24",
      activity_date: null,
      request_type: null,
    };
  }
  if (scope === "reservations") {
    return {
      ...item,
      status: "取置中",
      due_date: "2026-08-28",
      activity_date: null,
      request_type: "reservation",
    };
  }
  if (scope === "loan_history") {
    return {
      ...item,
      status: "返却済み",
      due_date: null,
      activity_date: "2026-07-01",
      request_type: null,
    };
  }
  if (scope === "purchase_requests") {
    return {
      ...item,
      status: "受付済み",
      due_date: null,
      activity_date: "2026-08-01",
      request_type: "図書購入",
    };
  }
  return {
    ...item,
    status: "処理中",
    due_date: null,
    activity_date: "2026-08-05",
    request_type: "文献複写",
  };
}

const requiredFields: Record<Scope, readonly string[]> = {
  current_loans: ["due_date"],
  reservations: ["due_date", "status"],
  loan_history: ["activity_date", "status"],
  purchase_requests: ["activity_date", "status", "request_type"],
  interlibrary_requests: ["activity_date", "status", "request_type"],
};

const requiredDateFields: Record<Scope, "due_date" | "activity_date"> = {
  current_loans: "due_date",
  reservations: "due_date",
  loan_history: "activity_date",
  purchase_requests: "activity_date",
  interlibrary_requests: "activity_date",
};

function scopedResult(scope: Scope): Record<string, unknown> {
  const aggregates = {
    loan_count: null,
    reservation_count: null,
    overdue_count: null,
    renewable_count: null,
    earliest_due_date: null,
  } as Record<string, unknown>;
  if (scope === "current_loans") {
    Object.assign(aggregates, {
      loan_count: 1,
      overdue_count: 0,
      renewable_count: 0,
      earliest_due_date: null,
    });
  } else if (scope === "reservations") {
    aggregates.reservation_count = 1;
  }
  return {
    schema_version: "v1",
    status: "known",
    scope,
    items: [itemForScope(scope)],
    total_count: 1,
    next_offset: null,
    ...aggregates,
    reason_code: null,
  };
}

describe("My Library result contract adversarial cases", () => {
  it("keeps legacy aggregate and scoped page as explicit, non-overlapping shapes", () => {
    const legacy = {
      schema_version: "v1",
      status: "known",
      loan_count: 1,
      reservation_count: 0,
      overdue_count: 0,
      renewable_count: 0,
      earliest_due_date: null,
      reason_code: null,
    };
    expect(isMyLibraryReadResult(legacy)).toBe(true);

    for (const scope of scopes) {
      expect(isMyLibraryReadResult(scopedResult(scope))).toBe(true);
    }
    expect(
      isMyLibraryReadResult({
        ...legacy,
        scope: "purchase_requests",
      }),
    ).toBe(false);
    expect(
      isMyLibraryReadResult({
        ...scopedResult("purchase_requests"),
        titles: ["must stay local"],
      }),
    ).toBe(false);
  });

  it.each(scopes)(
    "rejects a known %s result when a scope-required item field is missing",
    (scope) => {
      const valid = scopedResult(scope);
      expect(isMyLibraryReadResult(valid)).toBe(true);
      const rows = valid.items as Array<Record<string, unknown>>;
      for (const field of requiredFields[scope]) {
        const incomplete = {
          ...valid,
          items: [{ ...rows[0], [field]: null }],
        };
        expect(isMyLibraryReadResult(incomplete)).toBe(false);
      }
    },
  );

  it.each(scopes)("requires exact ISO dates for a known %s item", (scope) => {
    const valid = scopedResult(scope);
    expect(isMyLibraryReadResult(valid)).toBe(true);
    const field = requiredDateFields[scope];
    const rows = valid.items as Array<Record<string, unknown>>;
    expect(
      isMyLibraryReadResult({
        ...valid,
        items: [{ ...rows[0], [field]: "2026-8-1" }],
      }),
    ).toBe(false);
    expect(
      isMyLibraryReadResult({
        ...valid,
        items: [{ ...rows[0], [field]: "2026-08-01" }],
      }),
    ).toBe(true);
  });

  it.each([" ", "\t\n"])(
    "rejects whitespace-only My Library titles (%j)",
    (title) => {
      const valid = scopedResult("purchase_requests");
      const rows = valid.items as Array<Record<string, unknown>>;
      expect(
        isMyLibraryReadResult({
          ...valid,
          items: [{ ...rows[0], title }],
        }),
      ).toBe(false);
    },
  );

  it.each([
    ["current_loans", "reservation_count", 0],
    ["reservations", "loan_count", 0],
    ["reservations", "overdue_count", 0],
    ["reservations", "renewable_count", 0],
    ["reservations", "earliest_due_date", "2026-09-01"],
    ["loan_history", "loan_count", 0],
    ["purchase_requests", "reservation_count", 0],
    ["interlibrary_requests", "overdue_count", 0],
  ] as const)(
    "rejects an aggregate outside the %s scope (%s)",
    (scope, field, value) => {
      expect(
        isMyLibraryReadResult({
          ...scopedResult(scope),
          [field]: value,
        }),
      ).toBe(false);
    },
  );

  it("rejects page shapes that violate total_count or final-page cursor rules", () => {
    const valid = scopedResult("purchase_requests");
    expect(isMyLibraryReadResult({ ...valid, total_count: 0 })).toBe(false);
    expect(isMyLibraryReadResult({ ...valid, next_offset: 1 })).toBe(false);
    expect(
      isMyLibraryReadResult({
        ...valid,
        items: Array.from({ length: 21 }, (_, index) => ({
          ...item,
          resource_ref: `orbit-library://record/${index.toString(16).padStart(16, "0")}`,
        })),
        total_count: 21,
      }),
    ).toBe(false);
    expect(
      isMyLibraryReadResult({
        ...valid,
        status: "unavailable",
        items: [],
        total_count: 0,
        next_offset: null,
      }),
    ).toBe(true);
    expect(
      isMyLibraryReadResult({
        ...valid,
        status: "unavailable",
        total_count: 1,
      }),
    ).toBe(false);
  });
});
