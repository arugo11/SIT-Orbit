import { parseHTML } from "linkedom";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MESSAGE_TYPES } from "../shared/messages";

type EventCallback = (...args: never[]) => void;

function createEvent() {
  let callback: EventCallback | undefined;

  return {
    addListener: vi.fn((listener: EventCallback) => {
      callback = listener;
    }),
    dispatch: (...args: unknown[]) => {
      callback?.(...(args as never[]));
    },
  };
}

const onInstalled = createEvent();
const onStartup = createEvent();
const onUpdated = createEvent();
const onActivated = createEvent();
const onRemoved = createEvent();
const onMessage = createEvent();
const setOptions = vi.fn(async (_options: unknown) => undefined);
const setPanelBehavior = vi.fn(async (_options: unknown) => undefined);
const sendMessage = vi.fn(async (_message: unknown) => undefined);
const queryTabs = vi.fn(
  async (_query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> => [],
);
function defaultTab(tabId: number): chrome.tabs.Tab {
  return {
    id: tabId,
    windowId: 4,
    url: "https://scombz.shibaura-it.ac.jp/portal/home",
  } as chrome.tabs.Tab;
}
const getTab = vi.fn(async (tabId: number) => defaultTab(tabId));
const tabSendMessage = vi.fn(
  async (_tabId: number, _message: unknown): Promise<unknown> => undefined,
);
const getAuthToken = vi.fn(async () => "calendar-worker-token");
const removeCachedAuthToken = vi.fn(
  async (_details: { token: string }) => undefined,
);
const storageValues: Record<string, unknown> = {};
const storageGet = vi.fn(async (keys: string | string[] | null) => {
  if (keys === null) {
    return { ...storageValues };
  }
  const requested = Array.isArray(keys) ? keys : [keys];
  return Object.fromEntries(
    requested
      .filter((key) => key in storageValues)
      .map((key) => [key, storageValues[key]]),
  );
});
const storageSet = vi.fn(async (values: Record<string, unknown>) => {
  Object.assign(storageValues, values);
});
const createTab = vi.fn(async (properties: chrome.tabs.CreateProperties) => ({
  id: 91,
  windowId: properties.windowId ?? 1,
  url: properties.url,
}));
const updateTab = vi.fn(async (_tabId: number, _properties: unknown) => ({}));
const removeTab = vi.fn(async (_tabId: number) => undefined);
const updateWindow = vi.fn(
  async (_windowId: number, _properties: unknown) => ({}),
);
const permissionsContains = vi.fn(async (_permissions: unknown) => false);
const executeScript = vi.fn(
  async (_details: unknown): Promise<Array<{ result?: unknown }>> => [],
);

const chromeMock = {
  runtime: {
    id: "orbit-extension-id",
    onInstalled,
    onStartup,
    onMessage,
    sendMessage,
    getURL: (path: string) => `chrome-extension://orbit-extension-id/${path}`,
  },
  sidePanel: {
    setOptions,
    setPanelBehavior,
  },
  tabs: {
    onUpdated,
    onActivated,
    onRemoved,
    get: getTab,
    query: queryTabs,
    create: createTab,
    update: updateTab,
    remove: removeTab,
    sendMessage: tabSendMessage,
  },
  identity: {
    getAuthToken,
    removeCachedAuthToken,
  },
  storage: {
    session: {
      get: storageGet,
      set: storageSet,
    },
  },
  windows: {
    update: updateWindow,
  },
  permissions: {
    contains: permissionsContains,
  },
  scripting: {
    executeScript,
  },
} as unknown as typeof chrome;

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: chromeMock,
});

type ScriptDetails = { func?: unknown };

function capturedScript(index: number): () => unknown {
  const details = executeScript.mock.calls[index]?.[0] as
    | ScriptDetails
    | undefined;
  if (typeof details?.func !== "function") {
    throw new Error(`executeScript call ${index} did not capture a function`);
  }
  return details.func as () => unknown;
}

function publicActionRecord() {
  return {
    record_id: "ACTION-RECORD-1",
    title: "公開操作検証資料",
    authors: ["公開著者"],
    subjects: ["ロボット"],
    isbn: null,
    publisher: "公開出版社",
    publication_year: 2026,
    format: "book",
    campus: "omiya",
    url: "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/ACTION-RECORD-1",
    holdings: [
      {
        campus: "omiya",
        location: "大宮図書館",
        call_number: "548.3/U32",
        status: "available",
        due_date: null,
        reservation_count: 0,
      },
    ],
    related_records: [],
  };
}

function stubPage(html: string, href: string): void {
  vi.stubGlobal("document", parseHTML(html).document);
  vi.stubGlobal("location", new URL(href));
}

type InlineMyLibraryScope =
  | "current_loans"
  | "reservations"
  | "loan_history"
  | "purchase_requests"
  | "interlibrary_requests";

function inlineDefinitionCell(label: string, value: string): string {
  return `<td><dl><dt>${label}</dt><dd>${value}</dd></dl></td>`;
}

function inlineMarkedDefinitionCell(label: string, marker: string): string {
  return `<td><dl><dt>${label}</dt><dd class="${marker}"></dd></dl></td>`;
}

function inlineCurrentLoansHtml(title: string, dueDate: string): string {
  return `<table id="lendList"><tbody><tr>${inlineDefinitionCell(
    "書名 / 著者名",
    title,
  )}${inlineDefinitionCell(
    "貸出返却期限延長回数",
    dueDate,
  )}</tr></tbody></table>`;
}

function inlineReservationsHtml(
  title: string,
  status: string,
  holdUntil: string,
): string {
  return `<table id="reservationList"><tbody><tr>${inlineDefinitionCell(
    "書名 / 著者名",
    title,
  )}${inlineDefinitionCell("状態", status)}${inlineDefinitionCell(
    "受取館取置期限日",
    holdUntil,
  )}</tr></tbody></table>`;
}

function inlineGenericMyLibraryHtml(
  marker: string,
  headers: readonly string[],
  values: readonly string[],
): string {
  return `<table><caption>${marker}</caption><thead><tr>${headers
    .map((header) => `<th>${header}</th>`)
    .join("")}</tr></thead><tbody><tr>${values
    .map((value) => `<td>${value}</td>`)
    .join("")}</tr></tbody></table>`;
}

const inlineMalformedScopeCases = [
  {
    scope: "current_loans",
    field: "due date",
    title: "貸出検証資料",
    html: inlineCurrentLoansHtml("貸出検証資料", ""),
  },
  {
    scope: "reservations",
    field: "status",
    title: "予約検証資料",
    html: inlineReservationsHtml("予約検証資料", "", "2026/08/28"),
  },
  {
    scope: "loan_history",
    field: "loan date",
    title: "履歴検証資料",
    html: inlineGenericMyLibraryHtml(
      "貸出履歴一覧",
      ["書名", "貸出日", "状態"],
      ["履歴検証資料", "2026/99/99", "返却済み"],
    ),
  },
  {
    scope: "purchase_requests",
    field: "request type",
    title: "購入検証資料",
    html: inlineGenericMyLibraryHtml(
      "購入依頼状況",
      ["書名", "申請日", "状態", "申請種別"],
      ["購入検証資料", "2026/08/01", "受付済み", ""],
    ),
  },
  {
    scope: "interlibrary_requests",
    field: "accepted date",
    title: "ILL検証資料",
    html: inlineGenericMyLibraryHtml(
      "ILL（文献複写・貸借）依頼",
      ["書名", "受付日", "状態", "依頼種別"],
      ["ILL検証資料", "2026/99/99", "処理中", "文献複写"],
    ),
  },
] as const;

