export const MY_LIBRARY_ORIGIN = "https://library.shibaura-it.ac.jp";
export const MY_LIBRARY_ENTRY_URL = `${MY_LIBRARY_ORIGIN}/portal/portal/selectLogin/?lang=ja`;
export const MY_LIBRARY_STATUS_PATH =
  "/portal/admin/selectMenu/doSelectPublicUseMainMenu";

export interface MyLibraryLoan {
  title: string;
  author: string | null;
  due_date: string | null;
  renewable: boolean;
  overdue: boolean;
}

export interface MyLibraryReservation {
  title: string;
  author: string | null;
  hold_until: string | null;
  status: string | null;
}

export interface MyLibraryLocalSnapshot {
  loans: MyLibraryLoan[];
  reservations: MyLibraryReservation[];
}

export interface MyLibraryAgentProjection {
  schema_version: "v1";
  status: "known" | "reauth_required" | "unavailable";
  loan_count: number;
  reservation_count: number;
  overdue_count: number;
  renewable_count: number;
  earliest_due_date: string | null;
  reason_code: string | null;
}

function compactText(
  value: string | null | undefined,
  maxLength: number,
): string {
  return (value ?? "").replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

export function isMyLibraryStatusUrl(
  value: string | null | undefined,
): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.origin === MY_LIBRARY_ORIGIN &&
      url.pathname === MY_LIBRARY_STATUS_PATH
    );
  } catch {
    return false;
  }
}

function normalizeDate(value: string): string | null {
  const match = value.match(/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})/u);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function splitTitleAuthor(value: string): {
  title: string;
  author: string | null;
} | null {
  const parts = compactText(value, 500).split(/\s+\/\s+/u);
  const title = compactText(parts.shift(), 300);
  if (!title) return null;
  const author = compactText(parts.join(" / "), 200);
  return { title, author: author || null };
}

function valueForLabel(row: Element, label: string): Element | null {
  for (const cell of Array.from(row.querySelectorAll("td"))) {
    const heading = compactText(cell.querySelector("dt")?.textContent, 100);
    if (heading === label) return cell.querySelector("dd");
  }
  return null;
}

export function extractMyLibraryLoanPage(
  document: Document,
  pageUrl: string,
  today = new Date(),
): MyLibraryLoan[] | null {
  if (
    !isMyLibraryStatusUrl(pageUrl) ||
    document.querySelector('input[type="password"]')
  ) {
    return null;
  }
  const table = document.querySelector("#lendList");
  if (!table) return null;
  const todayKey = `${today.getFullYear().toString().padStart(4, "0")}-${(
    today.getMonth() + 1
  )
    .toString()
    .padStart(2, "0")}-${today.getDate().toString().padStart(2, "0")}`;
  return Array.from(table.querySelectorAll("tbody tr"))
    .filter((row) => !row.querySelector(".dataTables_empty, .empty, .no-data"))
    .map((row): MyLibraryLoan | null => {
      const titleAuthor = splitTitleAuthor(
        valueForLabel(row, "書名 / 著者名")?.textContent ?? "",
      );
      if (!titleAuthor) return null;
      const dueContainer = valueForLabel(row, "貸出返却期限延長回数");
      const dueDate = normalizeDate(dueContainer?.textContent ?? "");
      const checkbox = row.querySelector<HTMLInputElement>(
        'input[type="checkbox"][name="checkBoxBookNumber"]',
      );
      return {
        ...titleAuthor,
        due_date: dueDate,
        renewable: Boolean(checkbox && !checkbox.disabled),
        overdue: dueDate !== null && dueDate < todayKey,
      };
    })
    .filter((item): item is MyLibraryLoan => item !== null)
    .slice(0, 1000);
}

export function extractMyLibraryReservationPage(
  document: Document,
  pageUrl: string,
): MyLibraryReservation[] | null {
  if (
    !isMyLibraryStatusUrl(pageUrl) ||
    document.querySelector('input[type="password"]')
  ) {
    return null;
  }
  const table = document.querySelector("#reservationList");
  if (!table) return null;
  return Array.from(table.querySelectorAll("tbody tr"))
    .filter((row) => !row.querySelector(".dataTables_empty, .empty, .no-data"))
    .map((row): MyLibraryReservation | null => {
      const titleAuthor = splitTitleAuthor(
        valueForLabel(row, "書名 / 著者名")?.textContent ?? "",
      );
      if (!titleAuthor) return null;
      return {
        ...titleAuthor,
        hold_until: normalizeDate(
          valueForLabel(row, "受取館取置期限日")?.textContent ?? "",
        ),
        status:
          compactText(valueForLabel(row, "状態")?.textContent, 100) || null,
      };
    })
    .filter((item): item is MyLibraryReservation => item !== null)
    .slice(0, 1000);
}

export function projectMyLibraryForAgent(
  snapshot: MyLibraryLocalSnapshot,
): MyLibraryAgentProjection {
  const dueDates = snapshot.loans
    .map((loan) => loan.due_date)
    .filter((value): value is string => value !== null)
    .sort();
  return {
    schema_version: "v1",
    status: "known",
    loan_count: snapshot.loans.length,
    reservation_count: snapshot.reservations.length,
    overdue_count: snapshot.loans.filter((loan) => loan.overdue).length,
    renewable_count: snapshot.loans.filter((loan) => loan.renewable).length,
    earliest_due_date: dueDates[0] ?? null,
    reason_code: null,
  };
}
