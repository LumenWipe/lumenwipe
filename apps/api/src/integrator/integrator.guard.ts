import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { fail } from "@/common/fail";
import { verifySession } from "./wallet-auth";

export const INTEGRATOR_SECRET_MIN_LENGTH = 32;

export function integratorSecret(): string | null {
  const secret = process.env.INTEGRATOR_AUTH_SECRET?.trim();
  return secret && secret.length >= INTEGRATOR_SECRET_MIN_LENGTH ? secret : null;
}

export function requireIntegratorConfig(): string {
  const secret = integratorSecret();
  if (!secret || !process.env.FIRESTORE_PROJECT_ID) {
    fail(
      "integrator_api_not_configured",
      "Self-serve API key management is not configured on this server.",
      503
    );
  }
  return secret;
}

export type IntegratorRequest = Request & { integratorAddress?: string };

/** Authenticates the wallet session minted by `POST /integrator/auth/session`. */
@Injectable()
export class IntegratorGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const secret = requireIntegratorConfig();
    const req = context.switchToHttp().getRequest<IntegratorRequest>();
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const address = token ? verifySession(secret, token) : null;
    if (!address) fail("unauthorized", "Sign in with your wallet to manage API keys.", 401);
    req.integratorAddress = address;
    return true;
  }
}
