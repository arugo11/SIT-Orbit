import { isLibraryResourceRef } from "../connectors/library-discovery";

export const MY_LIBRARY_ORIGIN = "https://library.shibaura-it.ac.jp";
export const MY_LIBRARY_ENTRY_URL = `${MY_LIBRARY_ORIGIN}/portal/portal/selectLogin/?lang=ja`;
export const MY_LIBRARY_STATUS_PATH =
  "/portal/admin/selectMenu/doSelectPublicUseMainMenu";

export const MY_LIBRARY_MENU_IDS = {
  current_loans: 5,
  reservations: 6,
  loan_history: 7,
  purchase_requests: 3,
  interlibrary_requests: 2,
} as const;

export type MyLibraryScope = keyof typeof MY_LIBRARY_MENU_IDS;

export interface MyLibraryScopedItem {
  /** Opaque reference only; provider IDs never appear in this interface. */
  resource_ref?: string;
  title: string;
  author: string | null;
  status: string | null;
  due_date: string | null;
  renewable: boolean | null;
  activity_date: string | null;
  request_type: string | null;
}

export interface MyLibraryLoan {
  resource_ref?: string;
  title: string;
  author: string | null;
  due_date: string | null;
  renewable: boolean;
  overdue: boolean;
}

export interface MyLibraryReservation {
  resource_ref?: string;
  title: string;
  author: string | null;
  hold_until: string | null;
  status: string | null;
}

export interface MyLibraryLocalSnapshot {
  loans: MyLibraryLoan[];
  reservations: MyLibraryReservation[];
  loan_history?: MyLibraryScopedItem[];
  purchase_requests?: MyLibraryScopedItem[];
  interlibrary_requests?: MyLibraryScopedItem[];
}

export interface MyLibraryAgentProjection {
  schema_version: "v1";
  status: "known" | "reauth_required" | "unavailable";
  scope?: MyLibraryScope;
  items?: Array<{
    resource_ref: string;
    title: string;
    author: string | null;
    status: string | null;
    due_date: string | null;
    renewable: boolean | null;
    activity_date: string | null;
    request_type: string | null;
  }>;
  total_count?: number;
  next_offset?: number | null;
  loan_count: number;
  reservation_count: number;
  overdue_count: number;
  renewable_count: number;
  earliest_due_date: string | null;
  reason_code: string | null;
}

export interface MyLibraryReadOptions {
  scope: MyLibraryScope;
  query?: string | null;
  offset?: number;
  limit?: number;
}

function compactText(
  value: string | null | undefined,
  maxLength: number,
): string {
  return (value ?? "").replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

function visibleText(value: Element | null | undefined): string {
  if (!value) return "";
  const clone = value.cloneNode(true) as Element;
  clone
    .querySelectorAll<HTMLElement>("[hidden], [aria-hidden='true']")
    .forEach((element) => {
      element.remove();
    });
  clone.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    const style = (element.getAttribute("style") ?? "")
      .replace(/\s+/gu, "")
      .toLowerCase();
    if (
      /(?:^|;)display:none(?:;|$)/u.test(style) ||
      /(?:^|;)visibility:(?:hidden|collapse)(?:;|$)/u.test(style) ||
      /(?:^|;)opacity:0(?:;|$)/u.test(style) ||
      /(?:^|\s)(?:hidden|hide|d-none|invisible|is-hidden|visually-hidden)(?:\s|$)/u.test(
        element.getAttribute("class") ?? "",
      )
    ) {
      element.remove();
    }
  });
  clone.querySelectorAll<HTMLElement>("[class]").forEach((element) => {
    if (
      /(?:^|\s)(?:hidden|hide|d-none|invisible|is-hidden|visually-hidden)(?:\s|$)/u.test(
        element.getAttribute("class") ?? "",
      )
    ) {
      element.remove();
    }
  });
  return clone.textContent ?? "";
}

export function isMyLibraryStatusUrl(
  value: string | null | undefined,
): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.origin === MY_LIBRARY_ORIGIN &&
      url.pathname === MY_LIBRARY_STATUS_PATH &&
      url.search === "" &&
      url.hash === ""
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
    if (!isVisibleElement(cell)) continue;
    const heading = compactText(visibleText(cell.querySelector("dt")), 100);
    const value = cell.querySelector("dd");
    if (heading === label && value && isVisibleElement(value)) return value;
  }
  return null;
}

