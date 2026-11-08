import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { errorEnvelope } from "@/lib/api/error-body";
import { NOT_CONFIGURED_HEADERS } from "@/lib/api/proxy-error";
import { rateLimitProxy } from "@/lib/api/rate-limit";
import { clearSessionCookie, sessionFromRequest } from "./session-cookie";
import { buildUpstreamRequest } from "./upstream";

export type IntegratorMethod = "GET" | "POST" | "DELETE";

export interface RelayOptions {
  /** "cookie": the call needs the session cookie, sent upstream as a bearer token. */
  auth: "cookie" | "none";
  /** Builds the response for an upstream 2xx instead of relaying its body as-is. */
  onSuccess?: (payload: unknown, context: { bodyText: string }) => NextResponse;
}

export function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export function integratorError(
  code: string,
  message: string,
  status: number,
  headers?: Record<string, string>
): NextResponse {
  return noStore(NextResponse.json(errorEnvelope(code, message), { status, headers }));
}

function allowedOrigins(req: NextRequest): Set<string> {
  const origins = new Set([req.nextUrl.origin]);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl) {
    try {
      origins.add(new URL(appUrl).origin);
    } catch {
      // A malformed app URL adds nothing; the request's own origin still applies.
    }
  }
  return origins;
}

function isJson(req: NextRequest): boolean {
  const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  return type === "application/json";
}

/**
 * The checks every integrator route runs before anything else, in this order: the per-IP rate
 * limit, then, for a state-changing method, an Origin that is this site's own (a missing or
 * `null` Origin is refused), then a JSON body on POST. Origin and Content-Type close the
 * cross-site form and fetch paths that SameSite alone leaves to the browser.
 */
export async function guardIntegratorRequest(
  req: NextRequest,
  method: IntegratorMethod
): Promise<NextResponse | null> {
  const limited = await rateLimitProxy(req, "integrator");
  if (limited) return noStore(limited);
  if (method === "GET") return null;

  const origin = req.headers.get("origin");
  if (!origin || origin === "null" || !allowedOrigins(req).has(origin)) {
    return integratorError("forbidden_origin", "This request must come from LumenWipe.", 403);
  }
  if (method === "POST" && !isJson(req)) {
    return integratorError("unsupported_media_type", "Send the request as JSON.", 415);
  }
  return null;
}

function unauthorized(): NextResponse {
  const res = integratorError("unauthorized", "Your session expired. Sign in again.", 401);
  clearSessionCookie(res);
  return res;
}

export function notConfigured(): NextResponse {
  return integratorError(
    "integrator_api_not_configured",
    "Key management is not available right now.",
    503,
    NOT_CONFIGURED_HEADERS
  );
}

/**
 * Relays an integrator request to the API's `/v1/integrator/*` routes. These authenticate the
 * wallet owner with the session held in an httpOnly cookie, so the only credential sent upstream
 * is that cookie's token: a browser-supplied `Authorization` header is ignored, and the shared
 * server-side API key is never attached.
 */
export async function relayIntegrator(
  req: NextRequest,
  path: string,
  method: "GET" | "POST",
  options: RelayOptions
): Promise<NextResponse> {
  const refused = await guardIntegratorRequest(req, method);
  if (refused) return refused;

  const baseUrl = process.env.LUMENWIPE_API_URL;
  if (!baseUrl) {
    console.error("Integrator proxy error: LUMENWIPE_API_URL is not configured.");
    return notConfigured();
  }

  let authorization: string | null = null;
  if (options.auth === "cookie") {
    const session = sessionFromRequest(req);
    if (!session) return unauthorized();
    authorization = `Bearer ${session.token}`;
  }

  const bodyText = method === "POST" ? await req.text() : "";
  const { url, init } = buildUpstreamRequest(baseUrl, path, method, authorization, bodyText);

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch (e) {
    console.error("Integrator proxy error:", e);
    return integratorError("api_unavailable", "The API is currently unavailable.", 502);
  }
  const payload: unknown = await upstream.json().catch(() => null);
  if (payload === null) {
    return integratorError("upstream_error", "The API returned an unexpected response.", 502);
  }
  if (upstream.ok && options.onSuccess) return noStore(options.onSuccess(payload, { bodyText }));

  const res = NextResponse.json(payload, { status: upstream.status });
  if (options.auth === "cookie" && upstream.status === 401) clearSessionCookie(res);
  return noStore(res);
}
