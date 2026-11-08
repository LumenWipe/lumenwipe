import { createHash, randomBytes } from "crypto";
import { Firestore, Timestamp } from "@google-cloud/firestore";
import { fail } from "@/common/fail";
import { isValidNetwork, type Network } from "@/config/networks";
import { withTimeout } from "@/lib/utils/with-timeout";

const STORE_TIMEOUT_MS = 5_000;
const STORE_TIMEOUT_MESSAGE = "api key store timed out";

/** Per-key rate limit override; absent means the global default (`app.module.ts`) applies. */
export interface RateLimitOverride {
  limit: number;
  ttlMs: number;
}

/**
 * A self-serve API key's persisted record. `hash` is also the record's identity (see
 * `hashApiKey`) - there is no separate id, so a lookup by key is a single indexed read rather
 * than a query.
 */
export interface ApiKeyRecord {
  hash: string;
  owner: string;
  createdAt: Date;
  revokedAt: Date | null;
  rotatedFrom: string | null;
  rateLimit: RateLimitOverride | null;
  label: string | null;
  /** Null means every network: the behavior of every key created before scopes existed. */
  networks: Network[] | null;
  /** Written in batches (see `KeyActivityService`), so it trails real use by up to a minute. */
  lastUsedAt: Date | null;
}

/** What the issuer chooses for a new key; anything left out keeps the pre-existing behavior. */
export interface NewApiKeyOptions {
  rateLimit?: RateLimitOverride | null;
  label?: string | null;
  networks?: Network[] | null;
}

/**
 * Issues, resolves, lists, and revokes/rotates self-serve API keys. The raw secret is never
 * persisted - only `hashApiKey(raw)` is - and `create`/`rotate` are the only operations that
 * ever see the raw value, returning it exactly once to the caller.
 */
export interface ApiKeyStore {
  create(owner: string, options?: NewApiKeyOptions): Promise<{ raw: string; record: ApiKeyRecord }>;
  /** Null for an unknown OR revoked key - callers don't need to tell the two apart. */
  resolve(rawKey: string): Promise<ApiKeyRecord | null>;
  listByOwner(owner: string): Promise<ApiKeyRecord[]>;
  /** The record for a hash whether active or revoked, or null if none exists. */
  findByHash(hash: string): Promise<ApiKeyRecord | null>;
  /** False if no key with that hash exists. Revoking an already revoked key is a no-op that
   *  keeps the original `revokedAt` and still returns true. */
  revoke(hash: string): Promise<boolean>;
  /** Null if no *active* key with that hash exists (unknown, or already revoked). */
  rotate(hash: string): Promise<{ raw: string; record: ApiKeyRecord } | null>;
  /** Sets `lastUsedAt` on keys that exist; never creates a record. */
  recordLastUsed(entries: ReadonlyMap<string, Date>): Promise<void>;
}

/** Injection token for `ApiKeyStore` - it's an interface, so a class token doesn't exist. */
export const API_KEY_STORE = Symbol("API_KEY_STORE");

/** SHA-256 is deliberate, not bcrypt/argon2: the secret is already high-entropy (see
 *  `generateApiKey`), so a fast hash costs nothing in brute-force resistance while keeping
 *  every auth-path lookup cheap - the same tradeoff GitHub and Stripe make for API tokens,
 *  as opposed to low-entropy user passwords. */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/** `lw_` + 32 random bytes, base64url - ~43 chars, prefixed so a key is recognizable at a
 *  glance (in logs, in a dashboard) without ever needing to store or display the raw value. */
export function generateApiKey(): string {
  return `lw_${randomBytes(32).toString("base64url")}`;
}

const API_KEY_FORMAT = /^lw_[A-Za-z0-9_-]{43}$/;
const KEY_ID_FORMAT = /^[0-9a-f]{64}$/;

/** True when `id` has the shape `hashApiKey` produces, so it is safe as a storage field name. */
export function isKeyId(id: string): boolean {
  return KEY_ID_FORMAT.test(id);
}

/** True when `raw` has the exact shape `generateApiKey` produces. */
export function isApiKeyFormat(raw: string): boolean {
  return API_KEY_FORMAT.test(raw);
}

function copyRecord(record: ApiKeyRecord): ApiKeyRecord {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    revokedAt: record.revokedAt ? new Date(record.revokedAt) : null,
    rateLimit: record.rateLimit ? { ...record.rateLimit } : null,
    networks: record.networks ? [...record.networks] : null,
    lastUsedAt: record.lastUsedAt ? new Date(record.lastUsedAt) : null,
  };
}

