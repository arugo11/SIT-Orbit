/**
 * Conversation-scoped pseudonymization for provider-bound Chat context.
 *
 * This module intentionally handles typed projections and exact name spans
 * only. It is not a general-purpose anonymizer: arbitrary free text is
 * filtered or omitted when it cannot be classified safely.
 */

export const CONVERSATION_PSEUDONYMIZATION_VERSION = "v1" as const;
export const CONVERSATION_ALIAS_TTL_MS = 30 * 60 * 1000;
const DATABASE_NAME = "sit-orbit-conversation-aliases";
const DATABASE_VERSION = 1;
const STORE_NAME = "mappings";
const SESSION_KEY = "orbit-conversation-pseudonym-key-v1";

export type ConversationDataClassification =
  | "personal"
  | "restricted"
  | "public"
  | "synthetic";

export interface TypedConversationPerson {
  display_name?: string;
  name?: string;
  romanized_name?: string;
  source_identifier?: string;
  email?: string;
  phone?: string;
  student_id?: string;
  internal_id?: string;
  role?: string;
  company?: string;
  technical_domains?: string[];
  job_types?: string[];
  location_area?: string;
  graduation_year?: number;
  evidence_id?: string;
}

export interface ConversationEvidenceInput {
  evidence_id: string;
  title: string;
  source_type: string;
  locator: string;
  data_classification: ConversationDataClassification;
}

export interface ConversationHistoryInput {
  role: "user" | "assistant";
  content: string;
  people?: TypedConversationPerson[];
}

export interface PseudonymizedPersonProjection {
  alias: string;
  role: string;
  company?: string;
  technical_domains?: string[];
  job_types?: string[];
  location_area?: string;
  graduation_year_bucket?: string;
  evidence_id?: string;
}

export interface PseudonymizedEvidenceProjection {
  evidence_id: string;
  title: string;
  source_type: string;
  locator: string;
  data_classification: ConversationDataClassification;
}

export interface ConversationProviderTurn {
  provider_content: string;
  people: PseudonymizedPersonProjection[];
  evidence: PseudonymizedEvidenceProjection[];
}

export interface ConversationDisplayTurn {
  display_content: string;
  people: TypedConversationPerson[];
}

export interface ConversationTransformReport {
  schema_version: typeof CONVERSATION_PSEUDONYMIZATION_VERSION;
  replaced_count: number;
  removed_fields: string[];
  generalized_fields: string[];
  warnings: string[];
}

export interface ConversationTransformResult {
  provider: ConversationProviderTurn;
  display: ConversationDisplayTurn;
  report: ConversationTransformReport;
}

export interface ToolProjectionTransformResult<T = unknown> {
  /** The only projection that may be passed to the remote Agent API. */
  provider_result: T;
  report: ConversationTransformReport;
}

export interface AliasMapping {
  token: string;
  display_names: string[];
}

interface ConversationMapping {
  schema_version: typeof CONVERSATION_PSEUDONYMIZATION_VERSION;
  conversation_id: string;
  created_at: string;
  last_used_at: string;
  aliases: AliasMapping[];
}

export interface EncryptedMapping {
  schema_version: typeof CONVERSATION_PSEUDONYMIZATION_VERSION;
  conversation_id: string;
  iv: string;
  ciphertext: string;
  expires_at: string;
}

export interface ConversationAliasStore {
  get(conversationId: string): Promise<EncryptedMapping | null>;
  put(record: EncryptedMapping): Promise<void>;
  delete(conversationId: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ConversationSessionKeyStore {
  get(): Promise<Uint8Array | null>;
  set(key: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryConversationAliasStore implements ConversationAliasStore {
  private readonly records = new Map<string, EncryptedMapping>();

  async get(conversationId: string): Promise<EncryptedMapping | null> {
    const value = this.records.get(conversationId);
    return value ? structuredClone(value) : null;
  }

  async put(record: EncryptedMapping): Promise<void> {
    this.records.set(record.conversation_id, structuredClone(record));
  }

  async delete(conversationId: string): Promise<void> {
    this.records.delete(conversationId);
  }

  async clear(): Promise<void> {
    this.records.clear();
  }

  snapshot(): EncryptedMapping[] {
    return structuredClone([...this.records.values()]);
  }
}

export class MemoryConversationSessionKeyStore
  implements ConversationSessionKeyStore
{
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

export const chromeConversationSessionKeyStore: ConversationSessionKeyStore = {
  async get() {
    if (!globalThis.chrome?.storage?.session) return null;
    const stored = await chrome.storage.session.get(SESSION_KEY);
    const value = stored[SESSION_KEY];
    if (typeof value !== "string") return null;
    try {
      return fromBase64(value);
    } catch {
      return null;
    }
  },
  async set(key) {
    if (!globalThis.chrome?.storage?.session) {
      throw new Error("Chrome session storage is unavailable.");
    }
    await chrome.storage.session.set({ [SESSION_KEY]: toBase64(key) });
  },
  async clear() {
    if (!globalThis.chrome?.storage?.session) return;
    await chrome.storage.session.remove(SESSION_KEY);
  },
};

class IndexedDbConversationAliasStore implements ConversationAliasStore {
  private async database(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
      throw new Error("IndexedDB is unavailable.");
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, {
            keyPath: "conversation_id",
          });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("Alias database error."));
    });
  }

  async get(conversationId: string): Promise<EncryptedMapping | null> {
    const database = await this.database();
    try {
      return await new Promise<EncryptedMapping | null>((resolve, reject) => {
        const request = database
          .transaction(STORE_NAME, "readonly")
          .objectStore(STORE_NAME)
          .get(conversationId);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () =>
          reject(request.error ?? new Error("Alias database read error."));
      });
    } finally {
      database.close();
    }
  }

  async put(record: EncryptedMapping): Promise<void> {
    const database = await this.database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put(record);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("Alias database write error."));
      });
    } finally {
      database.close();
    }
  }

  async delete(conversationId: string): Promise<void> {
    const database = await this.database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).delete(conversationId);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(
            transaction.error ?? new Error("Alias database delete error."),
          );
      });
    } finally {
      database.close();
    }
  }

  async clear(): Promise<void> {
    const database = await this.database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).clear();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("Alias database clear error."));
      });
    } finally {
      database.close();
    }
  }
}

