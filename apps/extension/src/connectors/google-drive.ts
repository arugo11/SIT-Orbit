export const DRIVE_MAX_BYTES = 10_000_000;

export const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
export const DRIVE_SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";

export const DRIVE_ALLOWED_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.presentation",
] as const;

export type DriveAllowedMimeType = (typeof DRIVE_ALLOWED_MIME_TYPES)[number];
export type DriveConnectorStatus =
  | "not_connected"
  | "connected"
  | "reauth_required"
  | "unavailable";
export type DriveSelectionStatus = "selected" | "read";
export type DriveReadFormat =
  | "text/plain"
  | "text/markdown"
  | "text/csv"
  | "application/json";
export type DriveDataClassification =
  | "synthetic"
  | "public"
  | "personal"
  | "restricted";

/** Metadata returned by a provider for one explicitly selected file.
 *
 * `fileId` is an internal connector value. It must never be copied into a
 * message, a `DriveSelectionView`, or a `DriveConnectorResult`.
 */
export interface DriveSelectionCandidate {
  fileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  modifiedTime: string | null;
  trashed?: boolean;
  canDownload?: boolean;
  isFolder?: boolean;
  isShortcut?: boolean;
  dataClassification?: DriveDataClassification;
}

/** Internal session record. The only persisted identifier is the provider's
 * file ID, paired with an opaque selection ID. No content or credentials are
 * part of this record.
 */
export interface DriveSelectionRecord {
  selectionId: string;
  fileId: string;
  name: string;
  mimeType: DriveAllowedMimeType;
  sizeBytes: number | null;
  modifiedTime: string | null;
  dataClassification: DriveDataClassification;
  status: DriveSelectionStatus;
}

export interface DriveEvidenceLink {
  evidence_id: string;
  title: string;
  source_type: "google_drive";
  locator: string;
  data_classification: DriveDataClassification;
}

export interface DriveSelectionView {
  selectionId: string;
  name: string;
  mimeType: DriveAllowedMimeType;
  sizeBytes: number | null;
  modifiedTime: string | null;
  status: DriveSelectionStatus;
  evidence?: DriveEvidenceLink;
}

export interface DriveReadOutcome {
  /** Optional reader-side metadata. Raw file content is deliberately absent. */
  bytesRead?: number;
}

export interface DriveConnectorResult {
  status: DriveConnectorStatus;
  selections: DriveSelectionView[];
  selection?: DriveSelectionView;
  evidence?: DriveEvidenceLink;
  message?: string;
  retryable?: boolean;
}

/** A provider returns one Picker selection, or null when the user cancels. */
export interface DriveSelectionProvider {
  select(): Promise<DriveSelectionCandidate | null>;
}

/** The reader receives only an approved internal ID and a normalized format. */
export interface DriveFileReader {
  read(
    fileId: string,
    format: DriveReadFormat,
  ): Promise<DriveReadOutcome | undefined>;
}

/** Session storage contains metadata mapping only; it never stores content or tokens. */
export interface DriveSelectionStorage {
  load(): Promise<DriveSelectionRecord[]>;
  save(record: DriveSelectionRecord): Promise<void>;
  remove(selectionId: string): Promise<void>;
}

export interface GoogleDriveConnectorOptions {
  provider?: DriveSelectionProvider;
  reader?: DriveFileReader;
  storage?: DriveSelectionStorage;
  selectionIdFactory?: () => string;
}

export interface FixtureDriveConnectorOptions {
  candidates?: DriveSelectionCandidate | DriveSelectionCandidate[];
  reader?: DriveFileReader;
  storage?: DriveSelectionStorage;
  selectionIdFactory?: () => string;
}

export class DriveConnectorError extends Error {
  readonly status: Extract<
    DriveConnectorStatus,
    "reauth_required" | "unavailable"
  >;
  readonly retryable: boolean;

  constructor(
    status: Extract<DriveConnectorStatus, "reauth_required" | "unavailable">,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = "DriveConnectorError";
    this.status = status;
    this.retryable = retryable;
  }
}

const DRIVE_SELECTIONS_STORAGE_KEY = "orbitDriveSelections";

export function isAllowedDriveMimeType(
  value: unknown,
): value is DriveAllowedMimeType {
  return (
    typeof value === "string" &&
    (DRIVE_ALLOWED_MIME_TYPES as readonly string[]).includes(value)
  );
}