const inlineAuthorlessScopeCases = [
  {
    scope: "current_loans",
    title: "著者なし貸出",
    html: inlineCurrentLoansHtml("著者なし貸出", "2026/08/24"),
  },
  {
    scope: "reservations",
    title: "著者なし予約",
    html: inlineReservationsHtml("著者なし予約", "取置中", "2026/08/28"),
  },
  {
    scope: "loan_history",
    title: "著者なし履歴",
    html: inlineGenericMyLibraryHtml(
      "貸出履歴一覧",
      ["書名", "貸出日", "状態"],
      ["著者なし履歴", "2026/07/01", "返却済み"],
    ),
  },
  {
    scope: "purchase_requests",
    title: "著者なし購入依頼",
    html: inlineGenericMyLibraryHtml(
      "購入依頼状況",
      ["書名", "申請日", "状態", "申請種別"],
      ["著者なし購入依頼", "2026/08/01", "受付済み", "図書購入"],
    ),
  },
  {
    scope: "interlibrary_requests",
    title: "著者なしILL依頼",
    html: inlineGenericMyLibraryHtml(
      "ILL（文献複写・貸借）依頼",
      ["書名", "受付日", "状態", "依頼種別"],
      ["著者なしILL依頼", "2026/08/05", "処理中", "文献複写"],
    ),
  },
] as const;

const inlineMarkedRequiredCellCases = [
  {
    scope: "current_loans",
    html: `<table id="lendList"><tbody><tr>${inlineDefinitionCell(
      "書名 / 著者名",
      "必須列検証貸出",
    )}${inlineMarkedDefinitionCell(
      "貸出返却期限延長回数",
      "empty",
    )}</tr></tbody></table>`,
  },
  {
    scope: "reservations",
    html: `<table id="reservationList"><tbody><tr>${inlineDefinitionCell(
      "書名 / 著者名",
      "必須列検証予約",
    )}${inlineMarkedDefinitionCell("状態", "no-data")}${inlineDefinitionCell(
      "受取館取置期限日",
      "2026/08/28",
    )}</tr></tbody></table>`,
  },
  {
    scope: "loan_history",
    html: inlineGenericMyLibraryHtml(
      "貸出履歴一覧",
      ["書名", "貸出日", "状態"],
      ["必須列検証履歴", "", "返却済み"],
    ).replace(
      "<td></td><td>返却済み</td>",
      '<td class="empty"></td><td>返却済み</td>',
    ),
  },
  {
    scope: "purchase_requests",
    html: inlineGenericMyLibraryHtml(
      "購入依頼状況",
      ["書名", "申請日", "状態", "申請種別"],
      ["必須列検証購入", "2026/08/01", "受付済み", ""],
    ).replace("<td></td></tr>", '<td class="no-data"></td></tr>'),
  },
  {
    scope: "interlibrary_requests",
    html: inlineGenericMyLibraryHtml(
      "ILL（文献複写・貸借）依頼",
      ["書名", "受付日", "状態", "依頼種別"],
      ["必須列検証ILL", "2026/08/05", "", "文献複写"],
    ).replace(
      "<td></td><td>文献複写</td>",
      '<td class="empty"></td><td>文献複写</td>',
    ),
  },
] as const;

const inlineEmptyBodyWithoutPlaceholderCases = [
  {
    scope: "current_loans",
    html: '<table id="lendList"><tbody></tbody></table>',
  },
  {
    scope: "reservations",
    html: '<table id="reservationList"><tbody></tbody></table>',
  },
  {
    scope: "loan_history",
    html: `<table><caption>貸出履歴一覧</caption><thead><tr><th>書名</th><th>貸出日</th><th>状態</th></tr></thead><tbody></tbody></table>`,
  },
  {
    scope: "purchase_requests",
    html: `<table><caption>購入依頼状況</caption><thead><tr><th>書名</th><th>申請日</th><th>状態</th><th>申請種別</th></tr></thead><tbody></tbody></table>`,
  },
  {
    scope: "interlibrary_requests",
    html: `<table><caption>ILL（文献複写・貸借）依頼</caption><thead><tr><th>書名</th><th>受付日</th><th>状態</th><th>依頼種別</th></tr></thead><tbody></tbody></table>`,
  },
] as const;

async function runInlineMyLibraryReader(
  scope: InlineMyLibraryScope,
  html: string,
  workerResult: Record<string, unknown>,
): Promise<unknown> {
  permissionsContains.mockResolvedValue(true);
  getTab.mockResolvedValue({
    id: 91,
    windowId: 1,
    status: "complete",
    url: "https://library.shibaura-it.ac.jp/portal/admin/selectMenu/doSelectPublicUseMainMenu",
  } as chrome.tabs.Tab);
  executeScript
    .mockResolvedValueOnce([{ result: { status: "clicked" } }])
    .mockResolvedValueOnce([{ result: workerResult }]);

  const response = vi.fn();
  onMessage.dispatch(
    {
      type: MESSAGE_TYPES.myLibraryRead,
      tool_call_id: `inline-reader-${scope}`,
      scope,
      offset: 0,
      limit: 20,
    },
    {},
    response,
  );
  await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));

  stubPage(
    html,
    "https://library.shibaura-it.ac.jp/portal/admin/selectMenu/doSelectPublicUseMainMenu",
  );
  const readStatusPage = capturedScript(1) as unknown as (
    requestedScope: InlineMyLibraryScope,
  ) => unknown;
  return readStatusPage(scope);
}

await import("./service-worker");