function newRecord(
  raw: string,
  owner: string,
  options: NewApiKeyOptions,
  rotatedFrom: string | null
): ApiKeyRecord {
  return {
    hash: hashApiKey(raw),
    owner,
    createdAt: new Date(),
    revokedAt: null,
    rotatedFrom,
    rateLimit: options.rateLimit ? { ...options.rateLimit } : null,
    label: options.label ?? null,
    networks: options.networks ? [...options.networks] : null,
    lastUsedAt: null,
  };
}

function inheritedOptions(old: ApiKeyRecord): NewApiKeyOptions {
  return { rateLimit: old.rateLimit, label: old.label, networks: old.networks };
}

const FIRESTORE_BATCH_LIMIT = 500;

function rethrowUnavailable(error: unknown): never {
  if (error instanceof Error && error.message === STORE_TIMEOUT_MESSAGE) {
    fail("service_unavailable", "Key service is busy. Please try again shortly.", 503);
  }
  throw error;
}

function toFirestoreData(record: Omit<ApiKeyRecord, "hash">): FirebaseFirestore.DocumentData {
  return {
    owner: record.owner,
    createdAt: Timestamp.fromDate(record.createdAt),
    revokedAt: record.revokedAt ? Timestamp.fromDate(record.revokedAt) : null,
    rotatedFrom: record.rotatedFrom,
    rateLimit: record.rateLimit,
    label: record.label,
    networks: record.networks,
    lastUsedAt: record.lastUsedAt ? Timestamp.fromDate(record.lastUsedAt) : null,
  };
}

function fromFirestoreData(hash: string, data: FirebaseFirestore.DocumentData): ApiKeyRecord {
  return {
    hash,
    owner: data.owner as string,
    createdAt: (data.createdAt as Timestamp).toDate(),
    revokedAt: data.revokedAt ? (data.revokedAt as Timestamp).toDate() : null,
    rotatedFrom: (data.rotatedFrom as string | null) ?? null,
    rateLimit: (data.rateLimit as RateLimitOverride | null) ?? null,
    label: typeof data.label === "string" ? data.label : null,
    networks: Array.isArray(data.networks)
      ? (data.networks as unknown[]).filter(
          (n): n is Network => typeof n === "string" && isValidNetwork(n)
        )
      : null,
    lastUsedAt: data.lastUsedAt ? (data.lastUsedAt as Timestamp).toDate() : null,
  };
}

/**
 * Firestore-backed store (Native mode), one document per key keyed by its own hash. Constructed
 * with no explicit credentials: on Cloud Run the service account's IAM role authorizes access
 * (Application Default Credentials) - this feature introduces no new bearer secret to leak or
 * rotate. Never constructed unless `FIRESTORE_PROJECT_ID` is set (see `createApiKeyStore`), so
 * an environment that hasn't configured it never touches Firestore at all.
 */
export class FirestoreApiKeyStore implements ApiKeyStore {
  private readonly collection: FirebaseFirestore.CollectionReference;

  constructor(
    private readonly firestore: Firestore,
    collectionName = "apiKeys",
    private readonly timeoutMs = STORE_TIMEOUT_MS
  ) {
    this.collection = firestore.collection(collectionName);
  }

  private bounded<T>(operation: () => Promise<T>): Promise<T> {
    return withTimeout(operation(), this.timeoutMs, STORE_TIMEOUT_MESSAGE).catch(
      rethrowUnavailable
    );
  }

  async create(
    owner: string,
    options: NewApiKeyOptions = {}
  ): Promise<{ raw: string; record: ApiKeyRecord }> {
    const raw = generateApiKey();
    const record = newRecord(raw, owner, options, null);
    await this.bounded(() => this.collection.doc(record.hash).create(toFirestoreData(record)));
    return { raw, record };
  }