export interface ConversationPseudonymizationOptions {
  store?: ConversationAliasStore;
  keyStore?: ConversationSessionKeyStore;
  ttlMs?: number;
  now?: () => number;
}

function webCrypto(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new Error("Web Crypto API is unavailable.");
  }
  return globalThis.crypto;
}

function randomBytes(length: number): Uint8Array {
  const value = new Uint8Array(length);
  webCrypto().getRandomValues(value);
  return value;
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer as ArrayBuffer;
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function yearBucket(value: number | undefined): string | undefined {
  if (
    value === undefined ||
    !Number.isInteger(value) ||
    value < 1900 ||
    value > 2200
  ) {
    return undefined;
  }
  const start = Math.floor(value / 5) * 5;
  return start < 2010 ? "before-2010" : `${start}-${start + 4}`;
}

function tokenName(): string {
  const bytes = randomBytes(12);
  return (
    "[[ORBIT_PERSON_" +
    toBase64(bytes)
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_")
      .replace(/=+$/gu, "") +
    "]]"
  );
}

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return null;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Derive a conversation-specific AES-GCM key from the browser-session root
 * key. The root never leaves chrome.storage.session; only the derived key is
 * held in memory while one conversation is active. HMAC keeps derivation
 * deterministic across the Side Panel and service worker without sharing a
 * plaintext mapping or a cross-conversation encryption key.
 */
async function deriveConversationKey(
  sessionKey: Uint8Array,
  conversationId: string,
): Promise<CryptoKey> {
  const root = await webCrypto().subtle.importKey(
    "raw",
    ownedBuffer(sessionKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = new Uint8Array(
    await webCrypto().subtle.sign(
      "HMAC",
      root,
      ownedBuffer(new TextEncoder().encode(conversationId)),
    ),
  );
  return webCrypto().subtle.importKey(
    "raw",
    ownedBuffer(derived),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const PHONE_RE = /(?:\+81|0)[-\d() ]{8,}/gu;
const STUDENT_ID_RE = /\b[A-Z]{1,5}[-_ ]?\d{5,}\b/giu;
const UNKNOWN_TOKEN_RE = /\[\[ORBIT_PERSON_[A-Za-z0-9_-]{4,64}\]\]/gu;
const OPAQUE_ALIAS_TOKEN_RE = /^\[\[ORBIT_PERSON_[A-Za-z0-9_-]{16,64}\]\]$/u;
// Detect malformed/reserved tokens too.  Only UNKNOWN_TOKEN_RE values are
// eligible for restoration; every other reserved token in normal Markdown
// receives an explicit warning instead of being silently trusted.
const RESERVED_TOKEN_RE = /\[\[ORBIT_PERSON_[^\]]*\]\]/gu;
const EMAIL_DETECT_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const PHONE_DETECT_RE = /(?:\+81|0)[-\d() ]{8,}/u;
const STUDENT_ID_DETECT_RE =
  /\b(?:20\d{2,}[A-Z]{1,8}\d{5,}|[A-Z]{1,5}[-_ ]?\d{5,})\b/iu;
const DIRECT_IDENTIFIER_RE =
  /(?:@|https?:\/\/|orbit-[a-z0-9-]+:\/\/|(?:\+81|0)[-\d() ]{8,}|\b[A-Z]{1,5}[-_ ]?\d{5,}\b)/iu;
const OPAQUE_EVIDENCE_ID_RE = /^[A-Za-z0-9_-]{3,200}$/u;
const OPAQUE_ORBIT_LOCATOR_RE =
  /^orbit-[a-z0-9-]+:\/\/[A-Za-z0-9._~:/-]{1,260}$/iu;
const PRIVATE_PROJECTION_KEY_RE =
  /(?:cookie|csrf|authorization|(?:access|refresh)?[_-]?token|secret|password|api[_-]?key|credential|idnumber|objectname|resource[_-]?id|source[_-]?identifier|student[_-]?id|internal[_-]?id|raw|html|dom|inner[_-]?html|text[_-]?content|pdf(?:[_-]?(?:bytes|content|data|base64))?|full[_-]?text|ocr[_-]?(?:image|data)|page[_-]?image|blob|free[_-]?text)/iu;
const RAW_PROJECTION_VALUE_RE =
  /(?:<\s*(?:html|head|body|script|style|form|input|iframe|svg)\b|%PDF-\d|data:application\/pdf|JVBERi0[0-9A-Za-z+/=]*)/iu;
const OPAQUE_PROJECTION_LOCATOR_RE =
  /^orbit-(?:scombz|syllabus|library|browser|cast|calendar|moodle|sitrus):\/\/[A-Za-z0-9._~:/-]{1,260}$/iu;
/**
 * Closed-world keys for the personal projections that may cross the Azure
 * boundary. Unknown adapter fields are dropped even when they do not look
 * sensitive; a future raw/metadata field must not become provider-visible by
 * accident. Public syllabus projections do not use this gateway and retain
 * their separate API validator.
 */
const SAFE_TOOL_PROJECTION_KEY_RE =
  /^(?:schema_version|status|route|scope|query|year|faculty|task_count|announcement_count|related_link_count|has_current_course|courses|items|hits|results|links|coverage|section_states|observed_at|reason_code|requested|attempted|succeeded|failed|truncated|next_cursor|course_ref|display_name|academic_year|term|weekday|period|citation_uri|ref|section|title|detail|body|text|url|due_at|state|has_pdf|material_ref|material_title|page|quote|data_classification|profile_count|profiles|alias|role|company|technical_domains|job_types|location_area|graduation_year_bucket|evidence_id|topic_categories|availability_frequencies|meeting_modes|shareable_insight_categories|contact_present|discovered_link_count)$/u;

// SITRUS has a separate strict contract.  Keep its academic fields out of the
// generic projection allowlist so a similarly named field from another source
// cannot cross the provider boundary accidentally.
const SITRUS_ROOT_PROJECTION_KEYS = new Set([
  "schema_version",
  "status",
  "report_label",
  "grades",
  "credit_summaries",
  "observed_at",
  "reason_code",
]);
const SITRUS_GRADE_PROJECTION_KEYS = new Set([
  "subject",
  "credits",
  "grade",
  "outcome",
  "year",
  "term",
]);
const SITRUS_CREDIT_SUMMARY_PROJECTION_KEYS = new Set([
  "category",
  "credit_type",
  "current_course_count",
  "current_credits",
  "cumulative_course_count",
  "cumulative_credits",
]);
const SITRUS_OBSERVED_AT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u;

function sitrusProjectionKeys(path: string): ReadonlySet<string> {
  if (path === "") return SITRUS_ROOT_PROJECTION_KEYS;
  if (/^grades\[\d+\]$/u.test(path)) return SITRUS_GRADE_PROJECTION_KEYS;
  if (/^credit_summaries\[\d+\]$/u.test(path)) {
    return SITRUS_CREDIT_SUMMARY_PROJECTION_KEYS;
  }
  // No nested object is part of SitrusGradeResult.  Returning an empty set
  // makes an unexpected object fail closed while still reporting its fields.
  return new Set();
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function redactText(value: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  let text = value.replace(EMAIL_RE, () => {
    removed.push("email");
    return "[連絡先は省略]";
  });
  text = text.replace(PHONE_RE, () => {
    removed.push("phone");
    return "[連絡先は省略]";
  });
  text = text.replace(STUDENT_ID_RE, () => {
    removed.push("student_id");
    return "[識別子は省略]";
  });
  text = text.replace(/https?:\/\/[^\s)]+/giu, (match) => {
    return safeUrl(match) ?? "[URLは省略]";
  });
  return { text, removed };
}

function namesFor(person: TypedConversationPerson): string[] {
  return [person.display_name, person.name, person.romanized_name]
    .filter((value): value is string => Boolean(value && normalize(value)))
    .map(normalize)
    .filter((value, index, values) => values.indexOf(value) === index);
}

function clonePerson(person: TypedConversationPerson): TypedConversationPerson {
  return {
    ...person,
    technical_domains: person.technical_domains
      ? [...person.technical_domains]
      : undefined,
    job_types: person.job_types ? [...person.job_types] : undefined,
  };
}

export class ConversationPseudonymizationGateway {
  private readonly store: ConversationAliasStore;
  private readonly keyStore: ConversationSessionKeyStore;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private activeConversationId: string | null = null;
  private mapping: ConversationMapping | null = null;
  private key: CryptoKey | null = null;
  // Keep a copy of the session root used to derive `key`.  The root is never
  // sent to a provider; comparing it with the store on each boundary lets a
  // long-lived Side Panel notice a Service Worker restart without a new
  // cross-context protocol.
  private sessionKeyBytes: Uint8Array | null = null;
  private readonly pendingWrites = new Map<string, Set<Promise<void>>>();

  constructor(options: ConversationPseudonymizationOptions = {}) {
    this.store =
      options.store ??
      (typeof indexedDB === "undefined"
        ? new MemoryConversationAliasStore()
        : new IndexedDbConversationAliasStore());
    this.keyStore = options.keyStore ?? chromeConversationSessionKeyStore;
    // Keep the production default at 30 minutes while allowing deterministic
    // sub-minute TTLs in unit tests and explicit local policy checks.
    this.ttlMs = Math.max(1, options.ttlMs ?? CONVERSATION_ALIAS_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  async begin(conversationId: string): Promise<void> {
    if (!conversationId.trim())
      throw new TypeError("Conversation ID is empty.");
    const keyBytes = await this.syncSessionKey();
    if (this.activeConversationId === conversationId && this.mapping) {
      if (this.now() - Date.parse(this.mapping.last_used_at) > this.ttlMs) {
        await this.clear(conversationId);
      } else {
        await this.touch();
        return;
      }
    }
    this.activeConversationId = conversationId;
    const rootKey = keyBytes ?? randomBytes(32);
    if (!keyBytes) await this.keyStore.set(rootKey);
    this.sessionKeyBytes = new Uint8Array(rootKey);
    this.key = await deriveConversationKey(rootKey, conversationId);
    const encrypted = await this.store.get(conversationId);
    if (encrypted && Date.parse(encrypted.expires_at) > this.now()) {
      try {
        this.mapping = await this.decrypt(encrypted);
        return;
      } catch {
        await this.store.delete(conversationId);
      }
    }
    this.mapping = {
      schema_version: CONVERSATION_PSEUDONYMIZATION_VERSION,
      conversation_id: conversationId,
      created_at: new Date(this.now()).toISOString(),
      last_used_at: new Date(this.now()).toISOString(),
      aliases: [],
    };
    await this.persist();
  }

  async start(conversationId: string): Promise<void> {
    return this.begin(conversationId);
  }

  async clear(conversationId = this.activeConversationId): Promise<void> {
    if (conversationId === this.activeConversationId) {
      this.mapping = null;
      this.activeConversationId = null;
      this.key = null;
    }
    await this.waitForPendingWrites(conversationId);
    if (conversationId) await this.store.delete(conversationId);
  }

  async clearAll(): Promise<void> {
    this.mapping = null;
    this.activeConversationId = null;
    this.key = null;
    await this.waitForPendingWrites();
    await this.store.clear();
    this.sessionKeyBytes = null;
    await this.keyStore.clear().catch(() => undefined);
  }

  async transformText(
    conversationId: string,
    content: string,
    people: readonly TypedConversationPerson[] = [],
  ): Promise<{
    provider_content: string;
    display_content: string;
    report: ConversationTransformReport;
  }> {
    await this.ensureConversation(conversationId);
    const displayContent = content;
    const replacements = new Map<string, string>();
    // Follow-up turns may mention a person that was introduced by a previous
    // typed projection. Reuse the conversation-local mapping even when the
    // caller has no fresh `people` array; otherwise the same display name
    // could cross the provider boundary in a later question.
    for (const alias of this.mapping?.aliases ?? []) {
      for (const name of alias.display_names) {
        const normalized = normalize(name);
        if (normalized) replacements.set(normalized, alias.token);
      }
    }
    for (const person of people) {
      const displayNames = namesFor(person);
      if (displayNames.length === 0) continue;
      const alias = await this.aliasFor(displayNames);
      for (const name of displayNames) replacements.set(name, alias);
    }
    let providerContent = content;
    for (const [name, alias] of [...replacements.entries()].sort(
      (left, right) => right[0].length - left[0].length,
    )) {
      providerContent = providerContent.split(name).join(alias);
    }
    const redacted = redactText(providerContent);
    return {
      provider_content: redacted.text,
      display_content: displayContent,
      report: {
        schema_version: CONVERSATION_PSEUDONYMIZATION_VERSION,
        replaced_count: replacements.size,
        removed_fields: [...new Set(redacted.removed)].sort(),
        generalized_fields: [],
        warnings: [],
      },
    };
  }

  async transformTypedPeople(
    conversationId: string,
    people: readonly TypedConversationPerson[],
  ): Promise<{
    provider_people: PseudonymizedPersonProjection[];
    report: ConversationTransformReport;
  }> {
    await this.ensureConversation(conversationId);
    const removed = new Set<string>();
    const generalized = new Set<string>();
    const provider_people: PseudonymizedPersonProjection[] = [];
    for (const person of people) {
      const names = namesFor(person);
      if (names.length === 0) {
        removed.add("untyped_person");
        continue;
      }
      const alias = await this.aliasFor(names);
      const projected: PseudonymizedPersonProjection = {
        alias,
        role: normalize(person.role ?? "unknown").slice(0, 80),
      };
      if (person.company) {
        const company = normalize(person.company).slice(0, 160);
        if (DIRECT_IDENTIFIER_RE.test(company)) removed.add("company");
        else if (company) projected.company = company;
      }
      if (person.technical_domains?.length) {
        projected.technical_domains = person.technical_domains
          .map(normalize)
          .filter((value) => value && !DIRECT_IDENTIFIER_RE.test(value))
          .slice(0, 12);
        if (
          projected.technical_domains.length !== person.technical_domains.length
        ) {
          removed.add("technical_domains");
        }
      }
      if (person.job_types?.length) {
        projected.job_types = person.job_types
          .map(normalize)
          .filter((value) => value && !DIRECT_IDENTIFIER_RE.test(value))
          .slice(0, 12);
        if (projected.job_types.length !== person.job_types.length) {
          removed.add("job_types");
        }
      }
      if (person.location_area) {
        const location = normalize(person.location_area).slice(0, 80);
        if (DIRECT_IDENTIFIER_RE.test(location)) removed.add("location_area");
        else if (location) projected.location_area = location;
      }
      const bucket = yearBucket(person.graduation_year);
      if (bucket) {
        projected.graduation_year_bucket = bucket;
        generalized.add("graduation_year");
      }
      if (
        person.evidence_id &&
        /^[A-Za-z0-9_-]{3,160}$/u.test(person.evidence_id)
      ) {
        projected.evidence_id = person.evidence_id;
      } else if (person.evidence_id) {
        removed.add("evidence_id");
      }
      for (const field of [
        "source_identifier",
        "email",
        "phone",
        "student_id",
        "internal_id",
        "free_text",
      ]) {
        if (field in person) removed.add(field);
      }
      provider_people.push(projected);
    }
    return {
      provider_people,
      report: {
        schema_version: CONVERSATION_PSEUDONYMIZATION_VERSION,
        replaced_count: provider_people.length,
        removed_fields: [...removed].sort(),
        generalized_fields: [...generalized].sort(),
        warnings: [],
      },
    };
  }

  async transformEvidence(
    conversationId: string,
    evidence: readonly ConversationEvidenceInput[],
    people: readonly TypedConversationPerson[] = [],
  ): Promise<PseudonymizedEvidenceProjection[]> {
    await this.ensureConversation(conversationId);
    const names = new Map<string, string>();
    for (const person of people) {
      const aliases = namesFor(person);
      const alias = await this.aliasFor(aliases);
      for (const name of aliases) names.set(name, alias);
    }
    return (
      evidence
        // Evidence IDs are references, not display text.  Keep only the
        // documented opaque alphabet so an accidental URL, UUID object, or
        // provider locator cannot become a new identifier channel.
        .filter((item) => OPAQUE_EVIDENCE_ID_RE.test(item.evidence_id))
        .map((item) => {
          const title =
            item.data_classification === "public" &&
            item.source_type === "syllabus"
              ? item.title
              : [...names.entries()].reduce(
                  (value, [name, alias]) => value.split(name).join(alias),
                  item.title,
                );
          const locator = item.locator.startsWith("orbit-")
            ? OPAQUE_ORBIT_LOCATOR_RE.test(item.locator)
              ? item.locator
              : null
            : safeUrl(item.locator);
          if (!locator) return null;
          const redactedTitle = redactText(title).text;
          return {
            evidence_id: item.evidence_id,
            title: redactedTitle.slice(0, 300),
            source_type: item.source_type.slice(0, 80),
            locator,
            data_classification: item.data_classification,
          };
        })
        .filter(
          (item): item is PseudonymizedEvidenceProjection =>
            item !== null &&
            !/[?&#]/u.test(item.locator) &&
            !/(?:token|idnumber|resource|csrf)=/iu.test(item.locator),
        )
    );
  }

  /**
   * Apply the same conversation boundary to a typed Tool result immediately
   * before it is handed to the remote Agent.  Connector validators already
   * enforce each Tool's schema; this second pass is intentionally lossy so a
   * future adapter field, accidental raw HTML/PDF value, or direct identifier
   * cannot become provider-visible merely because it passed through a generic
   * result envelope.
   */
  async transformToolProjection<T>(
    conversationId: string,
    projection: T,
    toolName?: string,
  ): Promise<ToolProjectionTransformResult<T>> {
    await this.ensureConversation(conversationId);
    const removed = new Set<string>();
    const generalized = new Set<string>();
    let replacedCount = 0;
    const aliases = this.mapping?.aliases ?? [];
    const aliasSpans = aliases
      .flatMap((alias) =>
        alias.display_names.map((name) => ({
          name: normalize(name),
          token: alias.token,
        })),
      )
      .filter((item) => item.name.length > 0)
      .sort((left, right) => right.name.length - left.name.length);

    const redactProjectionText = (value: string, path: string): string => {
      // RFC3339 timestamps begin with a digit and can look like a phone
      // number to the generic text redactor.  The API contract validates this
      // field as a timestamp, so preserve the typed value exactly.
      if (
        toolName === "sitrus_read" &&
        path === "observed_at" &&
        SITRUS_OBSERVED_AT_RE.test(value)
      ) {
        return value;
      }
      if (RAW_PROJECTION_VALUE_RE.test(value)) {
        removed.add(path || "value");
        return "[内容は省略]";
      }
      let aliased = value;
      for (const span of aliasSpans) {
        if (!aliased.includes(span.name)) continue;
        aliased = aliased.split(span.name).join(span.token);
        replacedCount += 1;
      }
      const redacted = redactText(aliased);
      for (const field of redacted.removed)
        removed.add(path ? `${path}.${field}` : field);
      // Opaque citation/resource handles are safe only without query or
      // fragment data.  Public URLs are retained after query stripping by
      // redactText; malformed/private handles are represented as a marker.
      const sanitized = redacted.text.replace(
        /orbit-[a-z0-9-]+:\/\/[^\s)]+/giu,
        (match) => {
          if (!OPAQUE_PROJECTION_LOCATOR_RE.test(match)) {
            removed.add(path || "locator");
            return "[参照先は省略]";
          }
          return match;
        },
      );
      return sanitized.slice(0, 30_000);
    };

    const visit = (value: unknown, path: string, depth: number): unknown => {
      if (depth > 8) {
        removed.add(path || "value");
        return null;
      }
      if (typeof value === "string") return redactProjectionText(value, path);
      if (
        value === null ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        return value;
      }
      if (Array.isArray(value)) {
        return value
          .slice(0, 250)
          .map((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      }
      if (typeof value !== "object") {
        removed.add(path || "value");
        return null;
      }
      const output: Record<string, unknown> = {};
      const exactToolKeys =
        toolName === "sitrus_read" ? sitrusProjectionKeys(path) : null;
      for (const [key, item] of Object.entries(value).slice(0, 250)) {
        const fieldPath = path ? `${path}.${key}` : key;
        if (PRIVATE_PROJECTION_KEY_RE.test(key)) {
          removed.add(fieldPath);
          continue;
        }
        if (
          exactToolKeys
            ? !exactToolKeys.has(key)
            : !SAFE_TOOL_PROJECTION_KEY_RE.test(key)
        ) {
          removed.add(fieldPath);
          continue;
        }
        output[key] = visit(item, fieldPath, depth + 1);
      }
      return output;
    };

    const provider_result = visit(projection, "", 0) as T;
    return {
      provider_result,
      report: {
        schema_version: CONVERSATION_PSEUDONYMIZATION_VERSION,
        replaced_count: replacedCount,
        removed_fields: [...removed].sort().slice(0, 100),
        generalized_fields: [...generalized].sort(),
        warnings: [],
      },
    };
  }

  async transformTurn(input: {
    conversationId: string;
    content: string;
    people?: TypedConversationPerson[];
    evidence?: ConversationEvidenceInput[];
  }): Promise<ConversationTransformResult> {
    const text = await this.transformText(
      input.conversationId,
      input.content,
      input.people ?? [],
    );
    const typed = await this.transformTypedPeople(
      input.conversationId,
      input.people ?? [],
    );
    const evidence = await this.transformEvidence(
      input.conversationId,
      input.evidence ?? [],
      input.people ?? [],
    );
    return {
      provider: {
        provider_content: text.provider_content,
        people: typed.provider_people,
        evidence,
      },
      display: {
        display_content: text.display_content,
        people: (input.people ?? []).map(clonePerson),
      },
      report: {
        schema_version: CONVERSATION_PSEUDONYMIZATION_VERSION,
        replaced_count:
          text.report.replaced_count + typed.report.replaced_count,
        removed_fields: [
          ...new Set([
            ...text.report.removed_fields,
            ...typed.report.removed_fields,
          ]),
        ].sort(),
        generalized_fields: typed.report.generalized_fields,
        warnings: [],
      },
    };
  }

  async providerHistory(
    conversationId: string,
    history: readonly ConversationHistoryInput[],
  ): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
    const output: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const item of history.slice(-20)) {
      const transformed = await this.transformText(
        conversationId,
        item.content,
        item.people ?? [],
      );
      output.push({ role: item.role, content: transformed.provider_content });
    }
    return output;
  }

  async restoreMarkdown(
    conversationId: string,
    content: string,
  ): Promise<{ content: string; warnings: string[] }> {
    await this.ensureConversation(conversationId);
    const mapping = this.mapping;
    if (!mapping) return { content, warnings: [] };
    const protectedParts: string[] = [];
    const protect = (value: string): string => {
      const index = protectedParts.push(value) - 1;
      return `__ORBIT_PROTECTED_${index}__`;
    };
    let output = content
      .replace(
        new RegExp(
          String.fromCharCode(96).repeat(3) +
            "[\\s\\S]*?" +
            String.fromCharCode(96).repeat(3),
          "gu",
        ),
        protect,
      )
      .replace(
        new RegExp(
          String.fromCharCode(96) +
            "[^" +
            String.fromCharCode(96) +
            "]*" +
            String.fromCharCode(96),
          "gu",
        ),
        protect,
      )
      .replace(/https?:\/\/[^\s)]+/giu, protect)
      .replace(
        /orbit-(?:scombz|syllabus|library|browser|cast|calendar|moodle|sitrus):\/\/[^\s)]+/giu,
        protect,
      );
    const known = new Map<string, string>();
    for (const alias of mapping.aliases) {
      // Keep the first (display_name) spelling as the deterministic local
      // rendering. Romanized/name variants are accepted on input but must not
      // overwrite the user's preferred display form.
      if (alias.display_names[0]) {
        known.set(alias.token, alias.display_names[0]);
      }
    }
    // Inspect only the unprotected Markdown.  Tokens inside code spans,
    // fenced code, or links/locators are restored byte-for-byte and should
    // not trigger a false warning.
    const reservedTokens = [...output.matchAll(RESERVED_TOKEN_RE)].map(
      (match) => match[0],
    );
    output = output.replace(
      UNKNOWN_TOKEN_RE,
      (token) => known.get(token) ?? token,
    );
    output = output.replace(
      /__ORBIT_PROTECTED_(\d+)__/gu,
      (_match, index) => protectedParts[Number(index)] ?? "",
    );
    const warnings = reservedTokens.some((token) => !known.has(token))
      ? ["未知または変形された仮名トークンは復元しませんでした。"]
      : [];
    return { content: output, warnings };
  }

  async getAliasSnapshot(
    conversationId: string,
  ): Promise<ReadonlyArray<AliasMapping>> {
    await this.ensureConversation(conversationId);
    return this.mapping ? structuredClone(this.mapping.aliases) : [];
  }

  private async aliasFor(names: string[]): Promise<string> {
    if (!this.mapping || names.length === 0) return tokenName();
    const normalized = names.map(normalize);
    const existing = this.mapping.aliases.find((item) =>
      item.display_names.some((name) => normalized.includes(name)),
    );
    if (existing) {
      existing.display_names = [
        ...new Set([...existing.display_names, ...normalized]),
      ];
      await this.persist();
      return existing.token;
    }
    let token = tokenName();
    // A random token collision is extraordinarily unlikely, but treating it
    // as impossible would let two people restore to the wrong display name
    // under a faulty RNG/test harness.  Regenerate until this conversation's
    // namespace is unique.
    while (this.mapping.aliases.some((item) => item.token === token)) {
      token = tokenName();
    }
    this.mapping.aliases.push({ token, display_names: normalized });
    await this.persist();
    return token;
  }

  private async ensureConversation(conversationId: string): Promise<void> {
    await this.syncSessionKey();
    if (this.activeConversationId !== conversationId || !this.mapping) {
      await this.begin(conversationId);
    }
    // The Side Panel and service worker can own separate gateway instances
    // while sharing the same encrypted IndexedDB store. Refresh the active
    // mapping so aliases minted by the other extension context are available
    // for the local restore step instead of being reported as unknown.
    if (
      this.mapping &&
      this.key &&
      this.activeConversationId === conversationId
    ) {
      const encrypted = await this.store.get(conversationId).catch(() => null);
      const encryptedExpiresAt = encrypted
        ? Date.parse(encrypted.expires_at)
        : Number.NaN;
      if (encrypted && encryptedExpiresAt > this.now()) {
        try {
          const persisted = await this.decrypt(encrypted);
          const aliases = new Map<string, AliasMapping>();
          for (const alias of this.mapping.aliases)
            aliases.set(alias.token, alias);
          for (const alias of persisted.aliases) {
            const previous = aliases.get(alias.token);
            aliases.set(
              alias.token,
              previous
                ? {
                    token: alias.token,
                    display_names: [
                      ...new Set([
                        ...previous.display_names,
                        ...alias.display_names,
                      ]),
                    ],
                  }
                : alias,
            );
          }
          this.mapping = {
            ...persisted,
            created_at:
              Date.parse(persisted.created_at) <
              Date.parse(this.mapping.created_at)
                ? persisted.created_at
                : this.mapping.created_at,
            last_used_at:
              Date.parse(persisted.last_used_at) >
              Date.parse(this.mapping.last_used_at)
                ? persisted.last_used_at
                : this.mapping.last_used_at,
            aliases: [...aliases.values()],
          };
        } catch {
          // A malformed record must never leave the old in-memory aliases
          // eligible for restore or provider projection.
          await this.store.delete(conversationId).catch(() => undefined);
          await this.clear(conversationId);
          await this.begin(conversationId);
        }
      } else {
        // Deletion and expiry are both privacy boundaries.  In particular,
        // do not let the final touch() below recreate a record that another
        // extension context deliberately removed.
        await this.clear(conversationId);
        await this.begin(conversationId);
      }
    }
    if (
      this.mapping &&
      this.now() - Date.parse(this.mapping.last_used_at) > this.ttlMs
    ) {
      await this.clear(conversationId);
      await this.begin(conversationId);
    }
    await this.touch();
  }

  /**
   * Detect a session-key generation change made by another extension
   * context.  A missing key is treated as a restart: remove only the active
   * record when possible, then drop all in-memory aliases.  A changed key
   * leaves the persisted record intact so a freshly restarted context can
   * restore its new mapping; begin() will delete it only if it cannot decrypt
   * it with the new generation.
   */
  private async syncSessionKey(): Promise<Uint8Array | null> {
    const current = await this.keyStore.get();
    if (
      this.sessionKeyBytes &&
      (!current || !sameBytes(this.sessionKeyBytes, current))
    ) {
      if (!current && this.activeConversationId) {
        await this.store
          .delete(this.activeConversationId)
          .catch(() => undefined);
      }
      this.mapping = null;
      this.activeConversationId = null;
      this.key = null;
      this.sessionKeyBytes = null;
    }
    return current ? new Uint8Array(current) : null;
  }

  private async touch(): Promise<void> {
    if (!this.mapping) return;
    this.mapping.last_used_at = new Date(this.now()).toISOString();
    await this.persist();
  }

  private async persist(): Promise<void> {
    const mapping = this.mapping;
    const key = this.key;
    const sessionKeyBytes = this.sessionKeyBytes;
    const conversationId = mapping?.conversation_id;
    if (!mapping || !key || !conversationId) return;
    const write = this.persistSnapshot(
      mapping,
      key,
      sessionKeyBytes,
      conversationId,
    );
    let writes = this.pendingWrites.get(conversationId);
    if (!writes) {
      writes = new Set();
      this.pendingWrites.set(conversationId, writes);
    }
    writes.add(write);
    void write.then(
      () => this.finishPendingWrite(conversationId, write),
      () => this.finishPendingWrite(conversationId, write),
    );
    await write;
  }

  private async persistSnapshot(
    mapping: ConversationMapping,
    key: CryptoKey,
    sessionKeyBytes: Uint8Array | null,
    conversationId: string,
  ): Promise<void> {
    const currentSessionKey = await this.keyStore.get();
    if (
      !currentSessionKey ||
      !sessionKeyBytes ||
      !sameBytes(sessionKeyBytes, currentSessionKey) ||
      !this.isCurrentSnapshot(mapping, key, sessionKeyBytes, conversationId)
    ) {
      // Never encrypt stale in-memory aliases under a deleted or newer
      // session generation.  The next public operation will reinitialize the
      // conversation from the current generation.
      if (
        !currentSessionKey &&
        this.isCurrentSnapshot(mapping, key, sessionKeyBytes, conversationId)
      ) {
        await this.store
          .delete(conversationId)
          .catch(() => undefined);
        this.mapping = null;
        this.activeConversationId = null;
        this.key = null;
        this.sessionKeyBytes = null;
      }
      return;
    }
    const iv = randomBytes(12);
    const plaintext = new TextEncoder().encode(JSON.stringify(mapping));
    const ciphertext = await webCrypto().subtle.encrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(iv),
        additionalData: ownedBuffer(
          new TextEncoder().encode(conversationId),
        ),
      },
      key,
      ownedBuffer(plaintext),
    );
    const latestSessionKey = await this.keyStore.get();
    if (
      !latestSessionKey ||
      !sessionKeyBytes ||
      !sameBytes(sessionKeyBytes, latestSessionKey) ||
      !this.isCurrentSnapshot(mapping, key, sessionKeyBytes, conversationId)
    ) {
      return;
    }
    await this.store.put({
      schema_version: CONVERSATION_PSEUDONYMIZATION_VERSION,
      conversation_id: conversationId,
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(ciphertext)),
      expires_at: new Date(this.now() + this.ttlMs).toISOString(),
    });
  }

  private isCurrentSnapshot(
    mapping: ConversationMapping,
    key: CryptoKey,
    sessionKeyBytes: Uint8Array | null,
    conversationId: string,
  ): boolean {
    return (
      this.mapping === mapping &&
      this.key === key &&
      this.sessionKeyBytes === sessionKeyBytes &&
      this.activeConversationId === conversationId
    );
  }

  private finishPendingWrite(
    conversationId: string,
    write: Promise<void>,
  ): void {
    const writes = this.pendingWrites.get(conversationId);
    if (!writes) return;
    writes.delete(write);
    if (writes.size === 0) this.pendingWrites.delete(conversationId);
  }

  private async waitForPendingWrites(
    conversationId?: string | null,
  ): Promise<void> {
    const writes = conversationId
      ? [...(this.pendingWrites.get(conversationId) ?? [])]
      : [...this.pendingWrites.values()].flatMap((items) => [...items]);
    if (writes.length > 0) await Promise.allSettled(writes);
  }

  private async decrypt(
    record: EncryptedMapping,
  ): Promise<ConversationMapping> {
    if (!this.key) throw new Error("Alias key is unavailable.");
    const plaintext = await webCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(fromBase64(record.iv)),
        additionalData: ownedBuffer(
          new TextEncoder().encode(record.conversation_id),
        ),
      },
      this.key,
      ownedBuffer(fromBase64(record.ciphertext)),
    );
    const parsed = JSON.parse(
      new TextDecoder().decode(plaintext),
    ) as ConversationMapping;
    if (
      parsed.schema_version !== CONVERSATION_PSEUDONYMIZATION_VERSION ||
      parsed.conversation_id !== record.conversation_id ||
      !Array.isArray(parsed.aliases) ||
      !Number.isFinite(Date.parse(parsed.created_at)) ||
      !Number.isFinite(Date.parse(parsed.last_used_at)) ||
      parsed.aliases.some(
        (alias) =>
          !alias ||
          !OPAQUE_ALIAS_TOKEN_RE.test(alias.token) ||
          !Array.isArray(alias.display_names) ||
          alias.display_names.length === 0 ||
          alias.display_names.some(
            (name) => typeof name !== "string" || !normalize(name),
          ),
      )
    ) {
      throw new Error("Invalid conversation alias mapping.");
    }
    return parsed;
  }
}

export function isProviderSafeConversationText(value: string): boolean {
  return (
    !EMAIL_DETECT_RE.test(value) &&
    !PHONE_DETECT_RE.test(value) &&
    !STUDENT_ID_DETECT_RE.test(value) &&
    !/(?:access[_-]?token|cookie|csrf|authorization|refresh[_-]?token)/iu.test(
      value,
    ) &&
    !/[?&](?:token|access_token|refresh_token|csrf|session|idnumber|resource(?:_id|id)?|objectname|key)=/iu.test(
      value,
    )
  );
}
