import { describe, expect, it } from "vitest";
import {
  isOpenWorkspaceMessage,
  isPageContext,
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
