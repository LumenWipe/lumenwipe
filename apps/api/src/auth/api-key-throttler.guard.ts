import { createHash } from "crypto";
import { ExecutionContext, Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

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
 */
@Injectable()
export class ApiKeyThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    return trackerForRequest(req);
  }

  protected generateKey(_context: ExecutionContext, suffix: string, name: string): string {
    return throttleStorageKey(name, suffix);
  }
}
