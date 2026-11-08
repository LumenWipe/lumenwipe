import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";

export const SESSION_COOKIE = "__Secure-lw_integrator_session";
export const SESSION_COOKIE_PATH = "/api/integrator";
/** The API's own session lifetime: a cookie never outlives the token it carries. */
export const MAX_SESSION_SECONDS = 1800;

const TOKEN = /^lws\.([A-Z2-7]{56})\.(\d{1,12})\.([A-Za-z0-9_-]+)$/;

export interface SessionToken {
  token: string;
  address: string;
  /** Unix seconds. */
  exp: number;
}

/**
 * Reads the shape of an API session token, `lws.<G-address>.<exp>.<mac>`. The web cannot check
 * the MAC (only the API holds its secret), so a well-formed token is only a claim: the API still
 * verifies it on every keys call, and a forged one gets a 401 there.
 */
export function parseSessionToken(token: unknown): SessionToken | null {
  if (typeof token !== "string") return null;
  const match = TOKEN.exec(token);
  if (!match) return null;
  const [, address, expRaw] = match;
  if (!StrKey.isValidEd25519PublicKey(address)) return null;
  return { token, address, exp: Number(expRaw) };
}

function nowSeconds(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}

/** Seconds the cookie may live: what is left of the token, capped at the API's session lifetime. */
export function cookieMaxAge(exp: number, now: Date = new Date()): number {
  return Math.min(Math.max(exp - nowSeconds(now), 0), MAX_SESSION_SECONDS);
}

/** The well-formed, unexpired session the request's cookie carries, or null. */
export function sessionFromRequest(req: NextRequest, now: Date = new Date()): SessionToken | null {
  const session = parseSessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  return session && session.exp > nowSeconds(now) ? session : null;
}

export function expiresAtIso(exp: number): string {
  return new Date(exp * 1000).toISOString();
}

const BASE = {
  name: SESSION_COOKIE,
  httpOnly: true,
  secure: true,
  sameSite: "strict",
  path: SESSION_COOKIE_PATH,
} as const;

export function setSessionCookie(
  res: NextResponse,
  session: SessionToken,
  now: Date = new Date()
): void {
  res.cookies.set({ ...BASE, value: session.token, maxAge: cookieMaxAge(session.exp, now) });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set({ ...BASE, value: "", maxAge: 0 });
}