function isVisibleElement(element: Element): boolean {
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  ) {
    if (
      current.hasAttribute("hidden") ||
      current.getAttribute("aria-hidden") === "true"
    ) {
      return false;
    }
    const style = (current.getAttribute("style") ?? "")
      .replace(/\s+/gu, "")
      .toLowerCase();
    if (
      /(?:^|;)display:none(?:;|$)/u.test(style) ||
      /(?:^|;)visibility:(?:hidden|collapse)(?:;|$)/u.test(style) ||
      /(?:^|;)opacity:0(?:;|$)/u.test(style) ||
      /(?:^|\s)(?:hidden|hide|d-none|invisible|is-hidden|visually-hidden)(?:\s|$)/u.test(
        current.getAttribute("class") ?? "",
      )
    ) {
      return false;
    }
    if (typeof getComputedStyle === "function") {
      const computed = getComputedStyle(current);
      if (
        computed.display === "none" ||
        computed.visibility === "hidden" ||
        computed.visibility === "collapse" ||
        computed.opacity === "0"
      ) {
        return false;
      }
    }
  }
  return true;
}

function valueForLabels(
  row: Element,
  labels: readonly string[],
): Element | null {
  for (const label of labels) {
    const dlValue = valueForLabel(row, label);
    if (dlValue) return dlValue;
  }
  for (const cell of Array.from(row.querySelectorAll("th"))) {
    const heading = compactText(visibleText(cell), 100);
    if (!labels.includes(heading)) continue;
    const sibling = cell.nextElementSibling;
    if (sibling && isVisibleElement(sibling)) return sibling;
  }
  return null;
}

const MY_LIBRARY_SCOPE_MARKERS: Record<MyLibraryScope, readonly string[]> = {
  current_loans: ["貸出", "返却"],
  reservations: ["予約"],
  loan_history: ["貸出履歴一覧", "貸出履歴", "履歴"],
  purchase_requests: ["購入依頼状況", "購入依頼", "購入"],
  interlibrary_requests: [
    "ILL（文献複写・貸借）依頼",
    "文献複写",
    "相互貸借",
    "ILL",
    "図書館間",
  ],
};

function findMyLibraryScopeTable(
  document: Document,
  scope: MyLibraryScope,
): Element | null {
  if (scope === "current_loans") {
    const table = document.querySelector("#lendList");
    return table && isVisibleElement(table) ? table : null;
  }
  if (scope === "reservations") {
    const table = document.querySelector("#reservationList");
    return table && isVisibleElement(table) ? table : null;
  }
  const markers = MY_LIBRARY_SCOPE_MARKERS[scope];
  return (
    Array.from(document.querySelectorAll("table")).find((table) => {
      if (!isVisibleElement(table)) return false;
      const header = compactText(
        Array.from(table.querySelectorAll("caption, thead"))
          .map((element) => visibleText(element))
          .concat(
            table.previousElementSibling
              ? [visibleText(table.previousElementSibling)]
              : [],
          )
          .join(" ") || visibleText(table.querySelector("tr")),
        1000,
      );
      return markers.some((marker) => header.includes(marker));
    }) ?? null
  );
}

