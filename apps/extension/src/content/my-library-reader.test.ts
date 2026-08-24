import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  extractMyLibraryLoanPage,
  extractMyLibraryReservationPage,
  isMyLibraryStatusUrl,
  projectMyLibraryForAgent,
} from "./my-library-reader";

const loansFixture = readFileSync(
  fileURLToPath(new URL("./fixtures/my-library-loans.html", import.meta.url)),
  "utf8",
);
const reservationsFixture = readFileSync(
  fileURLToPath(
    new URL("./fixtures/my-library-reservations.html", import.meta.url),
  ),
  "utf8",
);
const pageUrl =
  "https://library.shibaura-it.ac.jp/portal/admin/selectMenu/doSelectPublicUseMainMenu";

describe("My Library reader", () => {
  it("accepts only the observed status path", () => {
    expect(isMyLibraryStatusUrl(pageUrl)).toBe(true);
    expect(
      isMyLibraryStatusUrl(
        `${pageUrl}?selectedMenuId=5&selectMenu=1`,
        "current_loans",
      ),
    ).toBe(true);
    expect(
      isMyLibraryStatusUrl(
        `${pageUrl}?selectedMenuId=6&selectMenu=1`,
        "current_loans",
      ),
    ).toBe(false);
    expect(
      isMyLibraryStatusUrl(
        `${pageUrl}?selectedMenuId=5&selectMenu=1&token=secret`,
        "current_loans",
      ),
    ).toBe(false);
    expect(
      isMyLibraryStatusUrl(
        "https://library.shibaura-it.ac.jp/portal/unknown/path",
      ),
    ).toBe(false);
    expect(
      isMyLibraryStatusUrl(
        "https://example.com/portal/admin/selectMenu/doSelectPublicUseMainMenu",
      ),
    ).toBe(false);
  });

  it("keeps bibliographic details local and projects only counts and dates", () => {
    const loanDocument = parseHTML(loansFixture).document;
    const reservationDocument = parseHTML(reservationsFixture).document;
    const loans = extractMyLibraryLoanPage(
      loanDocument,
      pageUrl,
      new Date("2026-08-22T00:00:00+09:00"),
    );
    const reservations = extractMyLibraryReservationPage(
      reservationDocument,
      pageUrl,
    );
    expect(loans).toHaveLength(2);
    expect(reservations).toHaveLength(1);
    if (!loans || !reservations) throw new Error("fixture extraction failed");
    const projection = projectMyLibraryForAgent({ loans, reservations });
    expect(projection).toEqual({
      schema_version: "v1",
      status: "known",
      loan_count: 2,
      reservation_count: 1,
      overdue_count: 1,
      renewable_count: 1,
      earliest_due_date: "2026-08-20",
      reason_code: null,
    });
    const serialized = JSON.stringify(projection);
    for (const prohibited of [
      "分散システム入門",
      "芝浦太郎",
      "material-secret",
      "secret-call-number",
      "ロボット工学",
      "reservation-secret-id",
    ]) {
      expect(serialized).not.toContain(prohibited);
    }
  });

  it("extracts current loans from the live observed menu URL", () => {
    const loanDocument = parseHTML(loansFixture).document;
    expect(
      extractMyLibraryLoanPage(
        loanDocument,
        `${pageUrl}?selectedMenuId=5&selectMenu=1`,
        new Date("2026-08-22T00:00:00+09:00"),
      ),
    ).toHaveLength(2);
  });

  it("does not accept login pages or empty placeholder rows as records", () => {
    const login = parseHTML(
      '<input type="password" /><table id="lendList"></table>',
    ).document;
    expect(extractMyLibraryLoanPage(login, pageUrl)).toBeNull();
    const empty = parseHTML(
      '<table id="reservationList"><tbody><tr><td class="dataTables_empty">データなし</td></tr></tbody></table>',
    ).document;
    expect(extractMyLibraryReservationPage(empty, pageUrl)).toEqual([]);
  });
});
