import { createHash } from "crypto";
import { ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from "@nestjs/throttler";
import { ApiKeyDirectory } from "./api-key-directory";

/**
 * Rate-limit tracker: the API key when present, else the client IP (for public
 * routes that carry no key). Pure and exported so it can be unit-tested without
 * standing up the throttler's injected dependencies.
 */
export function trackerForRequest(req: Record<string, unknown>): string {
  const headers = (req.headers ?? {}) as Record<string, string | undefined>;
  const auth = headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  return (req as { ip?: string }).ip ?? "unknown";
}

/** Storage key for a limiter `name` + `tracker`, hashed so the raw key never lands in storage/logs. */
export function throttleStorageKey(name: string, tracker: string): string {
  return createHash("sha256").update(`${name}:${tracker}`).digest("hex");
}

/**
 * Rate-limits per API key rather than per IP, and applies one budget per key
 * across ALL endpoints (the default `generateKey` mixes in the controller and
 * handler, which would multiply the limit by the number of routes).
 *
 * A self-serve key can carry its own `rateLimit` override (issue #289); `handleRequest` is
 * `@nestjs/throttler`'s own extension point for this - it receives the resolved `limit`/`ttl`
 * before the storage check runs, so overriding them here for a key with a configured override
 * (falling through to the global default for every other key, unchanged) is a small, surgical
 * change rather than a rewrite of the guard.
 *
 * This guard runs BEFORE `ApiKeyGuard` (see `app.module.ts` - rate-limit invalid keys too), so
 * it resolves the tracker itself via the same cached `ApiKeyDirectory` rather than reading
 * `req.apiKeyLabel`, which isn't set yet. The shared cache means this costs no Firestore reads
 * beyond what `ApiKeyGuard` already triggers for the same key. A resolution failure (e.g. a
 * transient store error) fails open to the global default rather than blocking the request.
 */
@Injectable()
export class ApiKeyThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly apiKeys: ApiKeyDirectory
  ) {
    super(options, storageService, reflector);
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    return trackerForRequest(req);
  }

  protected generateKey(_context: ExecutionContext, suffix: string, name: string): string {
    return throttleStorageKey(name, suffix);
  }

  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const { req } = this.getRequestResponse(requestProps.context);
    const tracker = trackerForRequest(req as Record<string, unknown>);
    const resolved = await this.apiKeys.resolve(tracker).catch(() => null);
    if (resolved?.rateLimit) {
      return super.handleRequest({
        ...requestProps,
        limit: resolved.rateLimit.limit,
        ttl: resolved.rateLimit.ttlMs,
      });
    }
    return super.handleRequest(requestProps);
  }
}
