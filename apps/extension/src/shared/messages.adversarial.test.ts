import { describe, expect, it } from "vitest";
import {
  driveCommandMessage,
  isDriveCommandMessage,
  isLibraryActionPreviewMessage,
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

  it("rejects an alternate ScombZ port as a different origin", () => {
    expect(
      isPageContext({
        title: "ScombZ",
        url: "https://scombz.shibaura-it.ac.jp:8443/portal/home",
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

describe("Google Drive command message boundaries", () => {
  it("accepts only the minimal opaque selection command envelope", () => {
    expect(
      isDriveCommandMessage({
        type: MESSAGE_TYPES.driveRead,
        selection_id: "sel_message_01",
      }),
    ).toBe(true);
    expect(
      isDriveCommandMessage({
        type: MESSAGE_TYPES.driveDeselect,
        selection_id: "sel_message_01",
      }),
    ).toBe(true);
    expect(isDriveCommandMessage({ type: MESSAGE_TYPES.driveSelect })).toBe(
      true,
    );
    expect(isDriveCommandMessage({ type: MESSAGE_TYPES.driveRefresh })).toBe(
      true,
    );
    expect(driveCommandMessage("read", "sel_message_01")).toEqual({
      type: MESSAGE_TYPES.driveRead,
      selection_id: "sel_message_01",
    });
  });

  it.each([
    ["provider file ID", "1AbCDeFghIjKlMnOpQrStUvWxYz"],
    ["token", "sel_access_token_01"],
    ["auth value", "sel_auth_01"],
    ["raw content", "raw secret content"],
  ])("rejects %s in selection_id", (_label, selectionId) => {
    expect(
      isDriveCommandMessage({
        type: MESSAGE_TYPES.driveRead,
        selection_id: selectionId,
      }),
    ).toBe(false);
    expect(() => driveCommandMessage("read", selectionId)).toThrow(
      "opaque selection ID",
    );
  });

  it("rejects extra fields, IDs, content, and tokens from all Drive commands", () => {
    const invalidMessages = [
      {
        type: MESSAGE_TYPES.driveRead,
        selection_id: "sel_message_01",
        fileId: "drive-internal-file-01",
      },
      {
        type: MESSAGE_TYPES.driveDeselect,
        selection_id: "sel_message_01",
        content: "private content",
      },
      {
        type: MESSAGE_TYPES.driveSelect,
        token: "access-token-secret",
      },
      {
        type: MESSAGE_TYPES.driveRefresh,
        file_id: "drive-internal-file-01",
      },
      {
        type: MESSAGE_TYPES.driveRead,
        selection_id: "sel_message_01",
        access_token: "access-token-secret",
      },
    ];

    for (const message of invalidMessages) {
      expect(isDriveCommandMessage(message)).toBe(false);
    }
    expect(() => driveCommandMessage("read")).toThrow();
    expect(() => driveCommandMessage("deselect", "")).toThrow();
    expect(() => driveCommandMessage("deselect", "sel_auth_01")).toThrow();
  });
});

describe("library action preview message boundaries", () => {
  it.each([
    "visit_shelf",
    "open_online",
    "reserve",
    "intercampus_transfer",
    "renew",
    "purchase_request",
    "ill_loan",
    "ill_copy",
  ] as const)(
    "accepts only an opaque %s operation reference",
    (action_type) => {
      const operation = {
        action_type,
        resource_ref: "orbit-library://record/ABCDEFGHIJKLMNOP",
      } as const;
      expect(
        isLibraryActionPreviewMessage({
          type: MESSAGE_TYPES.libraryActionPreview,
          tool_call_id: "library-preview-call",
          operation,
        }),
      ).toBe(true);
      expect(
        isLibraryActionPreviewMessage({
          type: MESSAGE_TYPES.libraryActionPreview,
          tool_call_id: "library-preview-call",
          operation,
          reason: "must-stay-in-local-confirmation-memory",
        }),
      ).toBe(false);
      expect(
        isLibraryActionPreviewMessage({
          type: MESSAGE_TYPES.libraryActionPreview,
          tool_call_id: "library-preview-call",
          operation,
          arguments: { page_range: "12-18", payment: "private" },
        }),
      ).toBe(false);
    },
  );
});