export function driveReadFormatForMimeType(
  mimeType: DriveAllowedMimeType,
): DriveReadFormat {
  if (
    mimeType === "application/vnd.google-apps.document" ||
    mimeType === "application/vnd.google-apps.presentation"
  ) {
    return "text/plain";
  }
  return mimeType;
}

export function isOpaqueDriveSelectionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^sel_[A-Za-z0-9_-]{1,124}$/.test(value) &&
    !value.toLowerCase().includes("token") &&
    !value.toLowerCase().includes("auth")
  );
}

export function validateDriveSelectionCandidate(
  candidate: DriveSelectionCandidate,
): string | null {
  if (
    candidate.fileId.trim().length === 0 ||
    candidate.name.trim().length === 0
  ) {
    return "Google Driveの選択情報が不完全です。";
  }
  if (
    candidate.isFolder === true ||
    candidate.mimeType === DRIVE_FOLDER_MIME_TYPE
  ) {
    return "フォルダは選択できません。ファイルを選択してください。";
  }
  if (
    candidate.isShortcut === true ||
    candidate.mimeType === DRIVE_SHORTCUT_MIME_TYPE
  ) {
    return "ショートカットは選択できません。元のファイルを選択してください。";
  }
  if (!isAllowedDriveMimeType(candidate.mimeType)) {
    return "このファイル形式は読み取れません。対応形式を選択してください。";
  }
  const sizeBytes = candidate.sizeBytes;
  const workspaceDocument =
    candidate.mimeType === "application/vnd.google-apps.document" ||
    candidate.mimeType === "application/vnd.google-apps.presentation";
  if (sizeBytes === null) {
    if (!workspaceDocument) {
      return "ファイルサイズを確認できないため、読み取りを中止しました。";
    }
  } else {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      return "ファイルサイズを確認できないため、読み取りを中止しました。";
    }
    if (sizeBytes > DRIVE_MAX_BYTES) {
      return "ファイルサイズが上限（10,000,000 bytes）を超えています。";
    }
  }
  if (candidate.trashed === true) {
    return "ゴミ箱に入ったファイルは読み取れません。";
  }
  if (candidate.canDownload !== true) {
    return "ダウンロード権限を確認できないファイルは読み取れません。";
  }
  return null;
}

export function mapDriveSelectionToEvidence(
  selection: Pick<DriveSelectionView, "selectionId" | "name">,
  dataClassification: DriveDataClassification = "personal",
): DriveEvidenceLink {
  return {
    evidence_id: `ev-${selection.selectionId}`,
    title: selection.name,
    source_type: "google_drive",
    locator: `orbit-drive://${selection.selectionId}`,
    data_classification: dataClassification,
  };
}

export function toDriveSelectionView(
  record: DriveSelectionRecord,
): DriveSelectionView {
  const selection: DriveSelectionView = {
    selectionId: record.selectionId,
    name: record.name,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    modifiedTime: record.modifiedTime,
    status: record.status,
  };
  if (record.status === "read") {
    selection.evidence = mapDriveSelectionToEvidence(
      selection,
      record.dataClassification,
    );
  }
  return selection;
}

export class GoogleDriveConnector implements DriveConnector {
  private readonly provider: DriveSelectionProvider;
  private readonly reader: DriveFileReader;
  private readonly storage: DriveSelectionStorage;
  private readonly selectionIdFactory: () => string;
  private readonly providerConfigured: boolean;
  private readonly selections = new Map<string, DriveSelectionRecord>();
  private loaded = false;

  constructor(options: GoogleDriveConnectorOptions = {}) {
    this.provider = options.provider ?? new UnavailableDriveSelectionProvider();
    this.reader = options.reader ?? new UnavailableDriveFileReader();
    this.storage = options.storage ?? new ChromeDriveSelectionStorage();
    this.selectionIdFactory =
      options.selectionIdFactory ?? createOpaqueSelectionId;
    this.providerConfigured = options.provider !== undefined;
  }

