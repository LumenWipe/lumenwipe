import { ApiKeyService } from "./api-key.service";
import { hashApiKey, type ApiKeyStore, type RateLimitOverride } from "./api-key-store";

export interface ResolvedApiKey {
  /** Integrator identity - used for `req.apiKeyLabel` (metering), unchanged shape from today. */
  label: string;
  /** Absent (null) means the global default rate limit applies. */
  rateLimit: RateLimitOverride | null;
}

const DEFAULT_CACHE_TTL_MS = 60_000;

/**
 * Resolves a raw API key to its integrator identity, trying the manually-provisioned static
 * map first (`ApiKeyService`, zero I/O) before falling back to the self-serve `ApiKeyStore`.
 * Shared by both `ApiKeyGuard` and `ApiKeyThrottlerGuard` - and cached - so a self-serve key
 * costs at most one store read per cache window, not one per request (the throttler resolves
 * independently of the guard, since it deliberately runs first: see `app.module.ts`).
 *
 * Constructed with plain arguments (see `auth.module.ts`'s `useFactory`) rather than relying on
 * Nest's reflection-based constructor injection for `cacheTtlMs`, which has no injection token -
 * this also keeps it constructible directly in tests, matching this codebase's existing
 * DI-for-testability convention.
 *
 * Revoke/rotate call `invalidate(hash)` (the admin controller) so the instance that served the
 * admin request enforces it on its very next lookup. This cache is per-process, like every other
 * piece of state in this API (`MeteringService`'s own docstring makes the same call) - a Cloud
 * Run deployment with more than one instance can still serve a revoked key from another
 * instance's cache for up to `cacheTtlMs`. Tightening that to zero would mean a Firestore read
 * on every single request; documented here as the deliberate tradeoff, not a silent gap.
 */
export class ApiKeyDirectory {
  private readonly cache = new Map<string, { value: ResolvedApiKey | null; expiresAt: number }>();

  constructor(
    private readonly staticKeys: ApiKeyService,
    private readonly store: ApiKeyStore,
    private readonly cacheTtlMs: number = DEFAULT_CACHE_TTL_MS
  ) {}

  async resolve(rawKey: string): Promise<ResolvedApiKey | null> {
    const staticLabel = this.staticKeys.resolve(rawKey);
    if (staticLabel) return { label: staticLabel, rateLimit: null };

    const cacheKey = hashApiKey(rawKey);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const record = await this.store.resolve(rawKey);
    const resolved: ResolvedApiKey | null = record
      ? { label: record.owner, rateLimit: record.rateLimit }
      : null;
    this.cache.set(cacheKey, { value: resolved, expiresAt: Date.now() + this.cacheTtlMs });
    return resolved;
  }

  /** Drops a cached resolution by key hash - called on revoke/rotate so the serving instance
   *  enforces it immediately rather than waiting out the cache TTL. A no-op for a static key
   *  (never cached) or an id nothing had looked up yet. */
  invalidate(hash: string): void {
    this.cache.delete(hash);
  }
}
