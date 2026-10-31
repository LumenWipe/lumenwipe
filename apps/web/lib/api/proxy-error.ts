import { NextResponse } from "next/server";
import { LumenWipeApiError, LumenWipeTimeoutError } from "@lumenwipe/sdk";
import { errorEnvelope, requestIdHeaders } from "@/lib/api/error-body";

/**
 * The response for a failed proxied call: the upstream API's own error body and status relayed
 * verbatim, or, for a failure the proxy hits itself, the API's `{ error: { code, message } }`
 * envelope, so the browser reads one shape whichever side failed.
 */
export function proxyErrorResponse(e: unknown): NextResponse {
  if (e instanceof LumenWipeApiError) {
    const body =
      typeof e.body === "object" && e.body !== null
        ? e.body
        : errorEnvelope("upstream_error", "The API returned an unexpected response.");
    // Guard against a 0/undefined status defaulting NextResponse to 200,
    // which would relay an error body as a success.
    return NextResponse.json(body, {
      status: e.status || 502,
      headers: requestIdHeaders(e.requestId),
    });
  }
  if (e instanceof LumenWipeTimeoutError) {
    return NextResponse.json(errorEnvelope("upstream_timeout", "The API request timed out."), {
      status: 504,
    });
  }
  // Missing LUMENWIPE_API_* config, or the API is unreachable.
  console.error("API proxy error:", e);
  return NextResponse.json(errorEnvelope("api_unavailable", "The API is currently unavailable."), {
    status: 502,
  });
}

export function rateLimitedResponse(): NextResponse {
  return NextResponse.json(
    errorEnvelope("rate_limited", "Too many requests. Please slow down and try again later."),
    { status: 429 }
  );
}
