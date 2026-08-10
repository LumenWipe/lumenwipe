import { PATH_ROUTING_API_URLS } from "@/config/networks";
import type { Network } from "@/config/networks";
import { SPONSORSHIP_MAX_OPERATIONS_SCANNED } from "@/config/constants";
import { horizonAssetToString } from "@/lib/utils/assets";
import { parseClaimPredicate } from "@/lib/stellar/horizon-adapter";
import {
  reconcileSponsoredEntries,
  type SponsorshipCandidate,
  type OwnerLiveState,
} from "@/lib/stellar/sponsorship-reconcile";
import type { SponsoredEntry } from "@lumenwipe/types";

const OPERATIONS_PAGE_LIMIT = 200;
const CB_PAGE_LIMIT = 200;
const CB_MAX_TOTAL = 1000;

interface HorizonOperation {
  type: string;
  source_account: string;
  sponsor?: string;
  sponsored_id?: string; // begin_sponsoring_future_reserves
  asset_type?: string; // change_trust
  asset_code?: string;
  asset_issuer?: string;
  name?: string; // manage_data
  signer_key?: string; // set_options / revoke_sponsorship
  account_id?: string; // revoke_sponsorship
  trustline_account_id?: string; // revoke_sponsorship
  trustline_asset?: string; // revoke_sponsorship, already "CODE:ISSUER"
  data_account_id?: string; // revoke_sponsorship
  data_name?: string; // revoke_sponsorship
  signer_account_id?: string; // revoke_sponsorship
}

interface HorizonOperationsPage {
  _embedded?: { records?: HorizonOperation[] };
  _links?: { next?: { href?: string } };
}

// Phase 1: discover candidate (owner, kind, key) tuples this account has ever been
// involved in sponsoring, by paging its own participant-inclusive operations list
// (verified against testnet: unlike /effects, /operations DOES surface operations
// sourced by the sponsoree while this account has an open sponsorship bracket).
// Never perfectly precise - see the module doc comment on reconcileSponsoredEntries
// for why that's fine.
async function discoverSponsorshipCandidates(
  address: string,
  network: Network
): Promise<{ candidates: SponsorshipCandidate[]; incomplete: boolean }> {
  const base = PATH_ROUTING_API_URLS[network];
  if (!base) return { candidates: [], incomplete: true };

  const candidates: SponsorshipCandidate[] = [];
  let scanned = 0;
  let incomplete = false;
  let nextUrl: string | null =
    `${base}/accounts/${address}/operations?order=asc&limit=${OPERATIONS_PAGE_LIMIT}`;

  while (nextUrl) {
    if (scanned >= SPONSORSHIP_MAX_OPERATIONS_SCANNED) {
      incomplete = true;
      break;
    }

    let res: Response;
    try {
      res = await fetch(nextUrl, { headers: { Accept: "application/json" }, cache: "no-store" });
    } catch {
      incomplete = true;
      break;
    }
    if (!res.ok) {
      incomplete = true;
      break;
    }

    const page = (await res.json()) as HorizonOperationsPage;
    const records = page._embedded?.records ?? [];
    scanned += records.length;

    for (const op of records) {
      if (op.type === "begin_sponsoring_future_reserves" && op.source_account === address) {
        if (op.sponsored_id) candidates.push({ kind: "account", owner: op.sponsored_id, key: "" });
        continue;
      }
      if (op.type === "change_trust" && op.sponsor === address) {
        candidates.push({
          kind: "trustline",
          owner: op.source_account,
          key: horizonAssetToString({
            asset_type: op.asset_type ?? "native",
            asset_code: op.asset_code,
            asset_issuer: op.asset_issuer,
          }),
        });
        continue;
      }
      if (op.type === "manage_data" && op.sponsor === address && op.name) {
        candidates.push({ kind: "data_entry", owner: op.source_account, key: op.name });
        continue;
      }
      if (
        (op.type === "manage_buy_offer" || op.type === "manage_sell_offer") &&
        op.sponsor === address
      ) {
        candidates.push({ kind: "offer", owner: op.source_account, key: "" });
        continue;
      }
      if (op.type === "set_options" && op.sponsor === address && op.signer_key) {
        candidates.push({ kind: "signer", owner: op.source_account, key: op.signer_key });
        continue;
      }
      if (op.type === "revoke_sponsorship") {
        if (op.account_id) candidates.push({ kind: "account", owner: op.account_id, key: "" });
        if (op.trustline_account_id && op.trustline_asset) {
          candidates.push({
            kind: "trustline",
            owner: op.trustline_account_id,
            key: op.trustline_asset,
          });
        }
        if (op.data_account_id && op.data_name) {
          candidates.push({ kind: "data_entry", owner: op.data_account_id, key: op.data_name });
        }
        if (op.signer_account_id && op.signer_key) {
          candidates.push({ kind: "signer", owner: op.signer_account_id, key: op.signer_key });
        }
      }
    }

    const nextHref = page._links?.next?.href;
    nextUrl = nextHref && records.length === OPERATIONS_PAGE_LIMIT ? nextHref : null;
  }

  return { candidates, incomplete };
}

interface HorizonAccountForSponsorship {
  sponsor?: string;
  balances: Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    sponsor?: string;
  }>;
  signers: Array<{ key: string; sponsor?: string }>;
}

interface HorizonOffer {
  id: string | number;
  sponsor?: string;
}

interface HorizonOffersPage {
  _embedded?: { records?: HorizonOffer[] };
  _links?: { next?: { href?: string } };
}