function extractGenericMyLibraryItem(
  row: Element,
  scope: Exclude<MyLibraryScope, "current_loans" | "reservations">,
  columnLabels: readonly string[] = [],
): MyLibraryScopedItem | null {
  if (!isVisibleElement(row)) return null;
  if (row.querySelector(".dataTables_empty, .empty, .no-data")) return null;
  const tableValueForLabels = (labels: readonly string[]): Element | null => {
    const structured = valueForLabels(row, labels);
    if (structured) return structured;
    const index = columnLabels.findIndex((label) => labels.includes(label));
    if (index < 0) return null;
    const cells = Array.from(row.children).filter(
      (cell): cell is Element =>
        cell.tagName.toLowerCase() === "td" ||
        cell.tagName.toLowerCase() === "th",
    );
    const value = cells[index];
    return value && isVisibleElement(value) ? value : null;
  };
  const titleAuthor = splitTitleAuthor(
    visibleText(
      tableValueForLabels(["書名 / 著者名", "書名", "タイトル", "資料名"]),
    ),
  );
  if (!titleAuthor) return null;
  const renewalControl = Array.from(row.querySelectorAll("button, a")).find(
    (element) =>
      isVisibleElement(element) &&
      /延長|更新/iu.test(compactText(element.textContent, 100)),
  );
  const requestType = compactText(
    visibleText(tableValueForLabels(["依頼種別", "申請種別", "種類", "区分"])),
    100,
  );
  return {
    ...titleAuthor,
    status:
      compactText(
        visibleText(tableValueForLabels(["状態", "ステータス", "処理状況"])),
        100,
      ) || null,
    due_date: normalizeDate(
      visibleText(tableValueForLabels(["返却期限", "返却日", "期限"])),
    ),
    renewable: renewalControl ? !renewalControl.hasAttribute("disabled") : null,
    activity_date: normalizeDate(
      visibleText(
        tableValueForLabels([
          "貸出日",
          "利用日",
          "申請日",
          "受付日",
          "依頼日",
          "更新日",
        ]),
      ),
    ),
    request_type:
      requestType || (scope === "interlibrary_requests" ? "ILL" : null),
  };
}

