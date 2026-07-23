import { PATH_ROUTING_API_URLS } from "@/config/networks";
import type { Network } from "@/config/networks";
import type { ClaimableBalance, OpenOffer } from "@/types/account";
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

interface HorizonClaimableBalance {
  id: string;
  asset: string; // "native" or "CODE:ISSUER"
  amount: string;
}

interface HorizonClaimableBalancesPage {
  _embedded?: { records?: HorizonClaimableBalance[] };
  _links?: { next?: { href?: string } };
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
      all.push({ id: b.id, asset: b.asset, amount: b.amount });
    }

    const nextHref = page._links?.next?.href;
    nextUrl = nextHref && records.length === PAGE_LIMIT ? nextHref : null;
  }

  return all;
}
