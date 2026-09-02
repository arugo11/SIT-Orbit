import { describe, expect, it } from "vitest";
import {
  isCastAlumniReadMessage,
  isCastCareerSearchMessage,
  isCastOpenMessage,
  isCastReadMessage,
  isCastSearchMessage,
  isLibraryCatalogBrowseMessage,
  isLibraryCatalogSearchMessage,
  isLibraryDiscoverySearchMessage,
  isLibraryItemReadMessage,
  isMoodleOpenMessage,
  isMoodleReadMessage,
  isMyLibraryOpenMessage,
  isMyLibraryReadMessage,
  isOpenWorkspaceMessage,
  isPageContext,
  isSitrusReadMessage,
  isUpdateWorkspaceSessionMessage,
} from "./messages";

const validContext = {
  title: "ScombZ",
  url: "https://scombz.shibaura-it.ac.jp/portal/home",
  kind: "scombz",
  scombz: {
    route: "home",
    tasks: [],
    announcements: [],
    calendar: {
      googleCalendarUrl: null,
      icsUrl: null,
    },
    currentCourse: null,
    relatedLinks: [],
  },
} as const;

describe("page context message validation", () => {
  it("accepts strict public library tool arguments", () => {
    expect(
      isLibraryCatalogSearchMessage({
        type: "library-catalog-search",
        tool_call_id: "library-search-1",
        query: "ロボット",
        campus: "omiya",
        format: "book",
        limit: 5,
      }),
    ).toBe(true);
    expect(
      isLibraryItemReadMessage({
        type: "library-item-read",
        tool_call_id: "library-read-1",
        resource_ref: "orbit-library://record/0123456789abcdef",
        record_url:
          "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/RELOAD-1",
      }),
    ).toBe(true);
    expect(
      isLibraryCatalogBrowseMessage({
        type: "library-catalog-browse",
        tool_call_id: "library-browse-1",
        kind: "loan_ranking",
        limit: 10,
      }),
    ).toBe(true);
    expect(
      isLibraryDiscoverySearchMessage({
        type: "library-discovery-search",
        tool_call_id: "library-discovery-1",
        query: "機械学習",
      }),
    ).toBe(true);
  });

  it("rejects library IDs, oversized queries, and invalid filters", () => {
    expect(
      isLibraryItemReadMessage({
        type: "library-item-read",
        tool_call_id: "library-read-1",
        resource_ref: "orbit-library://record/OPAC-123",
      }),
    ).toBe(false);
    expect(
      isLibraryItemReadMessage({
        type: "library-item-read",
        tool_call_id: "library-read-1",
        resource_ref: "orbit-library://record/0123456789abcdef",
        record_url:
          "https://library.shibaura-it.ac.jp/opc/recordID/catalog.bib/RELOAD-1?hit=1",
      }),
    ).toBe(false);
    expect(
      isLibraryCatalogSearchMessage({
        type: "library-catalog-search",
        tool_call_id: "library-search-1",
        query: "x".repeat(201),
      }),
    ).toBe(false);
    expect(
      isLibraryCatalogBrowseMessage({
        type: "library-catalog-browse",
        tool_call_id: "library-browse-1",
        kind: "new_books",
        limit: 0,
      }),
    ).toBe(false);
    expect(
      isLibraryDiscoverySearchMessage({
        type: "library-discovery-search",
        tool_call_id: "library-discovery-1",
        query: " ",
      }),
    ).toBe(false);
  });

  it("accepts only typed Moodle commands", () => {
    expect(
      isMoodleReadMessage({ type: "moodle-read", tool_call_id: "tool-1" }),
    ).toBe(true);
    expect(isMoodleReadMessage({ type: "moodle-read", tool_call_id: "" })).toBe(
      false,
    );
    expect(isMoodleOpenMessage({ type: "moodle-open" })).toBe(true);
  });
  it("accepts only typed My Library commands", () => {
    expect(
      isMyLibraryReadMessage({
        type: "my-library-read",
        tool_call_id: "tool-1",
      }),
    ).toBe(true);
    expect(
      isMyLibraryReadMessage({
        type: "my-library-read",
        tool_call_id: "",
      }),
    ).toBe(false);
    expect(isMyLibraryOpenMessage({ type: "my-library-open" })).toBe(true);
  });

  it("accepts only typed CAST commands", () => {
    expect(
      isCastReadMessage({ type: "cast-read", tool_call_id: "tool-1" }),
    ).toBe(true);
    expect(isCastReadMessage({ type: "cast-read", tool_call_id: "" })).toBe(
      false,
    );
    expect(isCastOpenMessage({ type: "cast-open" })).toBe(true);
    expect(
      isCastAlumniReadMessage({
        type: "cast-alumni-read",
        tool_call_id: "alumni-1",
      }),
    ).toBe(true);
    expect(
      isCastAlumniReadMessage({
        type: "cast-alumni-read",
        tool_call_id: "",
      }),
    ).toBe(false);
    expect(
      isCastSearchMessage({
        type: "cast-search",
        tool_call_id: "cast-search-1",
        kind: "hiring_record",
        filters: { graduation_years: [2024, 2023] },
      }),
    ).toBe(true);
    expect(
      isCastSearchMessage({
        type: "cast-search",
        tool_call_id: "cast-search-2",
        kind: "job",
        filters: {},
        form_action: "/career/evil",
      }),
    ).toBe(false);
    expect(
      isCastCareerSearchMessage({
        type: "cast-career-search",
        tool_call_id: "career-1",
        query: "情報系の就職先",
        surfaces: ["company", "hiring_record", "selection_report"],
        filters: { obog_required: true },
        limit: 10,
      }),
    ).toBe(true);
    expect(
      isCastCareerSearchMessage({
        type: "cast-career-search",
        tool_call_id: "career-2",
        query: "情報系の就職先",
        surfaces: ["company"],
        filters: {},
        limit: 10,
        url: "https://evil.example.invalid",
      }),
    ).toBe(false);
  });
  it("accepts only the page-independent SITRUS read command", () => {
    expect(
      isSitrusReadMessage({
        type: "sitrus-read",
        tool_call_id: "tool-1",
      }),
    ).toBe(true);
    expect(
      isSitrusReadMessage({
        type: "sitrus-read",
        tool_call_id: "tool-2",
        page_url: "https://sitrus.sic.shibaura-it.ac.jp/forbidden",
      }),
    ).toBe(false);
    expect(
      isSitrusReadMessage({
        type: "sitrus-read",
        tool_call_id: "",
      }),
    ).toBe(false);
  });

  it("accepts a structurally valid optional ScombZ payload", () => {
    expect(isPageContext(validContext)).toBe(true);
  });

  it("rejects malformed nested ScombZ links and fields", () => {
    expect(
      isPageContext({
        ...validContext,
        scombz: {
          ...validContext.scombz,
          tasks: [
            {
              course: "合成コース",
              title: "合成課題",
              deadline: "2026-08-20",
              url: "javascript:alert(1)",
            },
          ],
        },
      }),
    ).toBe(false);
    expect(
      isPageContext({
        ...validContext,
        scombz: {
          ...validContext.scombz,
          calendar: { googleCalendarUrl: null },
        },
      }),
    ).toBe(false);
  });

  it("rejects ScombZ data attached to an other-origin context", () => {
    expect(
      isPageContext({
        ...validContext,
        kind: "other",
      }),
    ).toBe(false);
  });
});

describe("workspace message validation", () => {
  const stableState = {
    status: "idle",
    proposal: null,
    completionEvent: null,
    changeNote: "",
    error: null,
  } as const;

  it("accepts stable workspace handoffs and rejects in-flight state", () => {
    expect(
      isOpenWorkspaceMessage({
        type: "open-workspace",
        stable_state: stableState,
      }),
    ).toBe(true);
    expect(
      isOpenWorkspaceMessage({
        type: "open-workspace",
        stable_state: { ...stableState, status: "tool-running" },
      }),
    ).toBe(false);
  });

  it("requires a session ID and stable state for workspace updates", () => {
    expect(
      isUpdateWorkspaceSessionMessage({
        type: "update-workspace-session",
        session_id: "11111111-1111-4111-8111-111111111111",
        stable_state: stableState,
      }),
    ).toBe(true);
    expect(
      isUpdateWorkspaceSessionMessage({
        type: "update-workspace-session",
        stable_state: stableState,
      }),
    ).toBe(false);
  });
});