export function extractMyLibraryScopePage(
  document: Document,
  pageUrl: string,
  scope: MyLibraryScope,
  today = new Date(),
): MyLibraryScopedItem[] | null {
  if (
    !isMyLibraryStatusUrl(pageUrl) ||
    document.querySelector('input[type="password"]')
  ) {
    return null;
  }
  if (scope === "current_loans") {
    const loans = extractMyLibraryLoanPage(document, pageUrl, today);
    return (
      loans?.map((item) => ({
        title: item.title,
        author: item.author,
        status: item.overdue ? "overdue" : "loaned",
        due_date: item.due_date,
        renewable: item.renewable,
        activity_date: null,
        request_type: null,
      })) ?? null
    );
  }
  if (scope === "reservations") {
    const reservations = extractMyLibraryReservationPage(document, pageUrl);
    return (
      reservations?.map((item) => ({
        title: item.title,
        author: item.author,
        status: item.status,
        due_date: item.hold_until,
        renewable: null,
        activity_date: null,
        request_type: "reservation",
      })) ?? null
    );
  }
  const table = findMyLibraryScopeTable(document, scope);
  if (!table) return null;
  const headerRow = Array.from(table.querySelectorAll("tr")).find(
    (row) => isVisibleElement(row) && row.querySelector("th"),
  );
  const columnLabels = headerRow
    ? Array.from(headerRow.querySelectorAll("th, td")).map((cell) =>
        compactText(visibleText(cell), 100),
      )
    : [];
  return Array.from(table.querySelectorAll("tbody tr, tr"))
    .filter((row) => row !== headerRow)
    .map((row) => extractGenericMyLibraryItem(row, scope, columnLabels))
    .filter((item): item is MyLibraryScopedItem => item !== null)
    .slice(0, 1000);
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
    .filter(
      (row) =>
        isVisibleElement(row) &&
        !row.querySelector(".dataTables_empty, .empty, .no-data"),
    )
    .map((row): MyLibraryLoan | null => {
      const titleAuthor = splitTitleAuthor(
        visibleText(valueForLabel(row, "書名 / 著者名")),
      );
      if (!titleAuthor) return null;
      const dueContainer = valueForLabel(row, "貸出返却期限延長回数");
      const dueDate = normalizeDate(visibleText(dueContainer));
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
    .filter(
      (row) =>
        isVisibleElement(row) &&
        !row.querySelector(".dataTables_empty, .empty, .no-data"),
    )
    .map((row): MyLibraryReservation | null => {
      const titleAuthor = splitTitleAuthor(
        visibleText(valueForLabel(row, "書名 / 著者名")),
      );
      if (!titleAuthor) return null;
      return {
        ...titleAuthor,
        hold_until: normalizeDate(
          visibleText(valueForLabel(row, "受取館取置期限日")),
        ),
        status:
          compactText(visibleText(valueForLabel(row, "状態")), 100) || null,
      };
    })
    .filter((item): item is MyLibraryReservation => item !== null)
    .slice(0, 1000);
}

export function projectMyLibraryForAgent(
  snapshot: MyLibraryLocalSnapshot,
  options?: MyLibraryReadOptions,
): MyLibraryAgentProjection {
  const dueDates = snapshot.loans
    .map((loan) => loan.due_date)
    .filter((value): value is string => value !== null)
    .sort();
  const aggregate = {
    schema_version: "v1",
    status: "known",
    loan_count: snapshot.loans.length,
    reservation_count: snapshot.reservations.length,
    overdue_count: snapshot.loans.filter((loan) => loan.overdue).length,
    renewable_count: snapshot.loans.filter((loan) => loan.renewable).length,
    earliest_due_date: dueDates[0] ?? null,
    reason_code: null,
  } as const;
  // Preserve the v1 aggregate shape for callers that have not opted into a
  // scope. New tool calls always pass options and receive the scoped page.
  if (!options) return aggregate;

  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 1000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 20 ||
    (typeof options.query !== "undefined" &&
      options.query !== null &&
      (typeof options.query !== "string" || options.query.length > 200))
  ) {
    return {
      ...aggregate,
      status: "unavailable",
      scope: options.scope,
      items: [],
      total_count: 0,
      next_offset: null,
      reason_code: "invalid_paging",
    };
  }
  let source: MyLibraryScopedItem[];
  if (options.scope === "current_loans") {
    source = snapshot.loans.map((loan) => ({
      resource_ref: loan.resource_ref,
      title: loan.title,
      author: loan.author,
      status: loan.overdue ? "overdue" : "loaned",
      due_date: loan.due_date,
      renewable: loan.renewable,
      activity_date: null,
      request_type: null,
    }));
  } else if (options.scope === "reservations") {
    source = snapshot.reservations.map((reservation) => ({
      resource_ref: reservation.resource_ref,
      title: reservation.title,
      author: reservation.author,
      status: reservation.status,
      due_date: reservation.hold_until,
      renewable: null,
      activity_date: null,
      request_type: "reservation",
    }));
  } else if (options.scope === "loan_history") {
    source = snapshot.loan_history ?? [];
  } else if (options.scope === "purchase_requests") {
    source = snapshot.purchase_requests ?? [];
  } else {
    source = snapshot.interlibrary_requests ?? [];
  }
  const query = options.query?.trim().toLocaleLowerCase() ?? "";
  const filtered = query
    ? source.filter((item) =>
        `${item.title} ${item.author ?? ""}`
          .toLocaleLowerCase()
          .includes(query),
      )
    : source;
  const totalCount = filtered.length;
  const page = filtered.slice(offset, offset + limit);
  if (
    page.some(
      (item) => !item.resource_ref || !isLibraryResourceRef(item.resource_ref),
    )
  ) {
    return {
      ...aggregate,
      status: "unavailable",
      scope: options.scope,
      items: [],
      total_count: 0,
      next_offset: null,
      reason_code: "resource_ref_unavailable",
    };
  }
  const refs = new Set<string>();
  let items: NonNullable<MyLibraryAgentProjection["items"]>;
  try {
    items = page.map((item) => {
      const candidate = item.resource_ref;
      if (!candidate)
        throw new Error("My Library resource_ref is unavailable.");
      if (refs.has(candidate)) {
        throw new Error("My Library resource_ref collision detected.");
      }
      refs.add(candidate);
      return {
        resource_ref: candidate,
        title: item.title,
        author: item.author,
        status: item.status,
        due_date: item.due_date,
        renewable: item.renewable,
        activity_date: item.activity_date,
        request_type: item.request_type,
      };
    });
  } catch {
    return {
      ...aggregate,
      status: "unavailable",
      scope: options.scope,
      items: [],
      total_count: 0,
      next_offset: null,
      reason_code: "resource_ref_collision",
    };
  }
  return {
    ...aggregate,
    scope: options.scope,
    items,
    total_count: totalCount,
    next_offset:
      offset + page.length < totalCount ? offset + page.length : null,
  };
}
