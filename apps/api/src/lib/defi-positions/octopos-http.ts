/**
 * The HTTP seam to OctoPos, the DeFi position provider (architecture.md §7.1).
 *
 * Unlike horizon-http.ts, this never throws: DeFi detection is an optional enhancement with a
 * designed degraded mode ("an OctoPos outage never blocks a classic-only close"), so every
 * failure - unconfigured, timeout, a bad status, a malformed body - becomes a typed { ok: false }
 * the caller logs and falls back from, rather than a rejection that would have to be caught at
 * every call site.
 */

import { OCTOPOS_TIMEOUT_MS } from "@/config/constants";

export interface OctoPosDeps {
  /** Empty string means "not configured" - the caller intentionally opted out of DeFi detection. */
  baseUrl: string;
  apiKey?: string;
  /** Defaults to global fetch. Injected in tests to stub responses and count calls. */
  fetch?: typeof globalThis.fetch;
}

export type OctoPosResult =
  | { ok: true; raw: unknown }
  | { ok: false; reason: "unconfigured" | "unavailable"; detail: string };

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

const MAX_RETRIES = 2;
const BACKOFF_MS = 300;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GETs an address's OctoPos portfolio. Retries a small, bounded number of times on 429/5xx -
 * short deliberately, since this is a non-essential enhancement that should fail fast into
 * degraded mode rather than stall an analyze call waiting on a third party.
 */
export async function fetchOctoPosPortfolio(
  address: string,
  deps: OctoPosDeps
): Promise<OctoPosResult> {
  if (!deps.baseUrl) {
    return {
      ok: false,
      reason: "unconfigured",
      detail: "OctoPos is not configured; DeFi position detection is disabled.",
    };
  }

  const doFetch = deps.fetch ?? globalThis.fetch;
  const url = `${normalizeBase(deps.baseUrl)}/v1/positions/${address}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (deps.apiKey) headers["x-api-key"] = deps.apiKey;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OCTOPOS_TIMEOUT_MS);
    try {
      res = await doFetch(url, { headers, cache: "no-store", signal: controller.signal });
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        return {
          ok: false,
          reason: "unavailable",
          detail: `OctoPos request failed (${url}): ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      await sleep(BACKOFF_MS * 2 ** attempt);
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      try {
        return { ok: true, raw: await res.json() };
      } catch (err) {
        return {
          ok: false,
          reason: "unavailable",
          detail: `OctoPos returned a non-JSON body (${url}): ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < MAX_RETRIES) {
      await sleep(BACKOFF_MS * 2 ** attempt);
      continue;
    }

    return {
      ok: false,
      reason: "unavailable",
      detail: `OctoPos request failed with ${res.status} (${url})`,
    };
  }

  return { ok: false, reason: "unavailable", detail: `OctoPos request exhausted retries (${url})` };
}
