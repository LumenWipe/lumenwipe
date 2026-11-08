import { NextResponse, type NextRequest } from "next/server";
import {
  guardIntegratorRequest,
  integratorError,
  noStore,
  relayIntegrator,
} from "@/lib/integrator/relay";
import {
  clearSessionCookie,
  cookieMaxAge,
  expiresAtIso,
  parseSessionToken,
  sessionFromRequest,
  setSessionCookie,
} from "@/lib/integrator/session-cookie";

function requestedAddress(bodyText: string): unknown {
  try {
    return (JSON.parse(bodyText) as { address?: unknown } | null)?.address;
  } catch {
    return undefined;
  }
}

/** Exchanges a signed challenge for a session held in an httpOnly cookie; the body never carries
 *  the token. */
export function POST(req: NextRequest) {
  return relayIntegrator(req, "auth/session", "POST", {
    auth: "none",
    onSuccess(payload, { bodyText }) {
      const session = parseSessionToken((payload as { token?: unknown } | null)?.token);
      if (
        !session ||
        session.address !== requestedAddress(bodyText) ||
        cookieMaxAge(session.exp) === 0
      ) {
        console.error("Integrator proxy error: the API returned a malformed session.");
        return integratorError("upstream_error", "The API returned an unexpected response.", 502);
      }
      const res = NextResponse.json({
        address: session.address,
        expiresAt: expiresAtIso(session.exp),
      });
      setSessionCookie(res, session);
      return res;
    },
  });
}

/** The session the cookie holds, read locally: no upstream call. */
export async function GET(req: NextRequest) {
  const refused = await guardIntegratorRequest(req, "GET");
  if (refused) return refused;
  const session = sessionFromRequest(req);
  if (!session) {
    const res = integratorError("unauthorized", "You are not signed in.", 401);
    clearSessionCookie(res);
    return res;
  }
  return noStore(
    NextResponse.json({ address: session.address, expiresAt: expiresAtIso(session.exp) })
  );
}

/** Signs out of this browser. The token itself stays valid upstream until it expires. */
export async function DELETE(req: NextRequest) {
  const refused = await guardIntegratorRequest(req, "DELETE");
  if (refused) return refused;
  const res = noStore(new NextResponse(null, { status: 204 }));
  clearSessionCookie(res);
  return res;
}
