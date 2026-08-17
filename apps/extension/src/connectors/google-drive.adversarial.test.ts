import { describe, expect, it, vi } from "vitest";
import {
  createFixtureDriveConnector,
  DRIVE_FOLDER_MIME_TYPE,
  DRIVE_MAX_BYTES,
  DRIVE_SHORTCUT_MIME_TYPE,
  type DriveFileReader,
  type DriveSelectionCandidate,
  type DriveSelectionProvider,
  type DriveSelectionRecord,
  driveReadFormatForMimeType,
  FixtureDriveFileReader,
  GoogleDriveConnector,
  InMemoryDriveSelectionStorage,
  mapDriveSelectionToEvidence,
  validateDriveSelectionCandidate,
} from "./google-drive";

const INTERNAL_FILE_ID = "drive-internal-file-01";
const RAW_CONTENT = "raw-secret-content";
const ACCESS_TOKEN = "access-token-secret";

const validCandidate: DriveSelectionCandidate = {
  fileId: INTERNAL_FILE_ID,
  name: "公開ノート.txt",
  mimeType: "text/plain",
  sizeBytes: 128,
  modifiedTime: "2026-08-15T03:00:00.000Z",
  trashed: false,
  canDownload: true,
  dataClassification: "public",
};

function candidate(
  patch: Partial<DriveSelectionCandidate> = {},
): DriveSelectionCandidate {
  return { ...validCandidate, ...patch };
}

