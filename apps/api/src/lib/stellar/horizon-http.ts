/**
 * The single HTTP seam to the Horizon-compatible account-state provider.
 *
 * Swapping providers (SDF's public Horizon, Blockdaemon, Validation Cloud, QuickNode, a
 * self-hosted instance) is a `baseUrl` change and nothing else - which is why there is no
 * provider interface here. `fetch` is injectable so tests can drive the raw HTTP layer,
 * including the failure this module exists to make visible: a paginated response that claims
 * a `next` link and then stops short. A stub that returned finished domain objects could not
 * express that, and under-enumeration is what produces a silently incomplete close plan.
 */

import { HORIZON_TIMEOUT_MS } from "@/config/constants";

export interface HorizonDeps {
  baseUrl: string;
  /** Defaults to global fetch. Injected in tests to stub responses and count calls. */
  fetch?: typeof globalThis.fetch;
}

/** Trailing slashes would produce `//accounts/...`, which Horizon 404s - reported to the user
 *  as "this account does not exist" when the real fault is a config typo. */
function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** Requests refused with 429 since process start. */
let rateLimitHitCount = 0;

/**
 * How many upstream requests have been rate-limited since this process started.
 *
 * The public Horizon allows 3600 requests/hour per IP, and Cloud Run egresses every request
 * from one address, so the whole service shares that budget. A non-zero and rising count is
 * the signal to move `PATH_ROUTING_API_*` to a provider with headroom - weeks before it turns
 * into a user-visible outage.
 */
export function rateLimitHits(): number {
  return rateLimitHitCount;
}

/** Test-only: clears the counter so one test's 429s don't leak into another's assertion. */
export function resetRateLimitHits(): void {
  rateLimitHitCount = 0;
}

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 400;

function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfterSeconds = Number(retryAfterHeader);
  // Horizon sends Retry-After in seconds. Honor it when it's a sane number; a hostile or
  // broken value must not park a user's close for minutes, so it's capped.
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, 5_000);
  }
  return BASE_BACKOFF_MS * 2 ** attempt;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GETs a Horizon path, retrying only on 429. Returns the parsed body, or null for 404.
 *
 * Every other non-OK status throws: a close plan built from a partial read is worse than one
 * that fails loudly, so nothing here degrades quietly into an empty result.
 */
