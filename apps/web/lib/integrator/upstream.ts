const UPSTREAM_TIMEOUT_MS = 15_000;

/**
 * Builds the API call for an integrator route. Only the caller's own session `Authorization` is
 * forwarded: these routes authenticate the wallet owner, so the shared server-side API key must
 * never be attached.
 */
export function buildUpstreamRequest(
  baseUrl: string,
  path: string,
  method: "GET" | "POST",
  authorization: string | null,
  bodyText: string
): { url: string; init: RequestInit } {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (authorization) headers.Authorization = authorization;
  if (method === "POST" && bodyText) headers["Content-Type"] = "application/json";
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/integrator/${path}`,
    init: {
      method,
      headers,
      body: method === "POST" && bodyText ? bodyText : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    },
  };
}