afterAll(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("service worker side panel contract", () => {
  beforeEach(() => {
    setOptions.mockClear();
    setPanelBehavior.mockClear();
    sendMessage.mockClear();
    queryTabs.mockClear();
    getTab.mockReset();
    getTab.mockImplementation(async (tabId: number) => defaultTab(tabId));
    tabSendMessage.mockReset();
    tabSendMessage.mockResolvedValue(undefined);
    getAuthToken.mockClear();
    removeCachedAuthToken.mockClear();
    storageGet.mockClear();
    storageSet.mockClear();
    createTab.mockClear();
    updateTab.mockClear();
    removeTab.mockClear();
    updateWindow.mockClear();
    permissionsContains.mockReset();
    permissionsContains.mockResolvedValue(false);
    executeScript.mockReset();
    executeScript.mockResolvedValue([]);
    for (const key of Object.keys(storageValues)) {
      delete storageValues[key];
    }
  });

  it("returns only Moodle aggregates while keeping local detail in the extension response", async () => {
    permissionsContains.mockResolvedValue(true);
    queryTabs.mockResolvedValue([
      {
        id: 55,
        url: "https://moodle.sic.shibaura-it.ac.jp/moodle/my/",
      },
    ] as chrome.tabs.Tab[]);
    executeScript.mockResolvedValue([
      {
        result: {
          status: "known",
          detail: {
            courses: ["制御工学"],
            upcoming: [
              {
                title: "レポート1",
                course: "制御工学",
                due_at: "2026-08-24T06:00:00.000Z",
                overdue: false,
              },
            ],
            unread_notification_count: 2,
          },
        },
      },
    ]);
    const response = vi.fn();
    onMessage.dispatch(
      { type: MESSAGE_TYPES.moodleRead, tool_call_id: "moodle-call-1" },
      {},
      response,
    );
    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));
    const payload = response.mock.calls[0]?.[0];
    expect(payload).toEqual(
      expect.objectContaining({
        status: "known",
        projection: expect.objectContaining({
          course_count: 1,
          upcoming_item_count: 1,
          unread_notification_count: 2,
        }),
      }),
    );
    expect(JSON.stringify(payload.projection)).not.toContain("制御工学");
    expect(JSON.stringify(payload.projection)).not.toContain("レポート1");
  });

  it("returns only My Library aggregates while keeping titles local", async () => {
    permissionsContains.mockResolvedValue(true);
    getTab.mockResolvedValue({
      id: 91,
      windowId: 1,
      status: "complete",
      url: "https://library.shibaura-it.ac.jp/portal/admin/selectMenu/doSelectPublicUseMainMenu",
    } as chrome.tabs.Tab);
    executeScript
      .mockResolvedValueOnce([{ result: { status: "clicked" } }])
      .mockResolvedValueOnce([
        {
          result: {
            status: "known",
            kind: "loans",
            loans: [
              {
                title: "分散システム入門",
                author: "芝浦太郎著",
                due_date: "2026-09-01",
                renewable: true,
                overdue: false,
              },
            ],
          },
        },
      ])
      .mockResolvedValueOnce([{ result: { status: "clicked" } }])
      .mockResolvedValueOnce([
        {
          result: {
            status: "known",
            kind: "reservations",
            reservations: [
              {
                title: "ロボット工学",
                author: "山田花子著",
                hold_until: "2026-09-03",
                status: "取置中",
              },
            ],
          },
        },
      ]);
    const response = vi.fn();
    onMessage.dispatch(
      { type: MESSAGE_TYPES.myLibraryRead, tool_call_id: "library-call-1" },
      {},
      response,
    );
    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));
    const payload = response.mock.calls[0]?.[0];
    expect(payload).toEqual(
      expect.objectContaining({
        status: "known",
        projection: expect.objectContaining({
          loan_count: 1,
          reservation_count: 1,
          renewable_count: 1,
        }),
      }),
    );
    expect(JSON.stringify(payload.projection)).not.toContain(
      "分散システム入門",
    );
    expect(JSON.stringify(payload.projection)).not.toContain("ロボット工学");
    expect(JSON.stringify(storageValues)).not.toContain("分散システム入門");
    expect(JSON.stringify(storageValues)).not.toContain("ロボット工学");
    expect(removeTab).toHaveBeenCalledTimes(2);
  });

  it.each([
    "current_loans",
    "reservations",
    "loan_history",
    "purchase_requests",
    "interlibrary_requests",
  ] as const)(
    "projects the %s worker result into the Agent allowlist only",
    async (scope) => {
      permissionsContains.mockResolvedValue(true);
      getTab.mockResolvedValue({
        id: 91,
        windowId: 1,
        status: "complete",
        url: "https://library.shibaura-it.ac.jp/portal/admin/selectMenu/doSelectPublicUseMainMenu",
      } as chrome.tabs.Tab);

      const rawId = `${scope}-material-secret`;
      const item = {
        raw_id: rawId,
        title: "端末内資料",
        author: "公開著者",
        status: "処理中",
        due_date: null,
        renewable: null,
        activity_date: "2026-08-01",
        request_type: scope === "interlibrary_requests" ? "文献複写" : null,
      };
      const readResult: Record<string, unknown> = {
        status: "known",
        scope,
        items: [item],
      };
      if (scope === "current_loans") {
        readResult.kind = "loans";
        readResult.loans = [
          {
            title: item.title,
            author: item.author,
            due_date: item.due_date,
            renewable: false,
            overdue: false,
          },
        ];
      }
      if (scope === "reservations") {
        readResult.kind = "reservations";
        readResult.reservations = [
          {
            title: item.title,
            author: item.author,
            hold_until: "2026-08-28",
            status: "取置中",
          },
        ];
      }
      executeScript
        .mockResolvedValueOnce([{ result: { status: "clicked" } }])
        .mockResolvedValueOnce([{ result: readResult }]);

      const response = vi.fn();
      onMessage.dispatch(
        {
          type: MESSAGE_TYPES.myLibraryRead,
          tool_call_id: `library-scoped-${scope}`,
          scope,
          query: null,
          offset: 0,
          limit: 20,
        },
        {},
        response,
      );
      await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));

      const payload = response.mock.calls[0]?.[0] as {
        status: string;
        projection?: Record<string, unknown>;
        detail?: unknown;
      };
      expect(payload.status).toBe("known");
      expect(Object.keys(payload.projection ?? {}).sort()).toEqual(
        [
          "earliest_due_date",
          "items",
          "loan_count",
          "next_offset",
          "overdue_count",
          "reason_code",
          "renewable_count",
          "reservation_count",
          "schema_version",
          "scope",
          "status",
          "total_count",
        ].sort(),
      );
      const items = payload.projection?.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(1);
      expect(Object.keys(items[0] ?? {}).sort()).toEqual(
        [
          "activity_date",
          "author",
          "due_date",
          "renewable",
          "request_type",
          "resource_ref",
          "status",
          "title",
        ].sort(),
      );
      expect(items[0]?.resource_ref).toMatch(
        /^orbit-library:\/\/record\/[A-Za-z0-9_-]{16,128}$/u,
      );
      const serialized = JSON.stringify({ payload, storageValues });
      for (const marker of [
        rawId,
        "secret-call-number",
        "student-number-secret",
        "student@example.invalid",
        "sso-token-secret",
        "query-secret",
        "fragment-secret",
        "tracking-secret-id",
        "purchase-reason-secret",
        "contact-note-secret",
      ]) {
        expect(serialized).not.toContain(marker);
      }
    },
  );

  it("fails closed when two raw rows map to one worker reference", async () => {
    permissionsContains.mockResolvedValue(true);
    getTab.mockResolvedValue({
      id: 91,
      windowId: 1,
      status: "complete",
      url: "https://library.shibaura-it.ac.jp/portal/admin/selectMenu/doSelectPublicUseMainMenu",
    } as chrome.tabs.Tab);
    const duplicateRows = [
      {
        raw_id: "same-material-secret",
        title: "資料A",
        author: null,
        status: "返却済み",
        due_date: null,
        renewable: null,
        activity_date: "2026-08-01",
        request_type: null,
      },
      {
        raw_id: "same-material-secret",
        title: "資料B",
        author: null,
        status: "返却済み",
        due_date: null,
        renewable: null,
        activity_date: "2026-08-02",
        request_type: null,
      },
    ];
    executeScript
      .mockResolvedValueOnce([{ result: { status: "clicked" } }])
      .mockResolvedValueOnce([
        {
          result: {
            status: "known",
            scope: "loan_history",
            items: duplicateRows,
          },
        },
      ]);
    const response = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.myLibraryRead,
        tool_call_id: "library-ref-collision",
        scope: "loan_history",
        limit: 20,
      },
      {},
      response,
    );
    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));
    expect(response).toHaveBeenCalledWith({
      status: "unavailable",
      reason_code: "resource_ref_collision",
    });
    expect(JSON.stringify(storageValues)).not.toContain("same-material-secret");
  });

  it("returns an action-incapable opaque ref when a visible provider ID is absent", async () => {
    permissionsContains.mockResolvedValue(true);
    getTab.mockResolvedValue({
      id: 91,
      windowId: 1,
      status: "complete",
      url: "https://library.shibaura-it.ac.jp/portal/admin/selectMenu/doSelectPublicUseMainMenu",
    } as chrome.tabs.Tab);
    executeScript
      .mockResolvedValueOnce([{ result: { status: "clicked" } }])
      .mockResolvedValueOnce([
        {
          result: {
            status: "known",
            scope: "loan_history",
            items: [
              {
                raw_id: null,
                title: "識別子のない履歴資料".repeat(30),
                author: "公開著者",
                status: "返却済み",
                due_date: null,
                renewable: null,
                activity_date: "2026-08-01",
                request_type: null,
              },
            ],
          },
        },
      ]);

    const response = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.myLibraryRead,
        tool_call_id: "library-unresolved-ref",
        scope: "loan_history",
        offset: 0,
        limit: 20,
      },
      {},
      response,
    );
    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));

    const payload = response.mock.calls[0]?.[0] as {
      status: string;
      projection?: { items?: Array<{ resource_ref?: string }> };
    };
    expect(payload.status).toBe("known");
    expect(payload.projection?.items?.[0]?.resource_ref).toMatch(
      /^orbit-library:\/\/record\/[A-Za-z0-9_-]{16,128}$/u,
    );
  });

  it.each([
    {
      scope: "current_loans",
      html: `<table id="lendList"><tbody><tr><td>解析不能な貸出行</td></tr></tbody></table>`,
    },
    {
      scope: "reservations",
      html: `<table id="reservationList"><tbody><tr><td>解析不能な予約行</td></tr></tbody></table>`,
    },
    {
      scope: "purchase_requests",
      html: `<table><caption>購入依頼状況</caption><thead><tr><th>書名</th><th>状態</th><th>申請日</th></tr></thead><tbody><tr><td></td><td>受付済み</td><td>2026-08-01</td></tr></tbody></table>`,
    },
    {
      scope: "loan_history",
      html: `<table><caption>貸出履歴一覧</caption><thead><tr><th>書名</th><th>貸出日</th></tr></thead><tbody><tr><td></td><td>2026-08-01</td></tr></tbody></table>`,
    },
    {
      scope: "interlibrary_requests",
      html: `<table><caption>ILL（文献複写・貸借）依頼</caption><thead><tr><th>書名</th><th>状態</th><th>依頼日</th><th>依頼区分</th></tr></thead><tbody><tr><td></td><td>受付済み</td><td>2026-08-01</td><td>文献複写</td></tr></tbody></table>`,
    },
  ] as const)(
    "fails closed for a non-empty unparseable $scope DOM row",
    async ({ scope, html }) => {
      permissionsContains.mockResolvedValue(true);
      getTab.mockResolvedValue({
        id: 91,
        windowId: 1,
        status: "complete",
        url: "https://library.shibaura-it.ac.jp/portal/admin/selectMenu/doSelectPublicUseMainMenu",
      } as chrome.tabs.Tab);
      executeScript
        .mockResolvedValueOnce([{ result: { status: "clicked" } }])
        .mockResolvedValueOnce([
          {
            result: {
              status: "unavailable",
              reason_code: "scope_row_unparseable",
            },
          },
        ]);

      const response = vi.fn();
      onMessage.dispatch(
        {
          type: MESSAGE_TYPES.myLibraryRead,
          tool_call_id: `library-unparseable-${scope}`,
          scope,
          offset: 0,
          limit: 20,
        },
        {},
        response,
      );
      await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));

      stubPage(
        html,
        "https://library.shibaura-it.ac.jp/portal/admin/selectMenu/doSelectPublicUseMainMenu",
      );
      const readStatusPage = capturedScript(1) as unknown as (
        requestedScope: typeof scope,
      ) => unknown;
      expect(readStatusPage(scope)).toEqual({
        status: "unavailable",
        reason_code: "scope_row_unparseable",
      });
    },
  );

  it.each(inlineMalformedScopeCases)(
    "inline reader fails closed for a valid-title $scope row with malformed $field",
    async ({ scope, html, title }) => {
      expect(html).toContain(title);
      const result = await runInlineMyLibraryReader(scope, html, {
        status: "unavailable",
        reason_code: "scope_row_unparseable",
      });
      expect(result).toEqual({
        status: "unavailable",
        reason_code: "scope_row_unparseable",
      });
    },
  );

  it.each(inlineAuthorlessScopeCases)(
    "inline reader keeps valid $scope row when author is absent",
    async ({ scope, html, title }) => {
      const result = await runInlineMyLibraryReader(scope, html, {
        status: "known",
        scope,
        items: [],
      });
      expect(result).toMatchObject({
        status: "known",
        items: [{ title, author: null }],
      });
    },
  );

  it.each(inlineMarkedRequiredCellCases)(
    "inline reader fails closed when a valid-title $scope required cell is marked empty",
    async ({ scope, html }) => {
      const result = await runInlineMyLibraryReader(scope, html, {
        status: "unavailable",
        reason_code: "scope_row_unparseable",
      });
      expect(result).toEqual({
        status: "unavailable",
        reason_code: "scope_row_unparseable",
      });
    },
  );

  it.each(inlineEmptyBodyWithoutPlaceholderCases)(
    "inline reader fails closed for an empty $scope table without an explicit placeholder",
    async ({ scope, html }) => {
      const result = await runInlineMyLibraryReader(scope, html, {
        status: "unavailable",
        reason_code: "scope_row_unparseable",
      });
      expect(result).toEqual({
        status: "unavailable",
        reason_code: "scope_row_unparseable",
      });
    },
  );

  it("keeps an official empty placeholder as a known empty inline scope", async () => {
    const result = await runInlineMyLibraryReader(
      "reservations",
      '<table id="reservationList"><tbody><tr><td class="dataTables_empty">データなし</td></tr></tbody></table>',
      {
        status: "known",
        scope: "reservations",
        kind: "reservations",
        reservations: [],
        items: [],
      },
    );
    expect(result).toMatchObject({
      status: "known",
      kind: "reservations",
      items: [],
    });
  });

  it("reads public catalog DOM in an inactive isolated-world tab", async () => {
    permissionsContains.mockResolvedValue(true);
    getTab.mockResolvedValue({
      id: 91,
      windowId: 1,
      status: "complete",
      url: "https://library.shibaura-it.ac.jp/opc/",
    } as chrome.tabs.Tab);
    executeScript
      .mockResolvedValueOnce([{ result: { status: "submitted" } }])
      .mockResolvedValueOnce([
        {
          result: {
            status: "known",
            records: [
              {
                record_id: "ABC123",
                title: "公開ロボット工学",
                authors: ["芝浦太郎"],
                subjects: ["ロボット"],
                isbn: null,
                publisher: "公開出版社",
                publication_year: 2026,
                format: "book",
                campus: "omiya",
                url: "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/ABC123",
                holdings: [],
                related_records: [],
              },
            ],
          },
        },
      ]);
    const response = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.libraryCatalogSearch,
        tool_call_id: "library-search-1",
        query: "ロボット",
        limit: 1,
      },
      {},
      response,
    );
    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));
    const payload = response.mock.calls[0]?.[0];
    expect(payload).toEqual(
      expect.objectContaining({
        status: "known",
        projection: expect.objectContaining({
          status: "known",
          items: [
            expect.objectContaining({
              title: "公開ロボット工学",
              holdings: [
                expect.objectContaining({
                  campus: "unknown",
                  status: "unknown",
                }),
              ],
            }),
          ],
        }),
      }),
    );
    expect(JSON.stringify(payload.projection)).not.toContain("record_id");
    expect(createTab).toHaveBeenCalledWith({
      url: "https://library.shibaura-it.ac.jp/opc/",
      active: false,
    });
    expect(executeScript.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ world: "ISOLATED" }),
    );
    expect(removeTab).toHaveBeenCalledWith(91);
  });

  it("returns an explicit permission request before the first OPAC read", async () => {
    permissionsContains.mockResolvedValue(false);
    const response = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.libraryCatalogSearch,
        tool_call_id: "library-permission-1",
        query: "ロボット",
        limit: 1,
      },
      {},
      response,
    );
    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));
    expect(response).toHaveBeenCalledWith({
      status: "permission_required",
      origin: "https://library.shibaura-it.ac.jp",
      pattern: "https://library.shibaura-it.ac.jp/*",
    });
    expect(createTab).not.toHaveBeenCalled();
  });

  it("submits only the visible OPAC search form", async () => {
    permissionsContains.mockResolvedValue(true);
    executeScript
      .mockResolvedValueOnce([{ result: { status: "submitted" } }])
      .mockResolvedValueOnce([{ result: { status: "known", records: [] } }]);
    const response = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.libraryCatalogSearch,
        tool_call_id: "library-visible-form",
        query: "ロボット",
        limit: 1,
      },
      {},
      response,
    );
    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));
    const submitCatalog = capturedScript(0) as unknown as (filters: {
      query: string;
    }) => { status: string };
    stubPage(
      `
        <form action="/opc/xc/search" hidden><input name="keys"></form>
        <form action="/opc/xc/search"><input name="keys"></form>
      `,
      "https://library.shibaura-it.ac.jp/opc/",
    );
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    const forms = Array.from(document.querySelectorAll("form"));
    const hiddenSubmit = vi.fn();
    const visibleSubmit = vi.fn();
    for (const form of forms) {
      Object.defineProperty(form, "action", {
        value: "https://library.shibaura-it.ac.jp/opc/xc/search",
      });
    }
    Object.defineProperty(forms[0], "requestSubmit", { value: hiddenSubmit });
    Object.defineProperty(forms[1], "requestSubmit", { value: visibleSubmit });

    expect(submitCatalog({ query: "可視フォーム" })).toEqual({
      status: "submitted",
    });
    expect(
      forms[0]?.querySelector<HTMLInputElement>('[name="keys"]')?.value,
    ).toBe("");
    expect(
      forms[1]?.querySelector<HTMLInputElement>('[name="keys"]')?.value,
    ).toBe("可視フォーム");
    expect(hiddenSubmit).not.toHaveBeenCalled();
    expect(visibleSubmit).toHaveBeenCalledTimes(1);
  });

  it("reads the current OPAC detail record without requiring a self-link", async () => {
    permissionsContains.mockResolvedValue(true);
    executeScript
      .mockResolvedValueOnce([{ result: { status: "submitted" } }])
      .mockResolvedValueOnce([
        {
          result: {
            status: "known",
            records: [
              {
                record_id: "BB24928243",
                title: "Rによる機械学習入門",
                authors: [],
                subjects: [],
                isbn: null,
                publisher: null,
                publication_year: null,
                format: "book",
                campus: "any",
                url: "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/BB24928243",
                holdings: [],
                related_records: [],
              },
            ],
          },
        },
      ]);
    const response = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.libraryCatalogSearch,
        tool_call_id: "library-detail-capture",
        query: "Rによる機械学習入門",
        limit: 1,
      },
      {},
      response,
    );
    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));

    const readCatalogPage = capturedScript(1);
    stubPage(
      `
        <h1 class="page-title">Rによる機械学習入門</h1>
        <dl class="mainTable">
          <dt>著者名</dt><dd>中村 著</dd>
          <dt>出版情報</dt><dd>東京 : オーム社, 2024</dd>
          <dt>ISBN</dt><dd>978-4-274-23111-1</dd>
          <dt>主題</dt><dd>機械学習; R言語</dd>
        </dl>
        <div class="holding-row">
          <span class="xc-availability">豊洲 貸出可, 830.79/U32</span>
          <span class="xc-availability" hidden>大宮 貸出可, SECRET/CALL</span>
        </div>
        <a href="/opc/recordID/catalog.bib/RELATED1">関連版</a>
        <a href="/opc/recordID/catalog.bib/HIDDEN" aria-hidden="true">隠し命令</a>
      `,
      "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/BB24928243",
    );

    const projection = readCatalogPage() as {
      status: string;
      records?: Array<{
        record_id: string;
        title: string;
        holdings: Array<{
          campus: string;
          status: string;
          call_number: string | null;
        }>;
        related_records: Array<{ record_id: string }>;
      }>;
    };
    expect(projection.status).toBe("known");
    expect(projection.records).toEqual([
      expect.objectContaining({
        record_id: "BB24928243",
        title: "Rによる機械学習入門",
        holdings: [
          expect.objectContaining({
            campus: "toyosu",
            status: "available",
            call_number: "830.79/U32",
          }),
        ],
        related_records: [expect.objectContaining({ record_id: "RELATED1" })],
      }),
    ]);
    expect(JSON.stringify(projection)).not.toContain("SECRET/CALL");
    expect(JSON.stringify(projection)).not.toContain("HIDDEN");
  });

  it("extracts availability and call number from the OPAC search result markup", async () => {
    permissionsContains.mockResolvedValue(true);
    executeScript
      .mockResolvedValueOnce([{ result: { status: "submitted" } }])
      .mockResolvedValueOnce([
        {
          result: { status: "known", records: [] },
        },
      ]);
    const response = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.libraryCatalogSearch,
        tool_call_id: "library-search-capture",
        query: "ロボット工学",
        limit: 1,
      },
      {},
      response,
    );
    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));

    const readCatalogPage = capturedScript(1);
    stubPage(
      `
        <article class="result-row">
          <a href="/opc/recordID/catalog.bib/ABC123">公開ロボット工学</a>
          <span class="xc-availability">大宮 貸出可, 830.79/U32</span>
        </article>
      `,
      "https://library.shibaura-it.ac.jp/opc/",
    );

    const projection = readCatalogPage() as {
      status: string;
      records?: Array<{
        holdings: Array<{
          campus: string;
          status: string;
          call_number: string | null;
        }>;
      }>;
    };
    expect(projection.status).toBe("known");
    expect(projection.records?.[0]?.holdings).toEqual([
      expect.objectContaining({
        campus: "omiya",
        status: "available",
        call_number: "830.79/U32",
      }),
    ]);
  });

  it("uses the live OPAC title and creator instead of the cover anchor", async () => {
    permissionsContains.mockResolvedValue(true);
    executeScript
      .mockResolvedValueOnce([{ result: { status: "submitted" } }])
      .mockResolvedValueOnce([{ result: { status: "known", records: [] } }]);
    const response = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.libraryCatalogSearch,
        tool_call_id: "library-live-opac-row",
        query: "分散ロボット工学",
        limit: 1,
      },
      {},
      response,
    );
    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));

    const readCatalogPage = capturedScript(1);
    stubPage(
      `
        <article class="result-row">
          <a
            href="/opc/recordID/catalog.bib/LIVE123"
            title="Cover image of 分散ロボット工学"
          ><img alt="Cover image of 分散ロボット工学"></a>
          <a class="xc-title" href="/opc/recordID/catalog.bib/LIVE123">分散ロボット工学の実タイトル</a>
          <span class="xc-creator">実在著者</span>
        </article>
      `,
      "https://library.shibaura-it.ac.jp/opc/",
    );

    const projection = readCatalogPage() as {
      status: string;
      records?: Array<{
        record_id: string;
        title: string;
        authors: string[];
      }>;
    };
    expect(projection).toEqual({
      status: "known",
      records: [
        expect.objectContaining({
          record_id: "LIVE123",
          title: "分散ロボット工学の実タイトル",
          authors: ["実在著者"],
        }),
      ],
    });
  });

  it("fails closed for unknown resource references and non-OPAC result pages", async () => {
    permissionsContains.mockResolvedValue(true);
    const unknownResponse = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.libraryItemRead,
        tool_call_id: "unknown-library-ref",
        resource_ref: "orbit-library://record/0000000000000000",
      },
      {},
      unknownResponse,
    );
    await vi.waitFor(() => expect(unknownResponse).toHaveBeenCalledTimes(1));
    expect(unknownResponse).toHaveBeenCalledWith({
      status: "unavailable",
      reason_code: "unknown_resource_ref",
    });
    expect(createTab).not.toHaveBeenCalled();

    executeScript
      .mockResolvedValueOnce([{ result: { status: "submitted" } }])
      .mockResolvedValueOnce([{ result: { status: "known", records: [] } }]);
    const captureResponse = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.libraryCatalogSearch,
        tool_call_id: "path-capture",
        query: "公開資料",
        limit: 1,
      },
      {},
      captureResponse,
    );
    await vi.waitFor(() => expect(captureResponse).toHaveBeenCalledTimes(1));
    const readCatalogPage = capturedScript(1);

    for (const href of [
      "https://example.com/opc/",
      "https://library.shibaura-it.ac.jp/not-opac/",
    ]) {
      stubPage("<p>unexpected page</p>", href);
      expect(readCatalogPage()).toEqual({
        status: "unavailable",
        reason_code: "unexpected_opac_result",
      });
    }
  });

  it("strips SIT Search session state without collapsing distinct titles", async () => {
    permissionsContains.mockResolvedValue(true);
    executeScript
      .mockResolvedValueOnce([{ result: { status: "submitted" } }])
      .mockResolvedValueOnce([{ result: { status: "known", items: [] } }]);
    const response = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.libraryDiscoverySearch,
        tool_call_id: "library-discovery-capture",
        query: "機械学習",
        limit: 10,
      },
      {},
      response,
    );
    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));
    const readDiscoveryPage = capturedScript(1);
    stubPage(
      `
        <article class="result-row"><a href="/sublib/?session=one#result">機械学習 A</a></article>
        <article class="result-row"><a href="/sublib/?session=two#result">機械学習 B</a></article>
        <article class="result-row" style="display:none"><a href="/sublib/?session=hidden">隠し命令</a></article>
        <article class="result-row computed-hidden"><a href="/sublib/?session=computed">computed hidden</a></article>
      `,
      "https://slib.shibaura-it.ac.jp/sublib/",
    );
    vi.stubGlobal("getComputedStyle", (element: Element) => ({
      display: element.classList.contains("computed-hidden") ? "none" : "block",
      visibility: "visible",
      opacity: "1",
    }));

    expect(readDiscoveryPage()).toEqual({
      status: "known",
      items: [
        expect.objectContaining({
          title: "機械学習 A",
          url: "https://slib.shibaura-it.ac.jp/sublib/",
        }),
        expect.objectContaining({
          title: "機械学習 B",
          url: "https://slib.shibaura-it.ac.jp/sublib/",
        }),
      ],
    });
  });

  it("keeps the live SIT Search hit and normalizes a doubled OPAC path", async () => {
    permissionsContains.mockResolvedValue(true);
    executeScript
      .mockResolvedValueOnce([{ result: { status: "submitted" } }])
      .mockResolvedValueOnce([{ result: { status: "known", items: [] } }]);
    const response = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.libraryDiscoverySearch,
        tool_call_id: "library-live-discovery-row",
        query: "分散ロボット工学",
        limit: 10,
      },
      {},
      response,
    );
    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));

    const readDiscoveryPage = capturedScript(1);
    stubPage(
      `
        <article class="result-row">
          <nav>
            <a href="/sublib/help">Help</a>
            <a href="/sublib/english">English</a>
          </nav>
          <div class="facet"><a href="/sublib/?facet=subject">Facet navigation</a></div>
          <a href="https://library.shibaura-it.ac.jp/opc//recordID/catalog.bib/LIVE456">実際の検索ヒット</a>
        </article>
      `,
      "https://slib.shibaura-it.ac.jp/sublib/",
    );

    expect(readDiscoveryPage()).toEqual({
      status: "known",
      items: [
        expect.objectContaining({
          title: "実際の検索ヒット",
          url: "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/LIVE456",
          record_id: "LIVE456",
        }),
      ],
    });
  });

  it("returns only CAST aggregates while keeping notice titles local", async () => {
    permissionsContains.mockResolvedValue(true);
    queryTabs.mockResolvedValue([
      {
        id: 77,
        url: "https://shibaura.pita.services/career/top/student",
      },
    ] as chrome.tabs.Tab[]);
    executeScript.mockResolvedValue([
      {
        result: {
          status: "known",
          detail: {
            notices: [
              { title: "合成キャリア講座", published_date: "2026-08-20" },
            ],
            new_job_count: 4,
            new_internship_count: 7,
            new_event_count: 2,
            has_counseling_reservation: true,
          },
        },
      },
    ]);
    const response = vi.fn();
    onMessage.dispatch(
      { type: MESSAGE_TYPES.castRead, tool_call_id: "cast-call-1" },
      {},
      response,
    );
    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));
    const payload = response.mock.calls[0]?.[0];
    expect(payload).toEqual(
      expect.objectContaining({
        status: "known",
        projection: expect.objectContaining({
          notice_count: 1,
          new_job_count: 4,
          new_internship_count: 7,
          new_event_count: 2,
          has_counseling_reservation: true,
        }),
      }),
    );
    expect(JSON.stringify(payload.projection)).not.toContain(
      "合成キャリア講座",
    );
    expect(JSON.stringify(storageValues)).not.toContain("合成キャリア講座");
  });

  it("returns generalized CAST alumni aggregates while keeping names in local detail", async () => {
    permissionsContains.mockResolvedValue(true);
    queryTabs.mockResolvedValue([
      {
        id: 78,
        url: "https://shibaura.pita.services/career/supporter/list",
      },
    ] as chrome.tabs.Tab[]);
    tabSendMessage.mockResolvedValue({
      status: "known",
      detail: {
        schema_version: "v1",
        page_path: "/career/supporter/list",
        profiles: [
          {
            local_id: "cast-alumni-local-1",
            display_name: "山田太郎",
            role: "alumni",
            answerable_topics: ["技術・研究"],
            availability_frequency: "monthly",
            meeting_modes: ["online"],
            shareable_insights: ["選考体験"],
            contact_present: true,
          },
        ],
        discovered_links: [],
      },
    });
    const response = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.castAlumniRead,
        tool_call_id: "cast-alumni-call-1",
      },
      {},
      response,
    );
    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));
    const payload = response.mock.calls[0]?.[0];
    expect(payload).toEqual(
      expect.objectContaining({
        status: "known",
        projection: {
          schema_version: "v1",
          status: "known",
          data_classification: "personal",
          profile_count: 1,
          topic_categories: ["技術・研究"],
          availability_frequencies: ["monthly"],
          meeting_modes: ["online"],
          shareable_insight_categories: ["選考体験"],
          contact_present: true,
          discovered_link_count: 0,
          reason_code: null,
        },
      }),
    );
    expect(payload.detail.profiles[0].display_name).toBe("山田太郎");
    expect(JSON.stringify(payload.projection)).not.toContain("山田太郎");
  });

  it("enables the panel per tab and preserves its path for ScombZ and other origins", async () => {
    onUpdated.dispatch(
      11,
      { url: "https://scombz.shibaura-it.ac.jp/course/calculus" },
      { url: "https://scombz.shibaura-it.ac.jp/course/calculus" },
    );
    onUpdated.dispatch(
      22,
      { url: "https://example.com/course/calculus" },
      { url: "https://example.com/course/calculus" },
    );
    onUpdated.dispatch(
      33,
      {
        url: "https://sitrus.sic.shibaura-it.ac.jp/SITRUS/login/ShutokuTaniShukei.html?N=synthetic",
      },
      {
        url: "https://sitrus.sic.shibaura-it.ac.jp/SITRUS/login/ShutokuTaniShukei.html?N=synthetic",
      },
    );

    await vi.waitFor(() => expect(setOptions).toHaveBeenCalledTimes(3));

    expect(setOptions).toHaveBeenCalledWith({
      tabId: 11,
      path: "sidepanel.html",
      enabled: true,
    });
    expect(setOptions).toHaveBeenCalledWith({
      tabId: 22,
      path: "sidepanel.html",
      enabled: false,
    });
    expect(setOptions).toHaveBeenCalledWith({
      tabId: 33,
      path: "sidepanel.html",
      enabled: true,
    });
    expect(setPanelBehavior).not.toHaveBeenCalled();
  });

  it("does not rebroadcast a background tab context to the visible panel", async () => {
    queryTabs.mockResolvedValueOnce([
      {
        id: 11,
        url: "https://scombz.shibaura-it.ac.jp/portal/home",
      },
    ] as chrome.tabs.Tab[]);
    const message = {
      type: "page-context-updated",
      context: {
        title: "Background tab",
        url: "https://scombz.shibaura-it.ac.jp/course/calculus",
        kind: "scombz",
      },
    };

    onMessage.dispatch(message, { tab: { id: 22 } });

    await vi.waitFor(() => expect(chromeMock.tabs.query).toHaveBeenCalled());
    expect(sendMessage).not.toHaveBeenCalledWith(message);
  });

  it("[SW-001] rejects every calendar command from a content-script sender before identity or fetch", async () => {
    const token = "calendar-worker-token";
    const liveFetch = vi.fn(async () => {
      throw new Error("live Google fetch must not run for content scripts");
    });
    vi.stubGlobal("fetch", liveFetch);

    const commandTypes = [
      MESSAGE_TYPES.calendarConnect,
      MESSAGE_TYPES.calendarRefresh,
      MESSAGE_TYPES.calendarReauthenticate,
      MESSAGE_TYPES.calendarDisconnect,
    ] as const;
    for (const type of commandTypes) {
      const response = vi.fn();
      onMessage.dispatch({ type }, { tab: { id: 77 } }, response);
      await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));
      expect(response).toHaveBeenCalledWith(
        expect.objectContaining({ status: "unavailable" }),
      );
      expect(JSON.stringify(response.mock.calls)).not.toContain(token);
    }

    expect(getAuthToken).not.toHaveBeenCalled();
    expect(removeCachedAuthToken).not.toHaveBeenCalled();
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it("[SW-002] rejects every Drive command from a content-script sender", async () => {
    const internalFileId = "drive-internal-file-01";
    const commandMessages = [
      { type: MESSAGE_TYPES.driveSelect },
      { type: MESSAGE_TYPES.driveRead, selection_id: "sel_worker_01" },
      { type: MESSAGE_TYPES.driveDeselect, selection_id: "sel_worker_01" },
      { type: MESSAGE_TYPES.driveRefresh },
    ] as const;

    for (const message of commandMessages) {
      const response = vi.fn();
      onMessage.dispatch(message, { tab: { id: 77 } }, response);
      await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));
      expect(response).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "unavailable",
          selections: [],
        }),
      );
      expect(JSON.stringify(response.mock.calls)).not.toContain(internalFileId);
    }
  });

  it("allows a trusted full-page extension tab to use connector commands", async () => {
    getAuthToken.mockRejectedValueOnce(new Error("no cached token"));
    const response = vi.fn();
    onMessage.dispatch(
      { type: MESSAGE_TYPES.calendarRefresh },
      {
        id: "orbit-extension-id",
        tab: { id: 91 },
        url: "chrome-extension://orbit-extension-id/workspace.html",
      },
      response,
    );

    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));
    expect(response).toHaveBeenCalledWith(
      expect.objectContaining({ status: "reauth_required" }),
    );
  });

  it("opens, reuses, and releases one workspace for the active ScombZ tab", async () => {
    queryTabs.mockResolvedValue([
      {
        id: 11,
        windowId: 4,
        url: "https://scombz.shibaura-it.ac.jp/portal/home",
      },
    ] as chrome.tabs.Tab[]);
    tabSendMessage.mockResolvedValue({
      title: "Home",
      url: "https://scombz.shibaura-it.ac.jp/portal/home",
      kind: "scombz",
    });
    const response = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.openWorkspace,
        stable_state: {
          status: "idle",
          proposal: null,
          completionEvent: null,
          changeNote: "",
          error: null,
        },
      },
      { id: "orbit-extension-id" },
      response,
    );

    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));
    expect(response.mock.calls[0]?.[0]).toMatchObject({
      ok: true,
      session: {
        sourceTabId: 11,
        sourceWindowId: 4,
        workspaceTabId: 91,
        sourceAvailable: true,
      },
    });
    expect(createTab).toHaveBeenCalledWith(
      expect.objectContaining({
        openerTabId: 11,
        windowId: 4,
        active: false,
      }),
    );
    expect(updateTab).toHaveBeenCalledWith(
      91,
      expect.objectContaining({
        active: true,
        url: expect.stringContaining("workspace.html?session="),
      }),
    );
    const serialized = JSON.stringify(storageValues);
    expect(serialized).not.toContain("pendingRunId");
    expect(serialized).not.toContain("oauth");

    const secondResponse = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.openWorkspace,
        stable_state: {
          status: "idle",
          proposal: null,
          completionEvent: null,
          changeNote: "",
          error: null,
        },
      },
      { id: "orbit-extension-id" },
      secondResponse,
    );
    await vi.waitFor(() => expect(secondResponse).toHaveBeenCalledTimes(1));
    expect(createTab).toHaveBeenCalledTimes(1);
    expect(updateTab).toHaveBeenLastCalledWith(91, { active: true });

    onUpdated.dispatch(
      11,
      { url: "https://example.com/left-scombz" },
      { url: "https://example.com/left-scombz" },
    );
    await vi.waitFor(() =>
      expect(JSON.stringify(storageValues)).toContain(
        '"sourceAvailable":false',
      ),
    );

    const reconnectResponse = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.openWorkspace,
        stable_state: {
          status: "idle",
          proposal: null,
          completionEvent: null,
          changeNote: "",
          error: null,
        },
      },
      { id: "orbit-extension-id" },
      reconnectResponse,
    );
    await vi.waitFor(() => expect(reconnectResponse).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(storageValues)).toContain('"sourceAvailable":true');
    expect(createTab).toHaveBeenCalledTimes(1);

    onRemoved.dispatch(91);
    await vi.waitFor(() =>
      expect(JSON.stringify(storageValues)).toContain('"workspaceTabId":null'),
    );
  });

  it("rejects workspace creation from a ScombZ content script", async () => {
    const response = vi.fn();
    onMessage.dispatch(
      {
        type: MESSAGE_TYPES.openWorkspace,
        stable_state: {
          status: "idle",
          proposal: null,
          completionEvent: null,
          changeNote: "",
          error: null,
        },
      },
      {
        id: "orbit-extension-id",
        tab: { id: 11 },
        url: "https://scombz.shibaura-it.ac.jp/portal/home",
      },
      response,
    );

    await vi.waitFor(() => expect(response).toHaveBeenCalledTimes(1));
    expect(response).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false }),
    );
    expect(createTab).not.toHaveBeenCalled();
  });

  it.each([
    {
      action_type: "visit_shelf" as const,
      surface: {
        status: "known" as const,
        holding_visible: true,
        official_viewer_visible: false,
        official_viewer_url: null,
      },
      expected_url:
        "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/ACTION-RECORD-1",
    },
    {
      action_type: "open_online" as const,
      surface: {
        status: "known" as const,
        holding_visible: false,
        official_viewer_visible: true,
        official_viewer_url:
          "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/ACTION-RECORD-1/viewer",
      },
      expected_url:
        "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/ACTION-RECORD-1/viewer",
    },
  ])(
    "previews and opens the exact official URL for read-only %s",
    async ({ action_type, surface, expected_url }) => {
      permissionsContains.mockResolvedValue(true);
      getTab.mockResolvedValue({
        id: 91,
        windowId: 1,
        status: "complete",
        url: "https://library.shibaura-it.ac.jp/opc/",
      } as chrome.tabs.Tab);
      const record =
        action_type === "open_online"
          ? {
              ...publicActionRecord(),
              holdings: [
                {
                  campus: "unknown" as const,
                  location: null,
                  call_number: null,
                  status: "electronic",
                  due_date: null,
                  reservation_count: 0,
                },
              ],
            }
          : publicActionRecord();
      executeScript
        .mockResolvedValueOnce([{ result: { status: "submitted" } }])
        .mockResolvedValueOnce([
          { result: { status: "known", records: [record] } },
        ]);
      const searchResponse = vi.fn();
      onMessage.dispatch(
        {
          type: MESSAGE_TYPES.libraryCatalogSearch,
          tool_call_id: "library-action-record",
          query: "公開操作検証資料",
          limit: 1,
        },
        {},
        searchResponse,
      );
      await vi.waitFor(() => expect(searchResponse).toHaveBeenCalledTimes(1));
      const resourceRef = searchResponse.mock.calls[0]?.[0]?.projection
        ?.items?.[0]?.resource_ref as string | undefined;
      expect(resourceRef).toMatch(
        /^orbit-library:\/\/record\/[A-Za-z0-9_-]{16,128}$/u,
      );

      createTab.mockClear();
      executeScript.mockReset();
      executeScript
        .mockResolvedValueOnce([
          { result: { status: "known", records: [record] } },
        ])
        .mockResolvedValueOnce([{ result: surface }]);
      const previewResponse = vi.fn();
      onMessage.dispatch(
        {
          type: MESSAGE_TYPES.libraryActionPreview,
          tool_call_id: "library-action-preview",
          operation: { action_type, resource_ref: resourceRef },
        },
        {},
        previewResponse,
      );
      await vi.waitFor(() => expect(previewResponse).toHaveBeenCalledTimes(1));
      const preview = previewResponse.mock.calls[0]?.[0] as {
        status: string;
        preview_id?: string;
      };
      expect(preview.status).toBe("ready");
      expect(preview.preview_id).toMatch(
        /^orbit-library:\/\/preview\/[A-Za-z0-9_-]{16,128}$/u,
      );

      executeScript.mockReset();
      executeScript
        .mockResolvedValueOnce([
          { result: { status: "known", records: [record] } },
        ])
        .mockResolvedValueOnce([{ result: surface }]);
      const submitResponse = vi.fn();
      onMessage.dispatch(
        {
          type: MESSAGE_TYPES.libraryActionSubmit,
          tool_call_id: "library-action-preview",
          preview_id: preview.preview_id,
          inputs: { action_type, values: {} },
          confirmation_label: "公式ページを開く",
        },
        {},
        submitResponse,
      );
      await vi.waitFor(() => expect(submitResponse).toHaveBeenCalledTimes(1));
      expect(submitResponse).toHaveBeenCalledWith({
        status: "verified",
        action_type,
      });
      expect(createTab).toHaveBeenLastCalledWith({
        url: expected_url,
        active: true,
      });
    },
  );
});
