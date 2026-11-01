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

import type { Deadline } from "@/common/deadline";
import {
  pathOnBase,
  resolveDeadline,
  UpstreamError,
  upstreamGetJson,
  type UpstreamOptions,
} from "./upstream-client";

export { rateLimitHits, resetUpstreamCounters as resetRateLimitHits } from "./upstream-client";

export interface HorizonDeps {
  baseUrl: string;
  /** Auth for this provider alone. */
  headers?: Record<string, string>;
  /** Defaults to global fetch. Injected in tests to stub responses and count calls. */
  fetch?: typeof globalThis.fetch;
  /** The request's budget; read from the request context when absent. */
  deadline?: Deadline;
  /** Retry and clock overrides, for tests. */
  client?: Pick<UpstreamOptions, "policy" | "random" | "sleep" | "now">;
  /** Receives the ledger each response reflects (Horizon's `Latest-Ledger` header), when sent. */
  onLedger?: (ledger: number) => void;
  /** Told when a response with a body came without a usable `Latest-Ledger` header. */
  onLedgerMissing?: () => void;
}

function ledgerHeader(headers: Pick<Headers, "get">): number | null {
  const value = headers.get("Latest-Ledger");
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}

/**
 * GETs a Horizon path with the shared upstream policy. Returns the parsed body, or null for 404.
 *
 * Every other failure throws an `UpstreamError`: a close plan built from a partial read is worse
 * than one that fails loudly, so nothing here degrades quietly into an empty result.
 */
export async function horizonGet<T>(path: string, deps: HorizonDeps): Promise<T | null> {
  return upstreamGetJson<T>(deps.baseUrl, path, {
    target: "horizon",
    fetch: deps.fetch,
    deadline: deps.deadline,
    headers: deps.headers,
    notFoundIsNull: true,
    ...deps.client,
    onHeaders: (headers) => {
      const ledger = ledgerHeader(headers);
      if (ledger === null) deps.onLedgerMissing?.();
      else deps.onLedger?.(ledger);
    },
  });
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
  const { records, overflowed } = await horizonPaginateUpTo<R>(
    firstPath,
    deps,
    pageLimit,
    maxTotal
  );
  if (overflowed) {
    throw new TruncatedCollectionError(
      `This account has more than ${maxTotal} entries in ${firstPath.split("?")[0]}, more ` +
        `than a close can enumerate in a single read. Building a plan from a partial list ` +
        `would leave the rest behind permanently, so it is refused.`
    );
  }
  return records;
}

/**
 * Like `horizonPaginate`, but reaching the ceiling is reported rather than thrown: the first
 * `maxTotal` records come back with `overflowed` set, so the caller can process a bounded
 * part and still know the read was not the whole collection. A collection of exactly
 * `maxTotal` is complete: the page after it is empty, so `overflowed` stays false.
 */
export async function horizonPaginateUpTo<R>(
  firstPath: string,
  deps: HorizonDeps,
  pageLimit: number,
  maxTotal: number
): Promise<{ records: R[]; overflowed: boolean }> {
  const out: R[] = [];
  const bounded: HorizonDeps = { ...deps, deadline: resolveDeadline(deps.deadline) };
  let path: string | null = firstPath;

  while (path) {
    const page: Page<R> | null = await horizonGet<Page<R>>(path, bounded);
    if (!page) {
      // A collection endpoint answers "nothing here" with 200 and an empty array. A 404 means
      // the endpoint is missing or the path is wrong - on page one that is a misconfigured
      // provider, mid-pagination it is a read that stopped early. Neither is an empty set.
      throw new UpstreamError("bad_response", "horizon");
    }
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
    // page after it and get nothing back. Stopping at `>= maxTotal` would call a complete
    // collection of exactly `maxTotal` - an account with exactly 1000 offers - truncated.
    if (out.length > maxTotal) return { records: out.slice(0, maxTotal), overflowed: true };

    path = more ? pathOnBase(nextHref!, deps.baseUrl, "horizon") : null;
  }

  return { records: out, overflowed: false };
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
