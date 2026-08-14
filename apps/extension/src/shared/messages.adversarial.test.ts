import { describe, expect, it } from "vitest";
import {
  isPageContext,
  isPageContextUpdatedMessage,
  MESSAGE_TYPES,
} from "./messages";

const SCOMBZ_URL = "https://scombz.shibaura-it.ac.jp";

const validScombzContext = {
  title: "ScombZ",
  url: `${SCOMBZ_URL}/portal/home`,
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

describe("runtime page-context message boundaries", () => {
  it("rejects a context whose kind and origin disagree", () => {
    expect(
      isPageContext({
        ...validScombzContext,
        url: "https://example.com/pretending-to-be-scombz",
      }),
    ).toBe(false);
  });

  it("rejects an ScombZ URL marked as another page kind", () => {
    expect(
      isPageContext({
        title: "ScombZ",
        url: `${SCOMBZ_URL}/portal/home`,
        kind: "other",
      }),
    ).toBe(false);
  });

  it("rejects insecure ScombZ URLs marked as ScombZ", () => {
    expect(
      isPageContext({
        title: "ScombZ",
        url: "http://scombz.shibaura-it.ac.jp/portal/home",
        kind: "scombz",
      }),
    ).toBe(false);
  });

  it("rejects unsafe nested URLs through the actual runtime message guard", () => {
    const unsafeValues = [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///tmp/private.txt",
    ];

    for (const unsafeUrl of unsafeValues) {
      expect(
        isPageContextUpdatedMessage({
          type: MESSAGE_TYPES.pageContextUpdated,
          context: {
            ...validScombzContext,
            scombz: {
              ...validScombzContext.scombz,
              announcements: [{ title: "不正リンク", url: unsafeUrl }],
            },
          },
        }),
      ).toBe(false);
    }
  });

  it("rejects malformed runtime envelopes instead of treating them as updates", () => {
    expect(
      isPageContextUpdatedMessage({
        type: MESSAGE_TYPES.pageContextUpdated,
        context: undefined,
      }),
    ).toBe(false);
    expect(
      isPageContextUpdatedMessage({
        type: MESSAGE_TYPES.pageContextUpdated,
        context: { ...validScombzContext, scombz: "not-an-object" },
      }),
    ).toBe(false);
    expect(
      isPageContextUpdatedMessage({
        type: "page-context-updated",
        context: { ...validScombzContext, title: 42 },
      }),
    ).toBe(false);
  });
});
