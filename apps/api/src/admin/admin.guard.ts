import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { fail } from "@/common/fail";

const COMPARE_KEY = randomBytes(32);

function digest(value: string): Buffer {
  return createHmac("sha256", COMPARE_KEY).update(value).digest();
}

/** Constant-time string comparison - a plain `===` on a secret leaks its length/prefix through
 *  timing. Both sides are HMACed under a per-process random key, so `timingSafeEqual` always sees
 *  equal-length digests nobody can precompute, and neither the length nor a matching prefix leaks. */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Guards the self-serve API key management endpoints (issue #289). Separate from `ApiKeyGuard`
 * deliberately: the integrator-facing auth mechanism for self-serve issuance is not decided yet
 * (outside this repo's scope), so these endpoints are reachable only with a distinct operator
 * secret, never an integrator API key. Also requires `FIRESTORE_PROJECT_ID` - without it,
 * `createApiKeyStore` falls back to an in-memory store that silently wouldn't persist a created
 * key past a restart, which is a worse failure than refusing outright (CLAUDE.md's "a blocker
 * with an explanation, never silently skipped").
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const token = process.env.ADMIN_API_TOKEN?.trim();
    const firestoreConfigured = Boolean(process.env.FIRESTORE_PROJECT_ID);
    if (!token || !firestoreConfigured) {
      fail(
        "admin_api_not_configured",
        "Self-serve API key management is not configured on this server.",
        503
      );
    }

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    const provided = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!provided || !safeEqual(provided, token)) {
      fail("unauthorized", "A valid admin token is required.", 401);
    }

    return true;
  }
}