describe("Google Drive connector adversarial boundaries", () => {
  it("stores only an opaque selection mapping and keeps provider identifiers/content out of public results", async () => {
    const storage = new InMemoryDriveSelectionStorage();
    const reader: DriveFileReader = {
      read: vi.fn(async () => ({
        bytesRead: 128,
        content: RAW_CONTENT,
        token: ACCESS_TOKEN,
      })),
    };
    const connector = createFixtureDriveConnector({
      candidates: candidate(),
      reader,
      storage,
      selectionIdFactory: () => "sel_public_01",
    });

    const selected = await connector.select();
    expect(selected.status).toBe("connected");
    expect(selected.selection).toMatchObject({
      selectionId: "sel_public_01",
      name: validCandidate.name,
      mimeType: validCandidate.mimeType,
      sizeBytes: validCandidate.sizeBytes,
      modifiedTime: validCandidate.modifiedTime,
      status: "selected",
    });
    expect(selected.selection).not.toHaveProperty("fileId");
    expect(JSON.stringify(selected)).not.toContain(INTERNAL_FILE_ID);
    expect(JSON.stringify(selected)).not.toContain(RAW_CONTENT);
    expect(JSON.stringify(selected)).not.toContain(ACCESS_TOKEN);

    const saved = await storage.load();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual<DriveSelectionRecord>({
      selectionId: "sel_public_01",
      fileId: INTERNAL_FILE_ID,
      name: validCandidate.name,
      mimeType: "text/plain",
      sizeBytes: 128,
      modifiedTime: validCandidate.modifiedTime,
      dataClassification: "public",
      status: "selected",
    });
    expect(Object.keys(saved[0] ?? {}).sort()).toEqual([
      "dataClassification",
      "fileId",
      "mimeType",
      "modifiedTime",
      "name",
      "selectionId",
      "sizeBytes",
      "status",
    ]);

    const readResult = await connector.read("sel_public_01");
    expect(readResult.evidence).toEqual({
      evidence_id: "ev-sel_public_01",
      title: validCandidate.name,
      source_type: "google_drive",
      locator: "orbit-drive://sel_public_01",
      data_classification: "public",
    });
    expect(JSON.stringify(readResult)).not.toContain(INTERNAL_FILE_ID);
    expect(JSON.stringify(readResult)).not.toContain(RAW_CONTENT);
    expect(JSON.stringify(readResult)).not.toContain(ACCESS_TOKEN);
  });

  it("passes only the explicitly selected internal file ID to the injected reader", async () => {
    const select = vi.fn(async () => candidate());
    const provider: DriveSelectionProvider = {
      select,
    };
    const read = vi.fn(async () => undefined);
    const reader: DriveFileReader = {
      read,
    };
    const connector = new GoogleDriveConnector({
      provider,
      reader,
      storage: new InMemoryDriveSelectionStorage(),
      selectionIdFactory: () => "sel_reader_01",
    });

    expect(read).not.toHaveBeenCalled();
    await connector.select();
    expect(select).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();

    await connector.read("sel_reader_01");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(INTERNAL_FILE_ID, "text/plain");
    expect(read.mock.calls.flat().some((value) => value === ACCESS_TOKEN)).toBe(
      false,
    );
  });

  it("rejects a list-shaped provider response instead of exposing files.list behavior", async () => {
    const select = vi.fn(
      async () => [candidate()] as unknown as DriveSelectionCandidate,
    );
    const provider: DriveSelectionProvider = {
      select,
    };
    const reader = new FixtureDriveFileReader();
    const connector = new GoogleDriveConnector({
      provider,
      reader,
      storage: new InMemoryDriveSelectionStorage(),
      selectionIdFactory: () => "sel_list_01",
    });

    await expect(connector.select()).resolves.toMatchObject({
      status: "unavailable",
      selections: [],
    });
    expect(reader.requests).toEqual([]);
  });

  it("rejects an unselected selection ID before calling the reader", async () => {
    const reader = new FixtureDriveFileReader();
    const connector = createFixtureDriveConnector({
      reader,
      selectionIdFactory: () => "sel_unused_01",
    });

    const result = await connector.read("sel_unknown_01");
    expect(result).toMatchObject({ status: "unavailable", selections: [] });
    expect(reader.requests).toEqual([]);
  });

  it("deselects immediately so a later read cannot reach the provider reader", async () => {
    const reader = new FixtureDriveFileReader();
    const connector = createFixtureDriveConnector({
      candidates: candidate(),
      reader,
      selectionIdFactory: () => "sel_deselect_01",
    });

    await connector.select();
    await expect(connector.deselect("sel_deselect_01")).resolves.toMatchObject({
      status: "not_connected",
      selections: [],
    });

    const readResult = await connector.read("sel_deselect_01");
    expect(readResult).toMatchObject({ status: "unavailable", selections: [] });
    expect(reader.requests).toEqual([]);
  });

  it("restores saved metadata on refresh without invoking provider or reader", async () => {
    const storage = new InMemoryDriveSelectionStorage([
      {
        selectionId: "sel_saved_01",
        fileId: INTERNAL_FILE_ID,
        name: validCandidate.name,
        mimeType: "text/plain",
        sizeBytes: 128,
        modifiedTime: validCandidate.modifiedTime,
        dataClassification: "public",
        status: "selected",
      },
    ]);
    const select = vi.fn(async () => candidate());
    const provider: DriveSelectionProvider = { select };
    const read = vi.fn(async () => undefined);
    const reader: DriveFileReader = {
      read,
    };
    const connector = new GoogleDriveConnector({ provider, reader, storage });

    const refreshed = await connector.refresh();
    expect(refreshed).toMatchObject({
      status: "connected",
      selections: [
        {
          selectionId: "sel_saved_01",
          name: validCandidate.name,
          mimeType: "text/plain",
          sizeBytes: validCandidate.sizeBytes,
          modifiedTime: validCandidate.modifiedTime,
          status: "selected",
        },
      ],
    });
    expect(select).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(JSON.stringify(refreshed)).not.toContain(INTERNAL_FILE_ID);
    expect(JSON.stringify(refreshed)).not.toContain(RAW_CONTENT);
    expect(JSON.stringify(refreshed)).not.toContain(ACCESS_TOKEN);

    await connector.read("sel_saved_01");
    expect(read).toHaveBeenCalledWith(INTERNAL_FILE_ID, "text/plain");
  });

  it.each([
    ["unsupported MIME", { mimeType: "application/pdf" }],
    ["overlarge file", { sizeBytes: DRIVE_MAX_BYTES + 1 }],
    ["trashed file", { trashed: true }],
    ["download-disabled file", { canDownload: false }],
    ["folder MIME", { mimeType: DRIVE_FOLDER_MIME_TYPE }],
    ["folder flag", { isFolder: true }],
    ["shortcut MIME", { mimeType: DRIVE_SHORTCUT_MIME_TYPE }],
    ["shortcut flag", { isShortcut: true }],
    ["missing size", { sizeBytes: null }],
  ] as const)("fails closed for %s", async (_label, patch) => {
    const invalid = candidate(patch);
    expect(validateDriveSelectionCandidate(invalid)).not.toBeNull();

    const reader = new FixtureDriveFileReader();
    const connector = createFixtureDriveConnector({
      candidates: invalid,
      reader,
      selectionIdFactory: () => "sel_invalid_01",
    });
    const result = await connector.select();
    expect(result).toMatchObject({ status: "unavailable", selections: [] });
    expect(reader.requests).toEqual([]);
  });

  it("normalizes Google Docs and Slides reads to text/plain", async () => {
    expect(
      driveReadFormatForMimeType("application/vnd.google-apps.document"),
    ).toBe("text/plain");
    expect(
      driveReadFormatForMimeType("application/vnd.google-apps.presentation"),
    ).toBe("text/plain");

    const reader = new FixtureDriveFileReader();
    const connector = createFixtureDriveConnector({
      candidates: [
        candidate({
          fileId: "drive-doc-internal",
          name: "授業ノート",
          mimeType: "application/vnd.google-apps.document",
          sizeBytes: null,
        }),
        candidate({
          fileId: "drive-slides-internal",
          name: "発表資料",
          mimeType: "application/vnd.google-apps.presentation",
          sizeBytes: null,
        }),
      ],
      reader,
      selectionIdFactory: (() => {
        const ids = ["sel_doc_01", "sel_slides_01"];
        return () => ids.shift() ?? "sel_extra_01";
      })(),
    });

    await connector.select();
    await connector.select();
    await connector.read("sel_doc_01");
    await connector.read("sel_slides_01");

    expect(reader.requests).toEqual([
      { fileId: "drive-doc-internal", format: "text/plain" },
      { fileId: "drive-slides-internal", format: "text/plain" },
    ]);
  });

  it("creates a google_drive EvidenceLink with an opaque locator and classification", () => {
    expect(
      mapDriveSelectionToEvidence(
        { selectionId: "sel_evidence_01", name: "資料" },
        "restricted",
      ),
    ).toEqual({
      evidence_id: "ev-sel_evidence_01",
      title: "資料",
      source_type: "google_drive",
      locator: "orbit-drive://sel_evidence_01",
      data_classification: "restricted",
    });
  });
});
