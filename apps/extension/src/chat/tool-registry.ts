export interface RegisteredChatClientTool {
  name: RegisteredChatToolName;
  version: 1;
}

/**
 * The single source of truth for tools which may be advertised by the Chat
 * client.  Keeping this list outside of the React component is important for
 * the CLI audit runner: both paths must expose exactly the same read-only
 * surface and neither path may invent a write-capable tool at runtime.
 */
export const CHAT_TOOL_NAMES = [
  "scombz_page_summary",
  "scombz_read",
  "scombz_course_list",
  "scombz_portal_read",
  "scombz_course_read",
  "scombz_material_search",
  "google_calendar_availability",
  "syllabus_search",
  "syllabus_read",
  "browser_read_url",
  "sitrus_read",
  "moodle_read",
  "my_library_read",
  "cast_read",
  "cast_alumni_read",
  "cast_search",
  "library_catalog_search",
  "library_item_read",
  "library_catalog_browse",
  "library_discovery_search",
  "library_action_options",
] as const;

export type RegisteredChatToolName = (typeof CHAT_TOOL_NAMES)[number];

export const READ_ONLY_CHAT_TOOL_NAMES = new Set<RegisteredChatToolName>(
  CHAT_TOOL_NAMES,
);

export const LIVE_SCOMBZ_TOOL_NAMES = new Set<RegisteredChatToolName>([
  "scombz_course_list",
  "scombz_portal_read",
  "scombz_course_read",
  "scombz_material_search",
]);

export interface ToolAdvertisementOptions {
  /** Tools available in the current page/connector context. */
  locallyAvailable?: ReadonlySet<string> | null;
  /** Tool names explicitly accepted by the authenticated API. */
  serverAllowed?: ReadonlySet<string> | null;
  maxClientTools?: number;
}

/**
 * Intersect local and server capabilities without ever adding a write tool.
 * The order is stable so audit transcripts can compare Side Panel and CLI
 * runs deterministically.
 */
export function advertiseReadOnlyTools(
  options: ToolAdvertisementOptions = {},
): RegisteredChatClientTool[] {
  const max = Math.min(
    CHAT_TOOL_NAMES.length,
    Math.max(1, Math.trunc(options.maxClientTools ?? 32)),
  );
  const local = options.locallyAvailable;
  const server = options.serverAllowed;
  return CHAT_TOOL_NAMES.filter(
    (name) =>
      (local === null || local === undefined || local.has(name)) &&
      (server === null || server === undefined || server.has(name)),
  )
    .slice(0, max)
    .map((name) => ({ name, version: 1 as const }));
}

export function isRegisteredReadOnlyTool(
  value: unknown,
): value is RegisteredChatToolName {
  return (
    typeof value === "string" &&
    (CHAT_TOOL_NAMES as readonly string[]).includes(value)
  );
}

const NO_ARGUMENT_TOOLS = new Set<RegisteredChatToolName>([
  "scombz_page_summary",
  "scombz_read",
  "google_calendar_availability",
  "sitrus_read",
  "moodle_read",
  "cast_read",
  "cast_alumni_read",
]);

const ARGUMENT_KEYS: Record<RegisteredChatToolName, readonly string[]> = {
  scombz_page_summary: [],
  scombz_read: [],
  scombz_course_list: ["query", "academic_year", "term", "cursor"],
  scombz_portal_read: ["sections", "query", "cursor"],
  scombz_course_read: [
    "course_refs",
    "sections",
    "query",
    "cursor",
    "include_own_submission",
  ],
  scombz_material_search: ["course_ref", "query", "cursor"],
  google_calendar_availability: [],
  syllabus_search: ["query", "year", "faculty"],
  syllabus_read: ["syllabus_ref"],
  browser_read_url: ["url"],
  sitrus_read: [],
  moodle_read: [],
  my_library_read: ["scope", "query", "offset", "limit"],
  cast_read: [],
  cast_alumni_read: [],
  cast_search: ["kind", "filters", "sort", "cursor", "exhaustive"],
  library_catalog_search: [
    "query",
    "author",
    "subject",
    "isbn",
    "pub_year",
    "campus",
    "format",
    "limit",
  ],
  library_item_read: ["resource_ref", "presentation"],
  library_catalog_browse: ["kind", "campus", "limit"],
  library_discovery_search: ["query", "limit"],
  library_action_options: ["resource_ref"],
};

/**
 * Lightweight, UI-independent argument guard.  Detailed connector guards
 * still run before network access; this guard prevents malformed model calls
 * from reaching either the Side Panel or the CLI bridge.
 */
