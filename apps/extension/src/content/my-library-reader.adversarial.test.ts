import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { isMyLibraryReadResult } from "../api/client";
import {
  createLibraryResourceRef,
  isLibraryResourceRef,
} from "../connectors/library-discovery";
import {
  extractMyLibraryScopePage,
  isMyLibraryStatusUrl,
  type MyLibraryLocalSnapshot,
  type MyLibraryScope,
  type MyLibraryScopedItem,
  projectMyLibraryForAgent,
} from "./my-library-reader";

const PAGE_URL =
  "https://library.shibaura-it.ac.jp/portal/admin/selectMenu/doSelectPublicUseMainMenu";

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    "utf8",
  );
}

const scopeFixtures: Record<MyLibraryScope, string> = {
  current_loans: "my-library-loans.html",
  reservations: "my-library-reservations.html",
  loan_history: "my-library-loan-history.html",
  purchase_requests: "my-library-purchase-requests.html",
  interlibrary_requests: "my-library-interlibrary-requests.html",
};

const allowedItemKeys = [
  "activity_date",
  "author",
  "due_date",
  "renewable",
  "request_type",
  "status",
  "title",
].sort();

const forbiddenPersonalMarkers = [
  "student-name-secret",
  "student-number-secret",
  "student@example.invalid",
  "sso-token-secret",
  "query-secret",
  "fragment-secret",
  "secret-call-number",
  "material-secret-1",
  "material-secret-2",
  "reservation-secret-id",
  "history-material-001",
  "purchase-request-001",
  "ill-request-001",
  "tracking-secret-id",
  "purchase-reason-secret",
  "contact-note-secret",
  "form-value-secret",
];

function fixtureItem(
  index: number,
  scope: MyLibraryScope = "loan_history",
): MyLibraryScopedItem {
  return {
    resource_ref: createLibraryResourceRef(`${scope}-raw-${index}`),
    title: `合成資料 ${index}`,
    author: index % 2 === 0 ? "合成著者" : null,
    status: "返却済み",
    due_date: null,
    renewable: null,
    activity_date: "2026-08-01",
    request_type: null,
  };
}

function emptySnapshot(overrides: Partial<MyLibraryLocalSnapshot> = {}) {
  return {
    loans: [],
    reservations: [],
    ...overrides,
  } satisfies MyLibraryLocalSnapshot;
}