export async function horizonGet<T>(path: string, deps: HorizonDeps): Promise<T | null> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const url = `${normalizeBase(deps.baseUrl)}${path}`;
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    // Without a deadline a provider that accepts the connection and never answers pins the
    // single Cloud Run instance until the platform's own request timeout, taking every other
    // endpoint down with it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HORIZON_TIMEOUT_MS);
    try {
      res = await doFetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (err) {
      // A DNS blip, a reset connection or a timeout. Transient by nature, so retried on the
      // same budget as a 429 rather than failing the whole read on one bad packet.
      lastError = err;
      if (attempt === MAX_RETRIES) {
        throw new Error(
          `Horizon request failed after ${MAX_RETRIES + 1} attempts (${url}): ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      }
      await sleep(backoffMs(attempt, null));
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 404) return null;
    if (res.ok) {
      try {
        return (await res.json()) as T;
      } catch (err) {
        // A 2xx whose body is not JSON is a broken provider, not an empty collection.
        throw new Error(
          `Horizon returned a non-JSON body (${url}): ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (res.status === 429) {
      rateLimitHitCount++;
      if (attempt === MAX_RETRIES) {
        throw new Error(
          `Horizon rate limit reached after ${MAX_RETRIES + 1} attempts (${url}). ` +
            `Point PATH_ROUTING_API_* at a provider with more headroom.`
        );
      }
      await sleep(backoffMs(attempt, res.headers.get("Retry-After")));
      continue;
    }

    // 5xx is the provider having a bad moment; retry it. 4xx is our request being wrong and
    // will not improve, so it fails immediately.
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      lastError = new Error(`Horizon request failed with ${res.status} (${url})`);
      await sleep(backoffMs(attempt, null));
      continue;
    }

    throw new Error(`Horizon request failed with ${res.status} (${url})`);
  }

  throw new Error(
    `Horizon request exhausted retries (${url})` +
      (lastError instanceof Error ? `: ${lastError.message}` : "")
  );
}

interface Page<R> {
  _embedded?: { records?: R[] };
  _links?: { next?: { href?: string } };
}

/**
 * Drains a paginated Horizon collection.
 *
 * Stops on a short page rather than trusting `next` to terminate, and caps the total so a
 * provider that paginates forever cannot hang a close. Reaching `maxTotal` is not treated as
 * a complete read - the caller's sub-entry reconciliation is what catches a short result,
 * which is why this returns what it got instead of pretending the set is whole.
 */
export async function horizonPaginate<R>(
  firstPath: string,
  deps: HorizonDeps,
  pageLimit: number,
  maxTotal: number
): Promise<R[]> {
  const out: R[] = [];
  let path: string | null = firstPath;
  let pageNumber = 0;

  while (path) {
    const page: Page<R> | null = await horizonGet<Page<R>>(path, deps);
    if (!page) {
      // A collection endpoint answers "nothing here" with 200 and an empty array. A 404 means
      // the endpoint is missing or the path is wrong - on page one that is a misconfigured
      // provider, mid-pagination it is a read that stopped early. Neither is an empty set.
      throw new Error(
        `Horizon returned 404 for a collection page (${path}); an empty collection is a 200 ` +
          `with no records, so this is a provider or configuration fault, not an empty result.`
      );
    }
    pageNumber++;
    const records: R[] = page._embedded?.records ?? [];
    out.push(...records);

    const nextHref: string | undefined = page._links?.next?.href;
    // A page shorter than the requested limit is the last one, whatever `next` says. A page
    // *longer* means the provider ignored the limit, so trusting `records.length === pageLimit`
    // alone would stop early; treat any short page as the end and anything else as more.
    const looksLikeLastPage = records.length < pageLimit;
    const more: boolean = Boolean(nextHref) && !looksLikeLastPage;

    // Strictly greater, checked after accumulating. Horizon advertises `next` on every full
    // page including the last, and the only way to learn a collection ended is to ask for the
    // page after it and get nothing back. Refusing at `>= maxTotal` would reject a complete
    // collection of exactly `maxTotal` - an account with exactly 1000 offers - as truncated.
    if (out.length > maxTotal) {
      throw new TruncatedCollectionError(
        `This account has more than ${maxTotal} entries in ${firstPath.split("?")[0]}, more ` +
          `than a close can enumerate in a single read. Building a plan from a partial list ` +
          `would leave the rest behind permanently, so it is refused.`
      );
    }

    path = more ? sameOriginPath(nextHref!, deps.baseUrl, pageNumber) : null;
  }

  return out;
}

/**
 * A collection too large to enumerate completely.
 *
 * Its own type because the caller has to tell it apart from a provider fault: this one is a
 * property of the account rather than the infrastructure, its message is safe to show a user,
 * and it is the read failure that will not resolve itself on a retry.
 */
export class TruncatedCollectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TruncatedCollectionError";
  }
}

/**
 * Normalizes a `next` link to a path on the configured provider.
 *
 * Compares parsed origins, not string prefixes: `https://horizon.example.attacker.com` starts
 * with `https://horizon.example`, so a prefix test would happily follow pagination onto an
 * attacker's host. Anything off-origin is refused rather than rewritten - a provider pointing
 * us elsewhere mid-collection is a fault worth surfacing, not something to silently correct.
 */
function sameOriginPath(href: string, baseUrl: string, pageNumber: number): string {
  const normalized = normalizeBase(baseUrl);
  let target: URL;
  let base: URL;
  try {
    // Resolved against the base, so a relative href works and a protocol-relative one
    // ("//evil.example/...") is parsed as the absolute URL it actually is rather than waved
    // through by a `startsWith("/")` test.
    base = new URL(normalized);
    target = new URL(href, base);
  } catch {
    throw new Error(`Horizon returned an unparseable pagination link on page ${pageNumber}`);
  }

  if (target.origin !== base.origin) {
    throw new Error(
      `Horizon pagination link points at ${target.origin}, not the configured provider ` +
        `${base.origin} (page ${pageNumber}).`
    );
  }

  // The result is re-appended to the base URL by horizonGet, so it has to be relative to the
  // base's own path - not the full pathname. Providers that serve Horizon under a prefix
  // (`https://host/horizon/v1`) are exactly the commercial ones this seam exists to support,
  // and returning the absolute pathname would duplicate that prefix on page two onward.
  const basePath = base.pathname.replace(/\/+$/, "");
  const full = `${target.pathname}${target.search}`;
  if (basePath && full.startsWith(`${basePath}/`)) return full.slice(basePath.length);
  if (basePath && full === basePath) return "";
  return full;
}