  async select(): Promise<DriveConnectorResult> {
    if (!(await this.ensureLoaded())) {
      return this.unavailable("Google Driveの選択状態を読み取れません。", true);
    }

    let candidate: DriveSelectionCandidate | null;
    try {
      const providerCandidate = await this.provider.select();
      if (providerCandidate === null) {
        candidate = null;
      } else if (isDriveSelectionCandidate(providerCandidate)) {
        candidate = providerCandidate;
      } else {
        return this.unavailable("Google Driveの選択情報を確認できません。", false);
      }
    } catch (error) {
      if (error instanceof DriveConnectorError) {
        return this.errorResult(error.status, error.message, error.retryable);
      }
      return this.unavailable(
        "Google Driveのファイル選択を利用できません。時間をおいて再試行してください。",
        true,
      );
    }

    if (candidate === null) {
      return this.currentResult("ファイル選択をキャンセルしました。", false);
    }

    const validationMessage = validateDriveSelectionCandidate(candidate);
    if (validationMessage !== null) {
      return this.unavailable(validationMessage, false);
    }

    let selectionId: string;
    try {
      selectionId = this.selectionIdFactory();
    } catch {
      return this.unavailable(
        "安全な選択IDを作成できないため、選択を保存できません。",
        false,
      );
    }
    if (!isOpaqueDriveSelectionId(selectionId)) {
      return this.unavailable(
        "安全な選択IDを作成できないため、選択を保存できません。",
        false,
      );
    }

    const record: DriveSelectionRecord = {
      selectionId,
      fileId: candidate.fileId,
      name: candidate.name,
      mimeType: candidate.mimeType as DriveAllowedMimeType,
      sizeBytes: candidate.sizeBytes,
      modifiedTime: candidate.modifiedTime,
      dataClassification: candidate.dataClassification ?? "personal",
      status: "selected",
    };

    try {
      await this.storage.save(record);
    } catch {
      return this.unavailable(
        "Google Driveの選択情報を安全に保存できません。",
        true,
      );
    }
    this.selections.set(selectionId, record);
    return {
      ...this.currentResult(),
      selection: toDriveSelectionView(record),
    };
  }

  async read(selectionId: string): Promise<DriveConnectorResult> {
    if (!isOpaqueDriveSelectionId(selectionId)) {
      return this.unavailable("読み取る選択を確認できません。", false);
    }
    if (!(await this.ensureLoaded())) {
      return this.unavailable("Google Driveの選択状態を読み取れません。", true);
    }

    const record = this.selections.get(selectionId);
    if (record === undefined) {
      return this.unavailable(
        "選択済みファイルが見つかりません。先にファイルを選択してください。",
        false,
      );
    }
    const validationMessage = validateStoredSelectionForRead(record);
    if (validationMessage !== null) {
      return this.unavailable(validationMessage, false);
    }

    try {
      const outcome = await this.reader.read(
        record.fileId,
        driveReadFormatForMimeType(record.mimeType),
      );
      if (
        outcome?.bytesRead !== undefined &&
        (!Number.isSafeInteger(outcome.bytesRead) ||
          outcome.bytesRead < 0 ||
          outcome.bytesRead > DRIVE_MAX_BYTES)
      ) {
        return this.unavailable(
          "読み取り結果が上限（10,000,000 bytes）を超えています。",
          false,
        );
      }
    } catch (error) {
      if (error instanceof DriveConnectorError) {
        return this.errorResult(error.status, error.message, error.retryable);
      }
      return this.unavailable(
        "Google Driveのファイルを読み取れません。時間をおいて再試行してください。",
        true,
      );
    }

    const readRecord: DriveSelectionRecord = { ...record, status: "read" };
    try {
      await this.storage.save(readRecord);
    } catch {
      return this.unavailable(
        "読み取り結果を安全に保存できないため、完了扱いにしません。",
        true,
      );
    }
    this.selections.set(selectionId, readRecord);
    const selection = toDriveSelectionView(readRecord);
    return {
      status: "connected",
      selections: this.views(),
      selection,
      evidence: selection.evidence,
    };
  }

  async deselect(selectionId: string): Promise<DriveConnectorResult> {
    if (!isOpaqueDriveSelectionId(selectionId)) {
      return this.unavailable("解除する選択を確認できません。", false);
    }
    if (!(await this.ensureLoaded())) {
      return this.unavailable("Google Driveの選択状態を読み取れません。", true);
    }
    if (!this.selections.has(selectionId)) {
      return this.unavailable("選択済みファイルが見つかりません。", false);
    }

    try {
      await this.storage.remove(selectionId);
    } catch {
      return this.unavailable("Google Driveの選択解除を保存できません。", true);
    }
    this.selections.delete(selectionId);
    return this.currentResult();
  }

  /** Explicitly reloads session metadata. It never calls a provider or lists files. */
  async refresh(): Promise<DriveConnectorResult> {
    this.loaded = false;
    this.selections.clear();
    if (!(await this.ensureLoaded())) {
      return this.unavailable("Google Driveの選択状態を読み取れません。", true);
    }
    if (!this.providerConfigured) {
      return this.unavailable(
        "Google Driveのファイル選択はまだ利用できません。ライブProviderは未設定です。",
        false,
      );
    }
    return this.currentResult();
  }

