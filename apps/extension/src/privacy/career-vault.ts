import { argon2id } from "hash-wasm";

const DATABASE_NAME = "sit-orbit-career-vault";
const DATABASE_VERSION = 1;
const METADATA_STORE = "metadata";
const RECORD_STORE = "records";
const METADATA_KEY = "vault";
const PROBE_RECORD_ID = "__vault_probe__";
const SESSION_KEY = "orbit-career-vault-key-v1";
const AES_KEY_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
const AUTO_LOCK_MS = 15 * 60 * 1000;

export const CAREER_VAULT_SCHEMA_VERSION = 1;
export const CAREER_VAULT_KDF = {
  algorithm: "argon2id" as const,
  version: "1.3" as const,
  iterations: 2,
  memoryKib: 19_456,
  parallelism: 1,
  keyLength: AES_KEY_BYTES,
};

export interface VaultMetadata {
  schemaVersion: typeof CAREER_VAULT_SCHEMA_VERSION;
  createdAt: string;
  kdf: {
    algorithm: typeof CAREER_VAULT_KDF.algorithm;
    version: typeof CAREER_VAULT_KDF.version;
    iterations: number;
    memoryKib: number;
    parallelism: number;
    keyLength: number;
    salt: string;
  };
}

export interface VaultRecordEnvelope {
  schemaVersion: typeof CAREER_VAULT_SCHEMA_VERSION;
  recordId: string;
  iv: string;
  ciphertext: string;
}

export interface VaultStore {
  getMetadata(): Promise<VaultMetadata | null>;
  saveMetadata(metadata: VaultMetadata): Promise<void>;
  deleteMetadata(): Promise<void>;
  getRecord(recordId: string): Promise<VaultRecordEnvelope | null>;
  saveRecord(record: VaultRecordEnvelope): Promise<void>;
  deleteRecord(recordId: string): Promise<void>;
  clearRecords(): Promise<void>;
}

export interface SessionKeyStore {
  get(): Promise<Uint8Array | null>;
  set(key: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryVaultStore implements VaultStore {
  private metadata: VaultMetadata | null = null;
  private readonly records = new Map<string, VaultRecordEnvelope>();

  async getMetadata(): Promise<VaultMetadata | null> {
    return this.metadata ? structuredClone(this.metadata) : null;
  }

  async saveMetadata(metadata: VaultMetadata): Promise<void> {
    this.metadata = structuredClone(metadata);
  }

  async deleteMetadata(): Promise<void> {
    this.metadata = null;
  }

  async getRecord(recordId: string): Promise<VaultRecordEnvelope | null> {
    const record = this.records.get(recordId);
    return record ? structuredClone(record) : null;
  }

  async saveRecord(record: VaultRecordEnvelope): Promise<void> {
    this.records.set(record.recordId, structuredClone(record));
  }

  async deleteRecord(recordId: string): Promise<void> {
    this.records.delete(recordId);
  }

  async clearRecords(): Promise<void> {
    for (const recordId of this.records.keys()) {
      if (recordId !== PROBE_RECORD_ID) {
        this.records.delete(recordId);
      }
    }
  }

  snapshot(): {
    metadata: VaultMetadata | null;
    records: VaultRecordEnvelope[];
  } {
    return {
      metadata: this.metadata ? structuredClone(this.metadata) : null,
      records: structuredClone([...this.records.values()]),
    };
  }
}

export class MemorySessionKeyStore implements SessionKeyStore {
  private key: Uint8Array | null = null;

  async get(): Promise<Uint8Array | null> {
    return this.key ? new Uint8Array(this.key) : null;
  }

  async set(key: Uint8Array): Promise<void> {
    this.key = new Uint8Array(key);
  }

  async clear(): Promise<void> {
    this.key = null;
  }
}

export const chromeSessionKeyStore: SessionKeyStore = {
  async get() {
    if (!globalThis.chrome?.storage?.session) {
      throw new Error("Chrome session storage is unavailable.");
    }
    const stored = await chrome.storage.session.get(SESSION_KEY);
    const value = stored[SESSION_KEY];
    return typeof value === "string"
      ? fromBase64(value)
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : value instanceof Uint8Array
          ? new Uint8Array(value)
          : null;
  },
  async set(key) {
    if (!globalThis.chrome?.storage?.session) {
      throw new Error("Chrome session storage is unavailable.");
    }
    await chrome.storage.session.set({ [SESSION_KEY]: toBase64(key) });
  },
  async clear() {
    if (!globalThis.chrome?.storage?.session) {
      throw new Error("Chrome session storage is unavailable.");
    }
    await chrome.storage.session.remove(SESSION_KEY);
  },
};

function getWebCrypto(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new Error("Web Crypto API is unavailable.");
  }
  return globalThis.crypto;
}

function toBase64(value: Uint8Array): string {
  if (typeof btoa !== "function") {
    throw new Error("Base64 encoding is unavailable.");
  }
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  if (typeof atob !== "function") {
    throw new Error("Base64 decoding is unavailable.");
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  getWebCrypto().getRandomValues(bytes);
  return bytes;
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer as ArrayBuffer;
}

function decodeText(value: ArrayBuffer): string {
  return new TextDecoder().decode(value);
}

function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== "string" || passphrase.trim().length === 0) {
    throw new TypeError("Vault passphrase must not be empty.");
  }
}

