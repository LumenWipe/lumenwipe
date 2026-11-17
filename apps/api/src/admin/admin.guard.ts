import { timingSafeEqual } from "crypto";
import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { fail } from "@/common/fail";

/** Constant-time comparison: on a length mismatch the caller's buffer is compared with itself, so
 *  time depends only on what was sent and leaks neither the configured length nor a prefix. */
function safeEqual(provided: string, configured: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(configured);
  const sameLength = a.length === b.length;
  return timingSafeEqual(a, sameLength ? b : a) && sameLength;
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
