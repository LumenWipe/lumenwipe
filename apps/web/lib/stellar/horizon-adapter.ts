import { PATH_ROUTING_API_URLS } from "@/config/networks";
import type { Network } from "@/config/networks";
import type { ClaimableBalance, ClaimPredicate, OpenOffer } from "@/types/account";
import { horizonAssetToString } from "@/lib/utils/assets";

interface HorizonOffer {
  id: string | number;
  selling: { asset_type: string; asset_code?: string; asset_issuer?: string };
  buying: { asset_type: string; asset_code?: string; asset_issuer?: string };
  amount: string;
  price: string;
}

interface HorizonOffersPage {
  _embedded?: { records?: HorizonOffer[] };
  _links?: { next?: { href?: string } };
}

interface HorizonClaimPredicate {
  unconditional?: boolean;
  and?: HorizonClaimPredicate[];
  or?: HorizonClaimPredicate[];
  not?: HorizonClaimPredicate;
  abs_before?: string;
  abs_before_epoch?: string;
  rel_before?: string;
}

interface HorizonClaimant {
  destination: string;
  predicate: HorizonClaimPredicate;
}

interface HorizonClaimableBalance {
  id: string;
  asset: string; // "native" or "CODE:ISSUER"
  amount: string;
  sponsor?: string;
  last_modified_time: string;
  claimants: HorizonClaimant[];
}

interface HorizonClaimableBalancesPage {
  _embedded?: { records?: HorizonClaimableBalance[] };
  _links?: { next?: { href?: string } };
}

// Horizon has no separate "created" timestamp for a claimable balance; last_modified_time
// is the creation time for the (overwhelmingly common) case of a balance nothing has
// touched since it was created, so it's used as the anchor for rel_before predicates.
function parseClaimPredicate(
  raw: HorizonClaimPredicate,
  createdAtEpochSeconds: number
): ClaimPredicate {
  if (raw.and) {
    return {
      type: "and",
      predicates: raw.and.map((p) => parseClaimPredicate(p, createdAtEpochSeconds)),
    };
  }
  if (raw.or) {
    return {
      type: "or",
      predicates: raw.or.map((p) => parseClaimPredicate(p, createdAtEpochSeconds)),
    };
  }
  if (raw.not) {
    return { type: "not", predicate: parseClaimPredicate(raw.not, createdAtEpochSeconds) };
  }
  if (raw.abs_before_epoch !== undefined) {
    return { type: "before_absolute_time", absBeforeEpoch: raw.abs_before_epoch };
  }
  if (raw.abs_before !== undefined) {
    return {
      type: "before_absolute_time",
      absBeforeEpoch: String(Math.floor(Date.parse(raw.abs_before) / 1000)),
    };
  }
  if (raw.rel_before !== undefined) {
    return {
      type: "before_relative_time",
      relBeforeSeconds: raw.rel_before,
      deadlineEpoch: String(createdAtEpochSeconds + Number(raw.rel_before)),
    };
  }
  return { type: "unconditional" };
}

const PAGE_LIMIT = 200;
const MAX_TOTAL = 1000;

/**
 * Fetches open DEX offers for an account from a Horizon-compatible API.
 * Uses PATH_ROUTING_API_URLS[network] as the base. Returns [] if the URL
 * is not configured rather than throwing - callers must treat missing offers
 * as an unverified state and surface an appropriate warning.
 */
export async function fetchOffersFromAdapter(
  address: string,
  network: Network
): Promise<OpenOffer[]> {
  const base = PATH_ROUTING_API_URLS[network];
  if (!base) return [];

  const allOffers: OpenOffer[] = [];
  let nextUrl: string | null = `${base}/accounts/${address}/offers?limit=${PAGE_LIMIT}`;

  while (nextUrl && allOffers.length < MAX_TOTAL) {
    let res: Response;
    try {
      res = await fetch(nextUrl, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
    } catch {
      break;
    }
    if (!res.ok) break;

    const page = (await res.json()) as HorizonOffersPage;
    const records = page._embedded?.records ?? [];

    for (const o of records) {
      allOffers.push({
        id: String(o.id),
        selling: horizonAssetToString(o.selling),
        buying: horizonAssetToString(o.buying),
        amount: o.amount,
        price: o.price,
      });
    }

    const nextHref = page._links?.next?.href;
    nextUrl = nextHref && records.length === PAGE_LIMIT ? nextHref : null;
  }

  return allOffers;
}

/**
 * Fetches claimable balances where `address` is a claimant from a
 * Horizon-compatible API. Returns [] when the adapter URL is not configured.
 * These balances do not affect the account's numSubEntries but represent
 * recoverable assets that will be inaccessible after ACCOUNT_MERGE if unclaimed.
 */
export async function fetchClaimableBalancesForClaimant(
  address: string,
  network: Network
): Promise<ClaimableBalance[]> {
  const base = PATH_ROUTING_API_URLS[network];
  if (!base) return [];

  const all: ClaimableBalance[] = [];
  let nextUrl: string | null = `${base}/claimable_balances?claimant=${address}&limit=${PAGE_LIMIT}`;

  while (nextUrl && all.length < MAX_TOTAL) {
    let res: Response;
    try {
      res = await fetch(nextUrl, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
    } catch {
      break;
    }
    if (!res.ok) break;

    const page = (await res.json()) as HorizonClaimableBalancesPage;
    const records = page._embedded?.records ?? [];

    for (const b of records) {
      const createdAtEpochSeconds = Math.floor(Date.parse(b.last_modified_time) / 1000);
      all.push({
        id: b.id,
        asset: b.asset,
        amount: b.amount,
        sponsor: b.sponsor ?? null,
        claimants: b.claimants.map((c) => ({
          destination: c.destination,
          predicate: parseClaimPredicate(c.predicate, createdAtEpochSeconds),
        })),
      });
    }

    const nextHref = page._links?.next?.href;
    nextUrl = nextHref && records.length === PAGE_LIMIT ? nextHref : null;
  }

  return all;
}