function assertRecordId(recordId: string): void {
  if (typeof recordId !== "string" || recordId.trim().length === 0) {
    throw new TypeError("Vault record ID must not be empty.");
  }
}

async function deriveKeyBytes(
  passphrase: string,
  metadata: VaultMetadata,
): Promise<Uint8Array> {
  const derived = await argon2id({
    password: passphrase,
    salt: fromBase64(metadata.kdf.salt),
    iterations: metadata.kdf.iterations,
    parallelism: metadata.kdf.parallelism,
    memorySize: metadata.kdf.memoryKib,
    hashLength: metadata.kdf.keyLength,
    outputType: "binary",
  });
  if (
    !(derived instanceof Uint8Array) ||
    derived.byteLength !== AES_KEY_BYTES
  ) {
    throw new Error("Argon2id returned an invalid key.");
  }
  return new Uint8Array(derived);
}

async function importAesKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  if (keyBytes.byteLength !== AES_KEY_BYTES) {
    throw new Error("Vault key has an invalid length.");
  }
  return getWebCrypto().subtle.importKey(
    "raw",
    ownedBuffer(keyBytes),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

function validateMetadata(metadata: VaultMetadata): void {
  if (
    metadata.schemaVersion !== CAREER_VAULT_SCHEMA_VERSION ||
    metadata.kdf.algorithm !== CAREER_VAULT_KDF.algorithm ||
    metadata.kdf.version !== CAREER_VAULT_KDF.version ||
    metadata.kdf.keyLength !== AES_KEY_BYTES ||
    metadata.kdf.iterations < 1 ||
    metadata.kdf.memoryKib < 19_456 ||
    metadata.kdf.parallelism < 1 ||
    typeof metadata.kdf.salt !== "string"
  ) {
    throw new Error("Unsupported or invalid Career Vault metadata.");
  }
  try {
    if (fromBase64(metadata.kdf.salt).byteLength < 16) {
      throw new Error("Career Vault salt is too short.");
    }
  } catch {
    throw new Error("Career Vault salt is invalid.");
  }
}

function validateRecord(record: VaultRecordEnvelope, recordId: string): void {
  if (
    record.schemaVersion !== CAREER_VAULT_SCHEMA_VERSION ||
    record.recordId !== recordId ||
    typeof record.iv !== "string" ||
    typeof record.ciphertext !== "string"
  ) {
    throw new Error("Invalid Career Vault record.");
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new Error(
        "IndexedDB is unavailable; Career Vault cannot persist safely.",
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(METADATA_STORE)) {
        database.createObjectStore(METADATA_STORE, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(RECORD_STORE)) {
        database.createObjectStore(RECORD_STORE, { keyPath: "recordId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Career Vault IndexedDB error."));
  });
}

export class IndexedDbVaultStore implements VaultStore {
  async getMetadata(): Promise<VaultMetadata | null> {
    const database = await openDatabase();
    try {
      return await new Promise<VaultMetadata | null>((resolve, reject) => {
        const request = database
          .transaction(METADATA_STORE, "readonly")
          .objectStore(METADATA_STORE)
          .get(METADATA_KEY);
        request.onsuccess = () => {
          const value = request.result as
            | ({ key: string } & VaultMetadata)
            | undefined;
          if (!value) {
            resolve(null);
            return;
          }
          const { key: _key, ...metadata } = value;
          resolve(metadata);
        };
        request.onerror = () =>
          reject(
            request.error ?? new Error("Career Vault metadata read error."),
          );
      });
    } finally {
      database.close();
    }
  }

  async saveMetadata(metadata: VaultMetadata): Promise<void> {
    const database = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(METADATA_STORE, "readwrite");
        transaction.objectStore(METADATA_STORE).put({
          key: METADATA_KEY,
          ...metadata,
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(
            transaction.error ??
              new Error("Career Vault metadata write error."),
          );
      });
    } finally {
      database.close();
    }
  }

  async deleteMetadata(): Promise<void> {
    const database = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(METADATA_STORE, "readwrite");
        transaction.objectStore(METADATA_STORE).delete(METADATA_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(
            transaction.error ??
              new Error("Career Vault metadata delete error."),
          );
      });
    } finally {
      database.close();
    }
  }

  async getRecord(recordId: string): Promise<VaultRecordEnvelope | null> {
    const database = await openDatabase();
    try {
      return await new Promise<VaultRecordEnvelope | null>(
        (resolve, reject) => {
          const request = database
            .transaction(RECORD_STORE, "readonly")
            .objectStore(RECORD_STORE)
            .get(recordId);
          request.onsuccess = () =>
            resolve(
              (request.result as VaultRecordEnvelope | undefined) ?? null,
            );
          request.onerror = () =>
            reject(
              request.error ?? new Error("Career Vault record read error."),
            );
        },
      );
    } finally {
      database.close();
    }
  }

  async saveRecord(record: VaultRecordEnvelope): Promise<void> {
    const database = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(RECORD_STORE, "readwrite");
        transaction.objectStore(RECORD_STORE).put(record);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(
            transaction.error ?? new Error("Career Vault record write error."),
          );
      });
    } finally {
      database.close();
    }
  }

  async deleteRecord(recordId: string): Promise<void> {
    const database = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(RECORD_STORE, "readwrite");
        transaction.objectStore(RECORD_STORE).delete(recordId);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(
            transaction.error ?? new Error("Career Vault record delete error."),
          );
      });
    } finally {
      database.close();
    }
  }

  async clearRecords(): Promise<void> {
    const database = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(RECORD_STORE, "readwrite");
        const store = transaction.objectStore(RECORD_STORE);
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            return;
          }
          if (cursor.key !== PROBE_RECORD_ID) {
            cursor.delete();
          }
          cursor.continue();
        };
        request.onerror = () =>
          reject(request.error ?? new Error("Career Vault clear error."));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("Career Vault clear error."));
      });
    } finally {
      database.close();
    }
  }
}