  async resolve(rawKey: string): Promise<ApiKeyRecord | null> {
    const record = await this.findByHash(hashApiKey(rawKey));
    return record && !record.revokedAt ? record : null;
  }

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    const snap = await this.bounded(() => this.collection.doc(hash).get());
    return snap.exists ? fromFirestoreData(snap.id, snap.data()!) : null;
  }

  async listByOwner(owner: string): Promise<ApiKeyRecord[]> {
    const snap = await this.bounded(() => this.collection.where("owner", "==", owner).get());
    return snap.docs.map((d) => fromFirestoreData(d.id, d.data()));
  }

  async revoke(hash: string): Promise<boolean> {
    const ref = this.collection.doc(hash);
    return this.bounded(() =>
      this.firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return false;
        if (!snap.data()!.revokedAt) tx.update(ref, { revokedAt: Timestamp.now() });
        return true;
      })
    );
  }

  async rotate(hash: string): Promise<{ raw: string; record: ApiKeyRecord } | null> {
    const ref = this.collection.doc(hash);
    // Minted once, outside the callback: Firestore re-runs it on contention, and a retry must
    // not hand the caller a raw key that differs from the document it committed.
    const raw = generateApiKey();
    return this.bounded(() =>
      this.firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return null;
        const old = fromFirestoreData(snap.id, snap.data()!);
        if (old.revokedAt) return null;

        const record = newRecord(raw, old.owner, inheritedOptions(old), hash);
        tx.create(this.collection.doc(record.hash), toFirestoreData(record));
        tx.update(ref, { revokedAt: Timestamp.now() });
        return { raw, record };
      })
    );
  }

  async recordLastUsed(entries: ReadonlyMap<string, Date>): Promise<void> {
    const all = [...entries];
    for (let i = 0; i < all.length; i += FIRESTORE_BATCH_LIMIT) {
      const batch = this.firestore.batch();
      for (const [hash, at] of all.slice(i, i + FIRESTORE_BATCH_LIMIT)) {
        batch.update(this.collection.doc(hash), { lastUsedAt: Timestamp.fromDate(at) });
      }
      await this.bounded(() => batch.commit());
    }
  }
}

/** In-process test double - every unit/e2e test uses this, never live Firestore. Every check and
 *  its write share one synchronous section, and records leave as copies, so neither concurrency
 *  nor a caller's mutation can diverge from Firestore's behavior. */
export class InMemoryApiKeyStore implements ApiKeyStore {
  private readonly records = new Map<string, ApiKeyRecord>();

  private issue(
    owner: string,
    options: NewApiKeyOptions,
    rotatedFrom: string | null
  ): { raw: string; record: ApiKeyRecord } {
    const raw = generateApiKey();
    const record = newRecord(raw, owner, options, rotatedFrom);
    this.records.set(record.hash, record);
    return { raw, record: copyRecord(record) };
  }

  async create(
    owner: string,
    options: NewApiKeyOptions = {}
  ): Promise<{ raw: string; record: ApiKeyRecord }> {
    return this.issue(owner, options, null);
  }

  async resolve(rawKey: string): Promise<ApiKeyRecord | null> {
    const record = this.records.get(hashApiKey(rawKey));
    return record && !record.revokedAt ? copyRecord(record) : null;
  }

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    const record = this.records.get(hash);
    return record ? copyRecord(record) : null;
  }

  async listByOwner(owner: string): Promise<ApiKeyRecord[]> {
    return [...this.records.values()].filter((r) => r.owner === owner).map(copyRecord);
  }

  async revoke(hash: string): Promise<boolean> {
    const record = this.records.get(hash);
    if (!record) return false;
    record.revokedAt ??= new Date();
    return true;
  }

  async rotate(hash: string): Promise<{ raw: string; record: ApiKeyRecord } | null> {
    const old = this.records.get(hash);
    if (!old || old.revokedAt) return null;
    old.revokedAt = new Date();
    return this.issue(old.owner, inheritedOptions(old), hash);
  }

  async recordLastUsed(entries: ReadonlyMap<string, Date>): Promise<void> {
    for (const [hash, at] of entries) {
      const record = this.records.get(hash);
      if (record) record.lastUsedAt = new Date(at);
    }
  }
}

/**
 * Selects the backing store: Firestore when `FIRESTORE_PROJECT_ID` is configured, else an
 * in-memory fallback. The env var gates real client construction entirely (not just its use),
 * so dev/test/CI - which never set it - never instantiate a `Firestore` client and never risk
 * an environment-detection network call.
 */
export function createApiKeyStore(): ApiKeyStore {
  const projectId = process.env.FIRESTORE_PROJECT_ID;
  if (!projectId) return new InMemoryApiKeyStore();
  return new FirestoreApiKeyStore(new Firestore({ projectId }));
}
