import { ApiKeyService } from "./api-key.service";
import {
  hashApiKey,
  isApiKeyFormat,
  type ApiKeyStore,
  type RateLimitOverride,
} from "./api-key-store";

export interface ResolvedApiKey {
  /** Integrator identity - used for `req.apiKeyLabel` (metering), unchanged shape from today. */
  label: string;
  /** Absent (null) means the global default rate limit applies. */
  rateLimit: RateLimitOverride | null;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
export const DEFAULT_NEGATIVE_CACHE_MAX_ENTRIES = 10_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Resolves a raw API key to its integrator identity, trying the manually-provisioned static
 * map first (`ApiKeyService`, zero I/O) before falling back to the self-serve `ApiKeyStore`.
 * Shared by both `ApiKeyGuard` and `RateLimiter` - and cached - so a self-serve key
 * costs at most one store read per cache window, not one per request (the throttler resolves
 * independently of the guard, since it deliberately runs first: see `app.module.ts`).
 *
 * Constructed with plain arguments (see `auth.module.ts`'s `useFactory`) rather than relying on
 * Nest's reflection-based constructor injection for `cacheTtlMs`, which has no injection token -
 * this also keeps it constructible directly in tests, matching this codebase's existing
 * DI-for-testability convention.
 *
 * Revoke/rotate call `invalidate(hash)` (the admin controller) so the instance that served the
 * admin request enforces it on its very next lookup. This cache is per-process - a Cloud
 * Run deployment with more than one instance can still serve a revoked key from another
 * instance's cache for up to `cacheTtlMs`. Tightening that to zero would mean a Firestore read
 * on every single request; documented here as the deliberate tradeoff, not a silent gap.
 *
 * A value without the generated key shape (`isApiKeyFormat`) is unknown without a store read.
 * Unknown keys are cached for the same window in a separate map holding at most
 * `negativeCacheMaxEntries` entries, oldest dropped first, so it cannot crowd out known keys.
 * Every entry shares one lifetime, so insertion order is expiry order.
 */
export class ApiKeyDirectory {
  private readonly known = new Map<string, CacheEntry<ResolvedApiKey>>();
  private readonly unknown = new Map<string, CacheEntry<null>>();

  constructor(
    private readonly staticKeys: ApiKeyService,
    private readonly store: ApiKeyStore,
    private readonly cacheTtlMs: number = DEFAULT_CACHE_TTL_MS,
    private readonly negativeCacheMaxEntries: number = DEFAULT_NEGATIVE_CACHE_MAX_ENTRIES
  ) {}

  /**
   * What is known about `rawKey` without any I/O: the resolution for a static or cached key,
   * `null` for a value that cannot be a key or is cached as unknown, and `undefined` when only
   * a store read can tell.
   */
  peek(rawKey: string): ResolvedApiKey | null | undefined {
    const staticLabel = this.staticKeys.resolve(rawKey);
    if (staticLabel) return { label: staticLabel, rateLimit: null };
    if (!isApiKeyFormat(rawKey)) return null;

    const cacheKey = hashApiKey(rawKey);
    const now = Date.now();
    const known = this.known.get(cacheKey);
    if (known) {
      if (known.expiresAt > now) return known.value;
      this.known.delete(cacheKey);
    }
    const unknown = this.unknown.get(cacheKey);
    if (unknown) {
      if (unknown.expiresAt > now) return null;
      this.unknown.delete(cacheKey);
    }
    return undefined;
  }

  async resolve(rawKey: string): Promise<ResolvedApiKey | null> {
    const peeked = this.peek(rawKey);
    if (peeked !== undefined) return peeked;

    const record = await this.store.resolve(rawKey);
    const cacheKey = hashApiKey(rawKey);
    const expiresAt = Date.now() + this.cacheTtlMs;
    if (record) {
      const resolved = { label: record.owner, rateLimit: record.rateLimit };
      this.known.set(cacheKey, { value: resolved, expiresAt });
      return resolved;
    }
    this.rememberUnknown(cacheKey, expiresAt);
    return null;
  }

  /** Drops a cached resolution by key hash - called on revoke/rotate so the serving instance
   *  enforces it immediately rather than waiting out the cache TTL. A no-op for a static key
   *  (never cached) or an id nothing had looked up yet. */
  invalidate(hash: string): void {
    this.known.delete(hash);
    this.unknown.delete(hash);
  }

  /** Entries currently held for unknown keys, expired or not. */
  get negativeCacheSize(): number {
    return this.unknown.size;
  }

  private rememberUnknown(cacheKey: string, expiresAt: number): void {
    this.unknown.delete(cacheKey);
    const now = Date.now();
    for (const [key, entry] of this.unknown) {
      if (entry.expiresAt > now && this.unknown.size < this.negativeCacheMaxEntries) break;
      this.unknown.delete(key);
    }
    if (this.negativeCacheMaxEntries > 0) this.unknown.set(cacheKey, { value: null, expiresAt });
  }
}