  private async ensureLoaded(): Promise<boolean> {
    if (this.loaded) {
      return true;
    }
    try {
      const records = await this.storage.load();
      this.selections.clear();
      for (const record of records) {
        if (isStoredSelectionRecord(record)) {
          this.selections.set(record.selectionId, { ...record });
        }
      }
      this.loaded = true;
      return true;
    } catch {
      return false;
    }
  }

  private views(): DriveSelectionView[] {
    return Array.from(this.selections.values(), toDriveSelectionView);
  }

  private currentResult(
    message?: string,
    retryable?: boolean,
  ): DriveConnectorResult {
    return {
      status: this.selections.size === 0 ? "not_connected" : "connected",
      selections: this.views(),
      ...(message === undefined ? {} : { message }),
      ...(retryable === undefined ? {} : { retryable }),
    };
  }

  private unavailable(
    message: string,
    retryable: boolean,
  ): DriveConnectorResult {
    return this.errorResult("unavailable", message, retryable);
  }

  private errorResult(
    status: Extract<DriveConnectorStatus, "reauth_required" | "unavailable">,
    message: string,
    retryable: boolean,
  ): DriveConnectorResult {
    return {
      status,
      selections: this.views(),
      message,
      retryable,
    };
  }
}

export interface DriveConnector {
  select(): Promise<DriveConnectorResult>;
  read(selectionId: string): Promise<DriveConnectorResult>;
  deselect(selectionId: string): Promise<DriveConnectorResult>;
  refresh(): Promise<DriveConnectorResult>;
}

export class UnavailableDriveSelectionProvider
  implements DriveSelectionProvider
{
  async select(): Promise<DriveSelectionCandidate | null> {
    throw new DriveConnectorError(
      "unavailable",
      "Google Driveのファイル選択はまだ利用できません。ライブProviderは未設定です。",
      false,
    );
  }
}

export class UnavailableDriveFileReader implements DriveFileReader {
  async read(
    _fileId: string,
    _format: DriveReadFormat,
  ): Promise<DriveReadOutcome | undefined> {
    throw new DriveConnectorError(
      "unavailable",
      "Google Driveの読み取りはまだ利用できません。ライブProviderは未設定です。",
      false,
    );
  }
}

export class ChromeDriveSelectionStorage implements DriveSelectionStorage {
  async load(): Promise<DriveSelectionRecord[]> {
    const area = chromeSessionStorage();
    const result = await area.get<{ [DRIVE_SELECTIONS_STORAGE_KEY]?: unknown }>(
      DRIVE_SELECTIONS_STORAGE_KEY,
    );
    const records = result[DRIVE_SELECTIONS_STORAGE_KEY];
    if (!Array.isArray(records)) {
      return [];
    }
    return records
      .filter(isStoredSelectionRecord)
      .map((record) => ({ ...record }));
  }

  async save(record: DriveSelectionRecord): Promise<void> {
    const area = chromeSessionStorage();
    const records = await this.load();
    const next = records.filter(
      (item) => item.selectionId !== record.selectionId,
    );
    next.push({ ...record });
    await area.set({ [DRIVE_SELECTIONS_STORAGE_KEY]: next });
  }

  async remove(selectionId: string): Promise<void> {
    const area = chromeSessionStorage();
    const records = await this.load();
    await area.set({
      [DRIVE_SELECTIONS_STORAGE_KEY]: records.filter(
        (record) => record.selectionId !== selectionId,
      ),
    });
  }
}

export class InMemoryDriveSelectionStorage implements DriveSelectionStorage {
  private readonly records = new Map<string, DriveSelectionRecord>();

  constructor(records: DriveSelectionRecord[] = []) {
    for (const record of records) {
      if (isStoredSelectionRecord(record)) {
        this.records.set(record.selectionId, { ...record });
      }
    }
  }

  async load(): Promise<DriveSelectionRecord[]> {
    return Array.from(this.records.values(), (record) => ({ ...record }));
  }

  async save(record: DriveSelectionRecord): Promise<void> {
    this.records.set(record.selectionId, { ...record });
  }

  async remove(selectionId: string): Promise<void> {
    this.records.delete(selectionId);
  }
}

export class FixtureDriveSelectionProvider implements DriveSelectionProvider {
  private readonly candidates: DriveSelectionCandidate[];