// Phase 2: for one owner account discovered in Phase 1, read its CURRENT sponsor
// fields directly from Horizon - this is the actual source of truth, not the history.
async function fetchOwnerLiveState(
  owner: string,
  network: Network,
  needsOffers: boolean,
  dataKeys: string[]
): Promise<OwnerLiveState> {
  const base = PATH_ROUTING_API_URLS[network];
  const empty: OwnerLiveState = {
    accountSponsor: null,
    trustlineSponsors: {},
    signerSponsors: {},
    offerSponsors: {},
    dataSponsors: {},
    fetchFailed: true,
  };
  if (!base) return empty;

  try {
    const accountRes = await fetch(`${base}/accounts/${owner}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!accountRes.ok) return empty;
    const account = (await accountRes.json()) as HorizonAccountForSponsorship;

    const trustlineSponsors: Record<string, string | null> = {};
    for (const b of account.balances) {
      if (b.asset_type === "liquidity_pool_shares") continue;
      trustlineSponsors[horizonAssetToString(b)] = b.sponsor ?? null;
    }

    const signerSponsors: Record<string, string | null> = {};
    for (const s of account.signers) {
      signerSponsors[s.key] = s.sponsor ?? null;
    }

    const dataSponsors: Record<string, string | null> = {};
    for (const key of dataKeys) {
      try {
        const dataRes = await fetch(`${base}/accounts/${owner}/data/${key}`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        dataSponsors[key] = dataRes.ok ? ((await dataRes.json()).sponsor ?? null) : null;
      } catch {
        return { ...empty, accountSponsor: account.sponsor ?? null, trustlineSponsors, signerSponsors };
      }
    }

    const offerSponsors: Record<string, string | null> = {};
    if (needsOffers) {
      let nextUrl: string | null = `${base}/accounts/${owner}/offers?limit=200`;
      while (nextUrl) {
        const res: Response = await fetch(nextUrl, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!res.ok) break;
        const page = (await res.json()) as HorizonOffersPage;
        const records = page._embedded?.records ?? [];
        for (const o of records) offerSponsors[String(o.id)] = o.sponsor ?? null;
        const nextHref = page._links?.next?.href;
        nextUrl = nextHref && records.length === 200 ? nextHref : null;
      }
    }

    return {
      accountSponsor: account.sponsor ?? null,
      trustlineSponsors,
      signerSponsors,
      offerSponsors,
      dataSponsors,
      fetchFailed: false,
    };
  } catch {
    return empty;
  }
}

interface HorizonClaimableBalance {
  id: string;
  asset: string;
  amount: string;
  sponsor?: string;
  last_modified_time: string;
  claimants: Array<{ destination: string; predicate: Parameters<typeof parseClaimPredicate>[0] }>;
}

interface HorizonClaimableBalancesPage {
  _embedded?: { records?: HorizonClaimableBalance[] };
  _links?: { next?: { href?: string } };
}

async function fetchClaimableBalancesBySponsor(
  address: string,
  network: Network
): Promise<{ entries: SponsoredEntry[]; incomplete: boolean }> {
  const base = PATH_ROUTING_API_URLS[network];
  if (!base) return { entries: [], incomplete: true };

  const entries: SponsoredEntry[] = [];
  let incomplete = false;
  let nextUrl: string | null = `${base}/claimable_balances?sponsor=${address}&limit=${CB_PAGE_LIMIT}`;

  while (nextUrl && entries.length < CB_MAX_TOTAL) {
    let res: Response;
    try {
      res = await fetch(nextUrl, { headers: { Accept: "application/json" }, cache: "no-store" });
    } catch {
      incomplete = true;
      break;
    }
    if (!res.ok) {
      incomplete = true;
      break;
    }

    const page = (await res.json()) as HorizonClaimableBalancesPage;
    const records = page._embedded?.records ?? [];

    // Defensive filter: trust the server-side ?sponsor= scoping, but never rely on it
    // exclusively - each record carries its own sponsor field too.
    for (const b of records) {
      if (b.sponsor === address) entries.push({ kind: "claimable_balance", balanceId: b.id });
    }

    const nextHref = page._links?.next?.href;
    nextUrl = nextHref && records.length === CB_PAGE_LIMIT ? nextHref : null;
  }
  if (nextUrl) incomplete = true; // hit CB_MAX_TOTAL with more pages remaining

  return { entries, incomplete };
}

export async function enumerateSponsoredEntries(
  address: string,
  network: Network,
  numSponsoring: number
): Promise<{ sponsoredEntries: SponsoredEntry[]; sponsorshipEnumerationIncomplete: boolean }> {
  const [{ candidates, incomplete: discoveryIncomplete }, cbResult] = await Promise.all([
    discoverSponsorshipCandidates(address, network),
    fetchClaimableBalancesBySponsor(address, network),
  ]);

  const ownersNeedingOffers = new Set<string>();
  const dataKeysByOwner = new Map<string, Set<string>>();
  const owners = new Set<string>();
  for (const c of candidates) {
    owners.add(c.owner);
    if (c.kind === "offer") ownersNeedingOffers.add(c.owner);
    if (c.kind === "data_entry") {
      if (!dataKeysByOwner.has(c.owner)) dataKeysByOwner.set(c.owner, new Set());
      dataKeysByOwner.get(c.owner)!.add(c.key);
    }
  }

  const liveStateByOwner = new Map<string, OwnerLiveState>(
    await Promise.all(
      Array.from(owners).map(
        async (owner): Promise<[string, OwnerLiveState]> => [
          owner,
          await fetchOwnerLiveState(
            owner,
            network,
            ownersNeedingOffers.has(owner),
            Array.from(dataKeysByOwner.get(owner) ?? [])
          ),
        ]
      )
    )
  );

  return reconcileSponsoredEntries(
    address,
    candidates,
    liveStateByOwner,
    cbResult.entries,
    discoveryIncomplete,
    cbResult.incomplete,
    numSponsoring
  );
}