export interface CareerVaultOptions {
  store?: VaultStore;
  sessionKeyStore?: SessionKeyStore;
  autoLockMs?: number;
}

export class CareerVault {
  private readonly store: VaultStore;
  private readonly sessionKeyStore: SessionKeyStore;
  private readonly autoLockMs: number;
  private metadata: VaultMetadata | null = null;
  private key: CryptoKey | null = null;
  private keyBytes: Uint8Array | null = null;
  private lockTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: CareerVaultOptions = {}) {
    this.store = options.store ?? new IndexedDbVaultStore();
    this.sessionKeyStore = options.sessionKeyStore ?? chromeSessionKeyStore;
    this.autoLockMs = options.autoLockMs ?? AUTO_LOCK_MS;
  }

  get isUnlocked(): boolean {
    return this.key !== null;
  }

  async initialize(): Promise<VaultMetadata | null> {
    const metadata = await this.store.getMetadata();
    if (metadata) {
      validateMetadata(metadata);
    }
    this.metadata = metadata;
    return metadata;
  }

  async create(passphrase: string): Promise<VaultMetadata> {
    assertPassphrase(passphrase);
    const existing = this.metadata ?? (await this.store.getMetadata());
    if (existing) {
      throw new Error("Career Vault already exists; unlock it instead.");
    }
    const metadata: VaultMetadata = {
      schemaVersion: CAREER_VAULT_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      kdf: {
        ...CAREER_VAULT_KDF,
        salt: toBase64(randomBytes(16)),
      },
    };
    const keyBytes = await deriveKeyBytes(passphrase, metadata);
    await this.store.saveMetadata(metadata);
    this.metadata = metadata;
    await this.activate(keyBytes);
    await this.putEncrypted(PROBE_RECORD_ID, {
      schemaVersion: CAREER_VAULT_SCHEMA_VERSION,
      purpose: "passphrase-verification",
    });
    return metadata;
  }

  async unlock(passphrase: string): Promise<void> {
    assertPassphrase(passphrase);
    const metadata = this.metadata ?? (await this.store.getMetadata());
    if (!metadata) {
      throw new Error("Career Vault has not been created.");
    }
    validateMetadata(metadata);
    const keyBytes = await deriveKeyBytes(passphrase, metadata);
    const key = await importAesKey(keyBytes);
    await this.verifyKey(key);
    this.metadata = metadata;
    await this.activate(keyBytes, key);
  }

  async restoreSession(): Promise<boolean> {
    const metadata = this.metadata ?? (await this.store.getMetadata());
    if (!metadata) {
      return false;
    }
    validateMetadata(metadata);
    const keyBytes = await this.sessionKeyStore.get();
    if (!keyBytes) {
      return false;
    }
    try {
      const key = await importAesKey(keyBytes);
      await this.verifyKey(key);
      this.metadata = metadata;
      await this.activate(keyBytes, key);
      return true;
    } catch {
      await this.sessionKeyStore.clear();
      return false;
    }
  }

  async lock(): Promise<void> {
    if (this.lockTimer) {
      clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
    this.key = null;
    this.keyBytes?.fill(0);
    this.keyBytes = null;
    await this.sessionKeyStore.clear();
  }

  async hmac(value: string): Promise<Uint8Array> {
    if (typeof value !== "string") {
      throw new TypeError("Career Vault HMAC input must be text.");
    }
    const keyBytes = this.keyBytes;
    if (!keyBytes) {
      throw new Error("Career Vault is locked.");
    }
    const hmacKey = await getWebCrypto().subtle.importKey(
      "raw",
      ownedBuffer(keyBytes),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await getWebCrypto().subtle.sign(
      "HMAC",
      hmacKey,
      ownedBuffer(textBytes(value)),
    );
    this.touch();
    return new Uint8Array(digest);
  }

  async put(recordId: string, value: unknown): Promise<void> {
    assertRecordId(recordId);
    if (recordId === PROBE_RECORD_ID) {
      throw new Error("The Career Vault verification record is reserved.");
    }
    await this.putEncrypted(recordId, value);
  }

  private async putEncrypted(recordId: string, value: unknown): Promise<void> {
    const key = this.requireKey();
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("Career Vault values must be JSON-serializable.");
    }
    const iv = randomBytes(AES_GCM_IV_BYTES);
    const ciphertext = await getWebCrypto().subtle.encrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(iv),
        additionalData: ownedBuffer(textBytes(recordId)),
        tagLength: 128,
      },
      key,
      ownedBuffer(textBytes(serialized)),
    );
    await this.store.saveRecord({
      schemaVersion: CAREER_VAULT_SCHEMA_VERSION,
      recordId,
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(ciphertext)),
    });
    this.touch();
  }

  async get<T = unknown>(recordId: string): Promise<T | null> {
    assertRecordId(recordId);
    const key = this.requireKey();
    const record = await this.store.getRecord(recordId);
    if (!record) {
      return null;
    }
    validateRecord(record, recordId);
    const plaintext = await getWebCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(fromBase64(record.iv)),
        additionalData: ownedBuffer(textBytes(recordId)),
        tagLength: 128,
      },
      key,
      ownedBuffer(fromBase64(record.ciphertext)),
    );
    this.touch();
    return JSON.parse(decodeText(plaintext)) as T;
  }

  async delete(recordId: string): Promise<void> {
    assertRecordId(recordId);
    if (recordId === PROBE_RECORD_ID) {
      throw new Error("The Career Vault verification record is reserved.");
    }
    this.requireKey();
    await this.store.deleteRecord(recordId);
    this.touch();
  }

  async clear(): Promise<void> {
    this.requireKey();
    await this.store.clearRecords();
    this.touch();
  }

  async destroy(): Promise<void> {
    this.requireKey();
    await this.store.clearRecords();
    await this.store.deleteRecord(PROBE_RECORD_ID);
    await this.store.deleteMetadata();
    this.metadata = null;
    await this.lock();
  }

  private async activate(keyBytes: Uint8Array, key?: CryptoKey): Promise<void> {
    const activeKey = key ?? (await importAesKey(keyBytes));
    await this.sessionKeyStore.set(keyBytes);
    this.key = activeKey;
    this.keyBytes?.fill(0);
    this.keyBytes = new Uint8Array(keyBytes);
    this.touch();
  }

  private async verifyKey(key: CryptoKey): Promise<void> {
    const probe = await this.store.getRecord(PROBE_RECORD_ID);
    if (!probe) {
      throw new Error("Career Vault verification record is missing.");
    }
    validateRecord(probe, PROBE_RECORD_ID);
    try {
      await getWebCrypto().subtle.decrypt(
        {
          name: "AES-GCM",
          iv: ownedBuffer(fromBase64(probe.iv)),
          additionalData: ownedBuffer(textBytes(probe.recordId)),
          tagLength: 128,
        },
        key,
        ownedBuffer(fromBase64(probe.ciphertext)),
      );
    } catch {
      throw new Error("Invalid Career Vault passphrase.");
    }
  }

  private requireKey(): CryptoKey {
    if (!this.key) {
      throw new Error("Career Vault is locked.");
    }
    return this.key;
  }

  private touch(): void {
    if (this.lockTimer) {
      clearTimeout(this.lockTimer);
    }
    this.lockTimer = setTimeout(() => {
      void this.lock();
    }, this.autoLockMs);
  }
}
