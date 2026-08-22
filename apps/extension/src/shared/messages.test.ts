import { describe, expect, it } from "vitest";
import {
  isCastOpenMessage,
  isCastReadMessage,
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
  });
  it("accepts only the observed SITRUS grade notice route", () => {
    expect(
      isSitrusReadMessage({
        type: "sitrus-read",
        tool_call_id: "tool-1",
        page_url:
          "https://sitrus.sic.shibaura-it.ac.jp/SITRUS/login/SeisekiTsutiSho.html?N=synthetic",
      }),
    ).toBe(true);
    expect(
      isSitrusReadMessage({
        type: "sitrus-read",
        tool_call_id: "tool-2",
        page_url:
          "https://sitrus.sic.shibaura-it.ac.jp/SITRUS/login/ShutokuTaniShukei.html?N=synthetic",
      }),
    ).toBe(true);
    expect(
      isSitrusReadMessage({
        type: "sitrus-read",
        tool_call_id: "tool-1",
        page_url: "https://sitrus.sic.shibaura-it.ac.jp/404",
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
