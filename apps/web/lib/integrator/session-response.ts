import "server-only";
import { NextResponse } from "next/server";
import { integratorError } from "./relay";
import { cookieMaxAge, expiresAtIso, parseSessionToken, setSessionCookie } from "./session-cookie";

function requestedAddress(bodyText: string): unknown {
  try {
    return (JSON.parse(bodyText) as { address?: unknown } | null)?.address;
  } catch {
    return undefined;
  }
}

/**
 * Moves the session token the API issued into the httpOnly cookie and answers the browser with
 * only the address and expiry. A token for another address than the one the request named, or one
 * already expired, is refused as a malformed upstream answer.
 */
export function sessionResponse(payload: unknown, bodyText: string): NextResponse {
  const session = parseSessionToken((payload as { token?: unknown } | null)?.token);
  if (
    !session ||
    session.address !== requestedAddress(bodyText) ||
    cookieMaxAge(session.exp) === 0
  ) {
    console.error("Integrator proxy error: the API returned a malformed session.");
    return integratorError("upstream_error", "The API returned an unexpected response.", 502);
  }
  const res = NextResponse.json({ address: session.address, expiresAt: expiresAtIso(session.exp) });
  setSessionCookie(res, session);
  return res;
}
