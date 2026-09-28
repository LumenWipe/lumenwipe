import { createHash, randomBytes } from "crypto";
import { Firestore, Timestamp } from "@google-cloud/firestore";

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
}

/**
 * Issues, resolves, lists, and revokes/rotates self-serve API keys. The raw secret is never
 * persisted - only `hashApiKey(raw)` is - and `create`/`rotate` are the only operations that
 * ever see the raw value, returning it exactly once to the caller.
 */
export interface ApiKeyStore {
  create(
    owner: string,
    rateLimit?: RateLimitOverride | null
  ): Promise<{ raw: string; record: ApiKeyRecord }>;
  /** Null for an unknown OR revoked key - callers don't need to tell the two apart. */
  resolve(rawKey: string): Promise<ApiKeyRecord | null>;
  listByOwner(owner: string): Promise<ApiKeyRecord[]>;
  /** False if no key with that hash exists. */
  revoke(hash: string): Promise<boolean>;
  /** Null if no *active* key with that hash exists (unknown, or already revoked). */
  rotate(hash: string): Promise<{ raw: string; record: ApiKeyRecord } | null>;
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

function toFirestoreData(record: Omit<ApiKeyRecord, "hash">): FirebaseFirestore.DocumentData {
  return {
    owner: record.owner,
    createdAt: Timestamp.fromDate(record.createdAt),
    revokedAt: record.revokedAt ? Timestamp.fromDate(record.revokedAt) : null,
    rotatedFrom: record.rotatedFrom,
    rateLimit: record.rateLimit,
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

  constructor(firestore: Firestore, collectionName = "apiKeys") {
    this.collection = firestore.collection(collectionName);
  }

  async create(
    owner: string,
    rateLimit: RateLimitOverride | null = null
  ): Promise<{ raw: string; record: ApiKeyRecord }> {
    const raw = generateApiKey();
    const hash = hashApiKey(raw);
    const record: ApiKeyRecord = {
      hash,
      owner,
      createdAt: new Date(),
      revokedAt: null,
      rotatedFrom: null,
      rateLimit,
    };
    await this.collection.doc(hash).set(toFirestoreData(record));
    return { raw, record };
  }

  async resolve(rawKey: string): Promise<ApiKeyRecord | null> {
    const snap = await this.collection.doc(hashApiKey(rawKey)).get();
    if (!snap.exists) return null;
    const record = fromFirestoreData(snap.id, snap.data()!);
    return record.revokedAt ? null : record;
  }

  async listByOwner(owner: string): Promise<ApiKeyRecord[]> {
    const snap = await this.collection.where("owner", "==", owner).get();
    return snap.docs.map((d) => fromFirestoreData(d.id, d.data()));
  }

  async revoke(hash: string): Promise<boolean> {
    const ref = this.collection.doc(hash);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await ref.update({ revokedAt: Timestamp.now() });
    return true;
  }

  async rotate(hash: string): Promise<{ raw: string; record: ApiKeyRecord } | null> {
    const ref = this.collection.doc(hash);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const old = fromFirestoreData(snap.id, snap.data()!);
    if (old.revokedAt) return null;

    // New key first, then revoke the old one: a crash between the two steps leaves both keys
    // active (recoverable - just call revoke again) rather than leaving the caller with zero
    // working keys.
    const created = await this.create(old.owner, old.rateLimit);
    await this.collection.doc(created.record.hash).update({ rotatedFrom: hash });
    await ref.update({ revokedAt: Timestamp.now() });
    return { raw: created.raw, record: { ...created.record, rotatedFrom: hash } };
  }
}

/** In-process test double - every unit/e2e test uses this, never live Firestore. */
export class InMemoryApiKeyStore implements ApiKeyStore {
  private readonly records = new Map<string, ApiKeyRecord>();

  async create(
    owner: string,
    rateLimit: RateLimitOverride | null = null
  ): Promise<{ raw: string; record: ApiKeyRecord }> {
    const raw = generateApiKey();
    const hash = hashApiKey(raw);
    const record: ApiKeyRecord = {
      hash,
      owner,
      createdAt: new Date(),
      revokedAt: null,
      rotatedFrom: null,
      rateLimit,
    };
    this.records.set(hash, record);
    return { raw, record };
  }

  async resolve(rawKey: string): Promise<ApiKeyRecord | null> {
    const record = this.records.get(hashApiKey(rawKey));
    return record && !record.revokedAt ? record : null;
  }

  async listByOwner(owner: string): Promise<ApiKeyRecord[]> {
    return [...this.records.values()].filter((r) => r.owner === owner);
  }

  async revoke(hash: string): Promise<boolean> {
    const record = this.records.get(hash);
    if (!record) return false;
    record.revokedAt = new Date();
    return true;
  }

  async rotate(hash: string): Promise<{ raw: string; record: ApiKeyRecord } | null> {
    const old = this.records.get(hash);
    if (!old || old.revokedAt) return null;
    const created = await this.create(old.owner, old.rateLimit);
    created.record.rotatedFrom = hash;
    old.revokedAt = new Date();
    return created;
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