export function validateChatToolArguments(
  name: RegisteredChatToolName,
  argumentsObject: unknown,
):
  | { ok: true; arguments: Record<string, unknown> }
  | { ok: false; reason: string } {
  if (
    typeof argumentsObject !== "object" ||
    argumentsObject === null ||
    Array.isArray(argumentsObject)
  ) {
    return { ok: false, reason: "arguments_not_object" };
  }
  const args = argumentsObject as Record<string, unknown>;
  const keys = Object.keys(args);
  if (NO_ARGUMENT_TOOLS.has(name) && keys.length > 0) {
    return { ok: false, reason: "arguments_not_allowed" };
  }
  const allowed = new Set(ARGUMENT_KEYS[name]);
  if (keys.some((key) => !allowed.has(key))) {
    return { ok: false, reason: "unknown_argument" };
  }
  const optionalString = (
    key: string,
    maxLength: number,
    nonEmpty = false,
  ): boolean => {
    const value = args[key];
    if (value === undefined || value === null) return true;
    return (
      typeof value === "string" &&
      value.length <= maxLength &&
      (!nonEmpty || value.trim().length > 0)
    );
  };
  const optionalInteger = (key: string, min: number, max: number): boolean => {
    const value = args[key];
    return (
      value === undefined ||
      value === null ||
      (typeof value === "number" &&
        Number.isInteger(value) &&
        value >= min &&
        value <= max)
    );
  };
  const optionalBoolean = (key: string): boolean => {
    const value = args[key];
    return value === undefined || value === null || typeof value === "boolean";
  };
  const optionalArray = (
    key: string,
    maxLength: number,
    itemMaxLength = 120,
  ): boolean => {
    const value = args[key];
    return (
      value === undefined ||
      value === null ||
      (Array.isArray(value) &&
        value.length <= maxLength &&
        value.every(
          (item) =>
            typeof item === "string" &&
            item.trim().length > 0 &&
            item.length <= itemMaxLength,
        ))
    );
  };
  const opaque = (value: unknown, pattern: RegExp): boolean =>
    typeof value === "string" && pattern.test(value);
  const scombzCursor = /^orbit-scombz:\/\/cursor\/[A-Za-z0-9_-]{16,128}$/u;
  const libraryRef = /^orbit-library:\/\/record\/[A-Za-z0-9_-]{16,128}$/u;
  const cursorAllowed = (key: string): boolean => {
    const value = args[key];
    return value === undefined || value === null || opaque(value, scombzCursor);
  };
  if (name === "syllabus_read") {
    if (
      keys.length !== 1 ||
      typeof args.syllabus_ref !== "string" ||
      !/^orbit-syllabus:\/\/result\/[A-Za-z0-9_-]{16,128}$/u.test(
        args.syllabus_ref,
      )
    ) {
      return { ok: false, reason: "invalid_syllabus_ref" };
    }
  }
  if (name === "scombz_course_read") {
    if (
      !Array.isArray(args.course_refs) ||
      args.course_refs.length < 1 ||
      args.course_refs.length > 5 ||
      !args.course_refs.every(
        (value) =>
          typeof value === "string" &&
          /^orbit-scombz:\/\/course\/[A-Za-z0-9_-]{16,128}$/u.test(value),
      )
    ) {
      return { ok: false, reason: "invalid_course_refs" };
    }
    if (
      !optionalArray("sections", 12) ||
      !optionalString("query", 200, false)
    ) {
      return { ok: false, reason: "invalid_course_sections" };
    }
    if (!cursorAllowed("cursor")) {
      return { ok: false, reason: "invalid_course_cursor" };
    }
    if (
      args.include_own_submission !== undefined &&
      typeof args.include_own_submission !== "boolean"
    ) {
      return { ok: false, reason: "invalid_submission_flag" };
    }
  }
  if (name === "scombz_material_search") {
    if (
      typeof args.course_ref !== "string" ||
      !/^orbit-scombz:\/\/course\/[A-Za-z0-9_-]{16,128}$/u.test(
        args.course_ref,
      ) ||
      typeof args.query !== "string" ||
      args.query.trim().length === 0 ||
      args.query.length > 200
    ) {
      return { ok: false, reason: "invalid_material_query" };
    }
    if (!cursorAllowed("cursor")) {
      return { ok: false, reason: "invalid_material_cursor" };
    }
  }
  if (name === "scombz_course_list") {
    if (
      !optionalString("query", 200, false) ||
      !optionalString("term", 80, true) ||
      !optionalInteger("academic_year", 2000, 2100) ||
      !cursorAllowed("cursor")
    ) {
      return { ok: false, reason: "invalid_course_list_arguments" };
    }
  }
  if (name === "scombz_portal_read") {
    if (
      !optionalArray("sections", 12) ||
      !optionalString("query", 200, false) ||
      !cursorAllowed("cursor")
    ) {
      return { ok: false, reason: "invalid_portal_arguments" };
    }
  }
  if (name === "syllabus_search") {
    if (
      typeof args.query !== "string" ||
      args.query.trim().length === 0 ||
      args.query.length > 200 ||
      !optionalInteger("year", 2000, 2100) ||
      !optionalString("faculty", 200, false)
    ) {
      return { ok: false, reason: "invalid_syllabus_query" };
    }
  }
  if (name === "browser_read_url") {
    if (
      keys.length !== 1 ||
      typeof args.url !== "string" ||
      args.url.length > 500
    ) {
      return { ok: false, reason: "invalid_browser_url" };
    }
    try {
      const url = new URL(args.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        /(?:^|&)(?:token|access_token|refresh_token|csrf|session|key)=/iu.test(
          url.search.replace(/^\?/u, ""),
        )
      ) {
        return { ok: false, reason: "invalid_browser_url" };
      }
    } catch {
      return { ok: false, reason: "invalid_browser_url" };
    }
  }
  if (name === "cast_search") {
    if (
      ![
        "job",
        "internship",
        "company_session",
        "company",
        "hiring_record",
      ].includes(args.kind as string) ||
      (args.filters !== undefined &&
        (typeof args.filters !== "object" ||
          args.filters === null ||
          Array.isArray(args.filters))) ||
      (args.sort !== undefined &&
        (typeof args.sort !== "object" ||
          args.sort === null ||
          Array.isArray(args.sort))) ||
      !optionalString("cursor", 200, true) ||
      !optionalBoolean("exhaustive")
    ) {
      return { ok: false, reason: "invalid_cast_search_arguments" };
    }
  }
  if (name === "my_library_read") {
    if (
      (args.scope !== undefined &&
        ![
          "current_loans",
          "reservations",
          "loan_history",
          "purchase_requests",
          "interlibrary_requests",
        ].includes(args.scope as string)) ||
      !optionalString("query", 200, false) ||
      !optionalInteger("offset", 0, 1000) ||
      !optionalInteger("limit", 1, 20)
    ) {
      return { ok: false, reason: "invalid_my_library_arguments" };
    }
  }
  if (name === "library_catalog_search") {
    if (
      typeof args.query !== "string" ||
      args.query.trim().length === 0 ||
      args.query.length > 200 ||
      !optionalString("author", 200) ||
      !optionalString("subject", 200) ||
      !optionalString("isbn", 32) ||
      !optionalInteger("pub_year", 1000, 2100) ||
      (args.campus !== undefined &&
        !["toyosu", "omiya", "any"].includes(args.campus as string)) ||
      (args.format !== undefined &&
        !["book", "journal", "ebook", "any"].includes(args.format as string)) ||
      !optionalInteger("limit", 1, 10)
    ) {
      return { ok: false, reason: "invalid_library_search_arguments" };
    }
  }
  if (name === "library_item_read" || name === "library_action_options") {
    if (
      typeof args.resource_ref !== "string" ||
      !opaque(args.resource_ref, libraryRef) ||
      (name === "library_item_read" &&
        args.presentation !== undefined &&
        args.presentation !== "summary" &&
        args.presentation !== "location")
    ) {
      return { ok: false, reason: "invalid_library_ref" };
    }
  }
  if (name === "library_catalog_browse") {
    if (
      !["new_books", "loan_ranking"].includes(args.kind as string) ||
      (args.campus !== undefined &&
        !["toyosu", "omiya", "any"].includes(args.campus as string)) ||
      !optionalInteger("limit", 1, 10)
    ) {
      return { ok: false, reason: "invalid_library_browse_arguments" };
    }
  }
  if (name === "library_discovery_search") {
    if (
      typeof args.query !== "string" ||
      args.query.trim().length === 0 ||
      args.query.length > 200 ||
      !optionalInteger("limit", 1, 10)
    ) {
      return { ok: false, reason: "invalid_library_discovery_arguments" };
    }
  }
  return { ok: true, arguments: args };
}

