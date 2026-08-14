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

export interface HorizonDeps {
  baseUrl: string;
  /** Defaults to global fetch. Injected in tests to stub responses and count calls. */
  fetch?: typeof globalThis.fetch;
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
  const url = `${deps.baseUrl}${path}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await doFetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (res.status === 404) return null;
    if (res.ok) return (await res.json()) as T;

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

    throw new Error(`Horizon request failed with ${res.status} (${url})`);
  }

  // Unreachable: the loop either returns or throws on its final attempt.
  throw new Error(`Horizon request exhausted retries (${url})`);
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

  while (path && out.length < maxTotal) {
    const page: Page<R> | null = await horizonGet<Page<R>>(path, deps);
    if (!page) break;
    const records: R[] = page._embedded?.records ?? [];
    out.push(...records);

    const nextHref: string | undefined = page._links?.next?.href;
    // A page shorter than the limit is the last one, whatever `next` says.
    path = nextHref && records.length === pageLimit ? toRelative(nextHref, deps.baseUrl) : null;
  }

  return out;
}

// Horizon returns `next` as either an absolute URL or a path. Normalizing to a path keeps
// every request going to the configured provider, so a compromised or misconfigured upstream
// cannot redirect pagination to a host we never chose.
function toRelative(href: string, baseUrl: string): string {
  if (href.startsWith(baseUrl)) return href.slice(baseUrl.length);
  try {
    const parsed = new URL(href);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return href.startsWith("/") ? href : `/${href}`;
  }
}
