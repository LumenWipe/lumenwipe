import { createHash } from "crypto";
import { isIPv6 } from "net";
import { Injectable, Logger } from "@nestjs/common";
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from "@nestjs/throttler";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ApiKeyDirectory, type ResolvedApiKey } from "./api-key-directory";

/** The bearer value of the `Authorization` header, or null when there is none. */
export function bearerFromRequest(req: Record<string, unknown>): string | null {
  const headers = (req.headers ?? {}) as Record<string, string | undefined>;
  const auth = headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const value = auth.slice("Bearer ".length).trim();
  return value === "" ? null : value;
}

/**
 * The client address as a rate-limit identity: an IPv4-mapped IPv6 address becomes plain IPv4,
 * and any other IPv6 address is reduced to its /64, the block a single client usually holds.
 */
export function clientIdentity(ip: string | undefined): string {
  if (!ip) return "unknown";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (isIPv6(ip)) return `${expandIPv6(ip).slice(0, 4).join(":")}::/64`;
  return ip;
}

function expandIPv6(ip: string): string[] {
  const [head = "", tail = ""] = ip.split("%")[0]!.split("::");
  const left = head ? head.split(":") : [];
  const right = ip.includes("::") && tail ? tail.split(":") : [];
  if (!ip.includes("::")) return left.map((h) => h.toLowerCase());
  const fill: string[] = Array.from({ length: 8 - left.length - right.length }, () => "0");
  return [...left, ...fill, ...right].map((h) => h.toLowerCase());
}

/** Tracker for a request counted against its client rather than a key. */
export function ipTracker(req: Record<string, unknown>): string {
  return `ip:${clientIdentity((req as { ip?: string }).ip)}`;
}

function lookupTracker(req: Record<string, unknown>): string {
  return `lookup:${clientIdentity((req as { ip?: string }).ip)}`;
}

function keyTracker(rawKey: string): string {
  return `key:${rawKey}`;
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
 * One budget per known API key across every route, and one per client IP for everything else:
 * no key, a value that is not a key, or a key that does not resolve. Counted in the throttler's
 * own storage so the numbers are the ones the limiter already used.
 *
 * It runs as the first Express middleware (see `configureApp`), ahead of body parsing, routing
 * and `ApiKeyGuard`, so every response, including a 404 or a body error, is counted and carries
 * the budget headers, and a request without a valid key is still throttled before it is
 * authenticated (#59).
 *
 * A bearer that only the key store can answer for is looked up under a separate per-client
 * lookup budget, so the store is read at most that many times per client per window whatever
 * the bearer values, and a known key is still found while its client's request budget is spent.
 * A key that resolves is counted against the key alone; one that does not, against the client.
 * An IPv6 client is one /64.
 *
 * A self-serve key can carry its own `rateLimit` override (issue #289), resolved through the
 * cached `ApiKeyDirectory`; a resolution failure leaves the request on its client budget. The block
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
    const bearer = bearerFromRequest(req);
    if (bearer !== null) {
      const peeked = this.apiKeys.peek(bearer);
      if (peeked) return this.count(keyTracker(bearer), peeked);
      if (peeked === undefined && !(await this.count(lookupTracker(req), null)).blocked) {
        const resolved = await this.apiKeys.resolve(bearer).catch(() => null);
        if (resolved) return this.count(keyTracker(bearer), resolved);
      }
    }
    return this.count(ipTracker(req), null);
  }

  private async count(
    tracker: string,
    resolved: ResolvedApiKey | null
  ): Promise<RateLimitDecision> {
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