export function toolDisplayLabel(name: string): string {
  const labels: Partial<Record<RegisteredChatToolName, string>> = {
    scombz_page_summary: "SCombZを確認中",
    scombz_read: "SCombZを確認中",
    scombz_course_list: "SCombZの履修科目を確認中",
    scombz_portal_read: "SCombZのポータル情報を確認中",
    scombz_course_read: "SCombZの授業情報を確認中",
    scombz_material_search: "SCombZの授業資料を検索中",
    syllabus_search: "シラバスを検索中",
    syllabus_read: "シラバス詳細を確認中",
    browser_read_url: "ページを参照中",
    google_calendar_availability: "Google Calendarを確認中",
    sitrus_read: "SITRUSの成績を確認中",
    moodle_read: "Moodleを確認中",
    my_library_read: "My Libraryを確認中",
    cast_read: "CASTを確認中",
    cast_alumni_read: "CASTの就活サポーターを確認中",
    cast_search: "CASTを検索中",
    library_catalog_search: "書籍ごとにOPACを確認中",
    library_item_read: "所蔵詳細を確認中",
    library_catalog_browse: "書誌情報を確認中",
    library_discovery_search: "SIT Searchを検索中",
    library_action_options: "図書館の操作可否を確認中",
  };
  return (isRegisteredReadOnlyTool(name) && labels[name]) || "情報を確認中";
}
