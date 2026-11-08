import { NextResponse } from "next/server";
import {
  LumenWipeApiError,
  LumenWipeInvalidNetworkError,
  LumenWipeTimeoutError,
} from "@lumenwipe/sdk";
import { errorEnvelope, requestIdHeaders } from "@/lib/api/error-body";
import { invalidNetworkResponse } from "@/lib/api/network-segment";
import { secondsUntilNextUtcDay } from "@/lib/utc-day";

/** The server has no API URL or key: an operator's fault, which a retry can outlast. */
export class ApiNotConfiguredError extends Error {
  constructor(variable: string) {
    super(`${variable} is not configured.`);
    this.name = "ApiNotConfiguredError";
  }
}

/** Headers for a 503: an operator's fault, so the caller learns when to look again. */
export const NOT_CONFIGURED_HEADERS = { "Retry-After": "30" };

/**
 * The response for a failed proxied call: the upstream API's own error body and status relayed
 * verbatim, or, for a failure the proxy hits itself, the API's `{ error: { code, message } }`
 * envelope, so the browser reads one shape whichever side failed.
 */
export function proxyErrorResponse(e: unknown): NextResponse {
  const response = errorResponseFor(e);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function errorResponseFor(e: unknown): NextResponse {
  if (e instanceof LumenWipeInvalidNetworkError) return invalidNetworkResponse();
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
  if (e instanceof ApiNotConfiguredError) {
    console.error("API proxy error:", e);
    return NextResponse.json(
      errorEnvelope("service_unavailable", "The service is temporarily unavailable."),
      { status: 503, headers: NOT_CONFIGURED_HEADERS }
    );
  }
  // The API is unreachable.
  console.error("API proxy error:", e);
  return NextResponse.json(errorEnvelope("api_unavailable", "The API is currently unavailable."), {
    status: 502,
  });
}

/** The answer of a route whose caller is over its daily limit: a 429 in the usual envelope that
 *  says when the counter, keyed by the UTC day of `now`, starts again, and that no cache may keep
 *  and serve to another caller. Every route gets both headers from here. */
export function rateLimitedResponse(now: Date = new Date()): NextResponse {
  return NextResponse.json(
    errorEnvelope("rate_limited", "Too many requests. Please slow down and try again later."),
    {
      status: 429,
      headers: {
        "Retry-After": String(secondsUntilNextUtcDay(now)),
        "Cache-Control": "no-store",
      },
    }
  );
}

/** The answer of a route that refuses while its rate limiter can't be asked: a retryable 503 in
 *  the usual envelope, which does not say the limiter is the cause. */
export function rateLimiterUnavailableResponse(): NextResponse {
  return NextResponse.json(
    errorEnvelope("service_unavailable", "The service is temporarily unavailable."),
    { status: 503, headers: { ...NOT_CONFIGURED_HEADERS, "Cache-Control": "no-store" } }
  );
}