  constructor(
    candidates: DriveSelectionCandidate | DriveSelectionCandidate[] = [],
  ) {
    this.candidates = Array.isArray(candidates)
      ? candidates.map((candidate) => ({ ...candidate }))
      : [{ ...candidates }];
  }

  enqueue(candidate: DriveSelectionCandidate): void {
    this.candidates.push({ ...candidate });
  }

  async select(): Promise<DriveSelectionCandidate | null> {
    const candidate = this.candidates.shift();
    return candidate === undefined ? null : { ...candidate };
  }
}

export class FixtureDriveFileReader implements DriveFileReader {
  readonly requests: Array<{ fileId: string; format: DriveReadFormat }> = [];
  private readonly outcomes: Map<string, DriveReadOutcome | Error>;

  constructor(outcomes: Record<string, DriveReadOutcome | Error> = {}) {
    this.outcomes = new Map(Object.entries(outcomes));
  }

  async read(
    fileId: string,
    format: DriveReadFormat,
  ): Promise<DriveReadOutcome> {
    this.requests.push({ fileId, format });
    const outcome = this.outcomes.get(fileId);
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome ?? {};
  }
}

export function createFixtureDriveConnector(
  options: FixtureDriveConnectorOptions = {},
): GoogleDriveConnector {
  return new GoogleDriveConnector({
    provider: new FixtureDriveSelectionProvider(options.candidates ?? []),
    reader: options.reader ?? new FixtureDriveFileReader(),
    storage: options.storage ?? new InMemoryDriveSelectionStorage(),
    selectionIdFactory: options.selectionIdFactory,
  });
}

function createOpaqueSelectionId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === "string" && uuid.length > 0) {
    return `sel_${uuid.replaceAll("-", "")}`;
  }
  return `sel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function chromeSessionStorage(): chrome.storage.StorageArea {
  if (typeof chrome === "undefined" || chrome.storage?.session === undefined) {
    throw new Error("Chrome session storage is unavailable.");
  }
  return chrome.storage.session;
}

function isStoredSelectionRecord(
  value: unknown,
): value is DriveSelectionRecord {
  if (!isRecord(value)) {
    return false;
  }
  const sizeBytes = value.sizeBytes;
  return (
    isOpaqueDriveSelectionId(value.selectionId) &&
    typeof value.fileId === "string" &&
    value.fileId.length > 0 &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    isAllowedDriveMimeType(value.mimeType) &&
    (sizeBytes === null
      ? value.mimeType === "application/vnd.google-apps.document" ||
        value.mimeType === "application/vnd.google-apps.presentation"
      : typeof sizeBytes === "number" &&
        Number.isSafeInteger(sizeBytes) &&
        sizeBytes >= 0 &&
        sizeBytes <= DRIVE_MAX_BYTES) &&
    (typeof value.modifiedTime === "string" || value.modifiedTime === null) &&
    isDriveDataClassification(value.dataClassification) &&
    (value.status === "selected" || value.status === "read")
  );
}

function isDriveSelectionCandidate(
  value: unknown,
): value is DriveSelectionCandidate {
  return (
    isRecord(value) &&
    typeof value.fileId === "string" &&
    typeof value.name === "string" &&
    typeof value.mimeType === "string" &&
    (typeof value.sizeBytes === "number" || value.sizeBytes === null) &&
    (typeof value.modifiedTime === "string" || value.modifiedTime === null) &&
    (value.dataClassification === undefined ||
      isDriveDataClassification(value.dataClassification))
  );
}

function validateStoredSelectionForRead(
  record: DriveSelectionRecord,
): string | null {
  if (!isAllowedDriveMimeType(record.mimeType)) {
    return "このファイル形式は読み取れません。対応形式を選択してください。";
  }
  if (record.sizeBytes === null) {
    if (
      record.mimeType !== "application/vnd.google-apps.document" &&
      record.mimeType !== "application/vnd.google-apps.presentation"
    ) {
      return "ファイルサイズを確認できないため、読み取りを中止しました。";
    }
  } else if (
    !Number.isSafeInteger(record.sizeBytes) ||
    record.sizeBytes < 0 ||
    record.sizeBytes > DRIVE_MAX_BYTES
  ) {
    return "ファイルサイズが読み取り上限を超えています。";
  }
  return null;
}

function isDriveDataClassification(
  value: unknown,
): value is DriveDataClassification {
  return (
    value === "synthetic" ||
    value === "public" ||
    value === "personal" ||
    value === "restricted"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
