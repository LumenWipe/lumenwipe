import { Injectable } from "@nestjs/common";
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

/**
 * Rate-limits per API key rather than per IP, so one integrator's traffic
 * cannot exhaust another's budget.
 */
@Injectable()
export class ApiKeyThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    return trackerForRequest(req);
  }
}
