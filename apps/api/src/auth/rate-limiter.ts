import { createHash } from "crypto";
import { Injectable, Logger } from "@nestjs/common";
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from "@nestjs/throttler";
import type { NextFunction, Request, RequestHandler, Response } from "express";
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

const THROTTLER_NAME = "default";

/** Never counted: the service index, the health checks and the Swagger UI, as before. */
export function isUnthrottledPath(path: string): boolean {
  return (
    path === "/" ||
    path === "/health" ||
    path === "/health/deep" ||
    path === "/docs-json" ||
    path === "/docs" ||
    path.startsWith("/docs/")
  );
}

export interface RateLimitDecision {
  limit: number;
  remaining: number;
  resetSeconds: number;
  blocked: boolean;
  retryAfterSeconds: number;
}

/**
 * One budget per API key (per IP when there is no key) across every route, counted in the
 * throttler's own storage so the numbers are the ones the limiter already used.
 *
 * It runs as the first Express middleware (see `configureApp`), ahead of body parsing, routing
 * and `ApiKeyGuard`, so every response, including a 404 or a body error, is counted and carries
 * the budget headers, and a request without a valid key is still throttled before it is
 * authenticated (#59).
 *
 * A self-serve key can carry its own `rateLimit` override (issue #289), resolved through the
 * cached `ApiKeyDirectory`; a resolution failure fails open to the global default. The block
 * duration is deliberately left at the global window for override keys: the storage releases a
 * blocked key and resets its count when that block ends, so `Retry-After` is exactly the time
 * until the key is served again.
 */
@Injectable()
export class RateLimiter {
  private readonly logger = new Logger("rate-limit");

  constructor(
    @InjectThrottlerOptions() private readonly options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() private readonly storage: ThrottlerStorage,
    private readonly apiKeys: ApiKeyDirectory
  ) {}

  private defaults(): { limit: number; ttl: number } {
    const list = Array.isArray(this.options) ? this.options : this.options.throttlers;
    const first = list[0];
    if (!first || typeof first.limit !== "number" || typeof first.ttl !== "number") {
      throw new Error("The rate limiter needs a numeric default limit and ttl.");
    }
    return { limit: first.limit, ttl: first.ttl };
  }

  async consume(req: Record<string, unknown>): Promise<RateLimitDecision> {
    const tracker = trackerForRequest(req);
    const resolved = await this.apiKeys.resolve(tracker).catch(() => null);
    const defaults = this.defaults();
    const limit = resolved?.rateLimit?.limit ?? defaults.limit;
    const ttl = resolved?.rateLimit?.ttlMs ?? defaults.ttl;
    const { totalHits, timeToExpire, isBlocked, timeToBlockExpire } = await this.storage.increment(
      throttleStorageKey(THROTTLER_NAME, tracker),
      ttl,
      limit,
      defaults.ttl,
      THROTTLER_NAME
    );
    return {
      limit,
      remaining: isBlocked ? 0 : Math.max(0, limit - totalHits),
      resetSeconds: isBlocked ? timeToBlockExpire : timeToExpire,
      blocked: isBlocked,
      retryAfterSeconds: timeToBlockExpire,
    };
  }

  middleware(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (isUnthrottledPath(req.path)) {
        next();
        return;
      }
      this.consume(req as unknown as Record<string, unknown>).then(
        (decision) => {
          setRateLimitHeaders(res, decision);
          if (decision.blocked) {
            res.setHeader("Retry-After", String(decision.retryAfterSeconds));
            res.status(429).json({
              error: { code: "rate_limited", message: "ThrottlerException: Too Many Requests" },
            });
            return;
          }
          next();
        },
        (error: unknown) => {
          this.logger.error(
            "Rate limiter failed",
            error instanceof Error ? error.stack : String(error)
          );
          res.status(500).json({
            error: { code: "internal_error", message: "Something went wrong. Please try again." },
          });
        }
      );
    };
  }
}

function setRateLimitHeaders(res: Response, decision: RateLimitDecision): void {
  const values: [string, number][] = [
    ["Limit", decision.limit],
    ["Remaining", decision.remaining],
    ["Reset", decision.resetSeconds],
  ];
  for (const [name, value] of values) {
    res.setHeader(`RateLimit-${name}`, String(value));
    // Deprecated: the pre-standard names, emitted for one release alongside RateLimit-*.
    res.setHeader(`X-RateLimit-${name}`, String(value));
  }
}