describe("My Library reader adversarial boundaries", () => {
  it.each([
    [
      "current_loans",
      { count: 2, first: { status: "loaned", due_date: "2026-08-24" } },
    ],
    [
      "reservations",
      { count: 1, first: { status: "取置中", due_date: "2026-08-28" } },
    ],
    [
      "loan_history",
      {
        count: 1,
        first: {
          status: "返却済み",
          due_date: "2026-07-15",
          activity_date: "2026-07-01",
        },
      },
    ],
    [
      "purchase_requests",
      {
        count: 1,
        first: {
          status: "受付済み",
          activity_date: "2026-08-01",
          request_type: "図書購入",
        },
      },
    ],
    [
      "interlibrary_requests",
      {
        count: 1,
        first: {
          status: "処理中",
          activity_date: "2026-08-05",
          request_type: "文献複写",
        },
      },
    ],
  ] as const)(
    "extracts the real-screen-shaped %s scope into only the allowed fields",
    (scope, expected) => {
      const document = parseHTML(fixture(scopeFixtures[scope])).document;
      const items = extractMyLibraryScopePage(
        document,
        PAGE_URL,
        scope,
        new Date("2026-08-22T00:00:00+09:00"),
      );

      expect(items).toHaveLength(expected.count);
      expect(items?.[0]).toMatchObject(expected.first);
      expect(Object.keys(items?.[0] ?? {}).sort()).toEqual(allowedItemKeys);

      const serialized = JSON.stringify(items);
      for (const marker of forbiddenPersonalMarkers) {
        expect(serialized).not.toContain(marker);
      }
    },
  );

  it("does not project visible or hidden identity/request form fields", () => {
    const document = parseHTML(`
      <table>
        <caption>購入依頼状況</caption>
        <thead>
          <tr>
            <th>申請番号</th>
            <th>書名 / 著者名</th>
            <th>申請日</th>
            <th>状態</th>
            <th>申請種別</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>tracking-secret-id</td>
            <td>端末内資料 / 公開著者</td>
            <td>2026/08/01</td>
            <td>受付済み</td>
            <td>図書購入</td>
            <td>購入理由: purchase-reason-secret 連絡事項: contact-note-secret</td>
          </tr>
        </tbody>
      </table>
      <form>
        <input name="student_name" value="student-name-secret" />
        <input name="student_id" value="student-number-secret" />
        <input name="email" value="student@example.invalid" />
        <input name="sso_token" value="sso-token-secret" />
        <input name="query" value="query-secret" />
        <input name="tracking_id" value="tracking-secret-id" />
        <input name="material_id" value="material-secret-1" />
        <input name="call_number" value="secret-call-number" />
      </form>
      <div hidden>fragment-secret form-value-secret</div>
    `).document;

    const items = extractMyLibraryScopePage(
      document,
      PAGE_URL,
      "purchase_requests",
    );
    expect(items).toEqual([
      {
        title: "端末内資料",
        author: "公開著者",
        status: "受付済み",
        due_date: null,
        renewable: null,
        activity_date: "2026-08-01",
        request_type: "図書購入",
      },
    ]);
    for (const marker of forbiddenPersonalMarkers) {
      expect(JSON.stringify(items)).not.toContain(marker);
    }
  });

  it("supports query, offset, and a hard maximum page size of twenty", () => {
    const loanHistory = Array.from({ length: 25 }, (_, index) =>
      fixtureItem(index),
    );
    const snapshot = emptySnapshot({ loan_history: loanHistory });

    const firstPage = projectMyLibraryForAgent(snapshot, {
      scope: "loan_history",
      offset: 0,
      limit: 20,
    });
    expect(firstPage.status).toBe("known");
    expect(firstPage.items).toHaveLength(20);
    expect(firstPage.total_count).toBe(25);
    expect(firstPage.next_offset).toBe(20);
    expect(isMyLibraryReadResult(firstPage)).toBe(true);
    expect(
      firstPage.items?.every((item) => isLibraryResourceRef(item.resource_ref)),
    ).toBe(true);

    const secondPage = projectMyLibraryForAgent(snapshot, {
      scope: "loan_history",
      offset: 20,
      limit: 20,
    });
    expect(secondPage.status).toBe("known");
    expect(secondPage.items).toHaveLength(5);
    expect(secondPage.next_offset).toBeNull();

    const queried = projectMyLibraryForAgent(snapshot, {
      scope: "loan_history",
      query: "資料 2",
      offset: 0,
      limit: 20,
    });
    expect(queried.status).toBe("known");
    expect(queried.total_count).toBe(6);
    expect(queried.items?.every((item) => item.title.includes("資料 2"))).toBe(
      true,
    );
    expect(Object.hasOwn(queried, "query")).toBe(false);

    for (const options of [
      { scope: "loan_history" as const, limit: 21 },
      { scope: "loan_history" as const, offset: -1 },
      { scope: "loan_history" as const, offset: 1001 },
      { scope: "loan_history" as const, query: "x".repeat(201) },
    ]) {
      const rejected = projectMyLibraryForAgent(snapshot, options);
      expect(rejected).toMatchObject({
        status: "unavailable",
        items: [],
        total_count: 0,
        next_offset: null,
        reason_code: "invalid_paging",
      });
    }
  });

  it("fails closed when two scoped rows resolve to one opaque reference", () => {
    const duplicateRef = createLibraryResourceRef("same-worker-target");
    const item = fixtureItem(1);
    const snapshot = emptySnapshot({
      loan_history: [
        { ...item, resource_ref: duplicateRef },
        { ...fixtureItem(2), resource_ref: duplicateRef },
      ],
    });

    expect(
      projectMyLibraryForAgent(snapshot, {
        scope: "loan_history",
        limit: 20,
      }),
    ).toMatchObject({
      status: "unavailable",
      items: [],
      total_count: 0,
      next_offset: null,
      reason_code: "resource_ref_collision",
    });
  });

  it.each([
    PAGE_URL.replace("doSelectPublicUseMainMenu", "unknown/path"),
    `${PAGE_URL}?query=query-secret`,
    `${PAGE_URL}#fragment-secret`,
    "https://example.invalid/portal/admin/selectMenu/doSelectPublicUseMainMenu",
  ])("fails closed for an unexpected My Library URL: %s", (url) => {
    const document = parseHTML(fixture(scopeFixtures.loan_history)).document;
    expect(extractMyLibraryScopePage(document, url, "loan_history")).toBeNull();
    expect(isMyLibraryStatusUrl(url)).toBe(false);
  });

  it.each([
    ["a login page", '<input type="password" name="password" />'],
    ["a 404 page", "<h1>404 Not Found</h1>"],
    [
      "a changed structure",
      '<table id="new-layout"><tr><td>別の画面</td></tr></table>',
    ],
  ])("fails closed for %s", (_label, html) => {
    const document = parseHTML(html).document;
    expect(
      extractMyLibraryScopePage(document, PAGE_URL, "loan_history"),
    ).toBeNull();
  });
});
