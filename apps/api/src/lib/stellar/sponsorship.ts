import { PATH_ROUTING_API_URLS } from "@/config/networks";
import type { Network } from "@/config/networks";
import { SPONSORSHIP_MAX_OPERATIONS_SCANNED, HORIZON_TIMEOUT_MS } from "@/config/constants";
import { horizonAssetToString } from "@/lib/utils/assets";
import { parseClaimPredicate } from "@/lib/stellar/horizon-adapter";
import {
  reconcileSponsoredEntries,
  type SponsorshipCandidate,
  type OwnerLiveState,
} from "@/lib/stellar/sponsorship-reconcile";
import type { SponsoredEntry } from "@lumenwipe/types";
import { Logger } from "@nestjs/common";

// Nest's logger, not console: these lines are how an operator learns the reader silently
// degraded, and console output does not carry the context prefix or respect log levels.
const logger = new Logger("sponsorship");

const OPERATIONS_PAGE_LIMIT = 200;
const CB_PAGE_LIMIT = 200;
const CB_MAX_TOTAL = 1000;
// How many owners' live state we fetch concurrently in enumerateSponsoredEntries - a
// sponsor of many accounts must not self-inflict rate limiting or let one hung
// connection stall the whole read indefinitely.
const OWNER_FETCH_CONCURRENCY = 10;

// Same AbortController + setTimeout idiom, applied
// to every fetch in this module so a slow/hung Horizon-compatible endpoint can't stall
// enumeration indefinitely.
async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HORIZON_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
  } finally {
    clearTimeout(timeout);
  }
}

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

    // The try spans parsing and record iteration too, not just the fetch: a proxy/CDN
    // error page served as 200, a truncated body, or an unexpected JSON shape would
    // otherwise throw straight out of getAccountState and take down every endpoint that
    // reads account state. Degrade to "incomplete" instead, like the adapters next door.
    let recordCount = 0;
    let nextHref: string | undefined;
    try {
      const res = await fetchWithTimeout(nextUrl);
      if (!res.ok) {
        incomplete = true;
        break;
      }

      const page = (await res.json()) as HorizonOperationsPage;
      const records = page?._embedded?.records ?? [];
      recordCount = records.length;
      scanned += recordCount;

      for (const op of records) {
        if (op.type === "begin_sponsoring_future_reserves" && op.source_account === address) {
          if (op.sponsored_id) {
            candidates.push({ kind: "account", owner: op.sponsored_id, key: "" });
          }
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

      nextHref = page?._links?.next?.href;
    } catch {
      incomplete = true;
      break;
    }

    nextUrl = nextHref && recordCount === OPERATIONS_PAGE_LIMIT ? nextHref : null;
  }

  return { candidates, incomplete };
}

interface HorizonAccountForSponsorship {
  sponsor?: string;
  subentry_count: number;
  num_sponsoring?: number;
  num_sponsored?: number;
  balances: Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance?: string;
    sponsor?: string;
    selling_liabilities?: string;
  }>;
  signers: Array<{ key: string; sponsor?: string }>;
  // name -> base64 value, every data entry the account currently holds. Horizon's main
  // account resource lists all of them for free (no per-entry sponsor here, only the
  // key set) - used to derive the FULL set of data-entry names to check the sponsor of,
  // not just the ones a historical candidate happened to name.
  data?: Record<string, string>;
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
// Sweeps every entry kind unconditionally (trustlines/signers from the account resource
// directly, data-entry names from the same resource's `data` field then a per-key sponsor
// lookup, offers via the owner's full current offer list) rather than only checking the
// keys a historical candidate happened to name - a wrapped operation inside someone
// else's sponsorship bracket may never have recorded an explicit `sponsor` field, and
// this is the only way to still catch that entry once the owner is fetched for any reason.
export async function fetchOwnerLiveState(
  owner: string,
  network: Network
): Promise<OwnerLiveState> {
  const base = PATH_ROUTING_API_URLS[network];
  const empty: OwnerLiveState = {
    accountSponsor: null,
    trustlineSponsors: {},
    signerSponsors: {},
    offerSponsors: {},
    dataSponsors: {},
    fetchFailed: true,
    reserve: null,
  };
  if (!base) return empty;

  try {
    const accountRes = await fetchWithTimeout(`${base}/accounts/${owner}`);
    if (accountRes.status === 404) {
      // The owner account no longer exists (merged away) - a normal terminal state and
      // unambiguous proof it holds nothing we still sponsor. Same distinction the
      // per-key data read below already makes: 404 is an answer, not a failure. There is
      // no reserve left to check for an account that no longer exists.
      return { ...empty, fetchFailed: false, reserve: null };
    }
    if (!accountRes.ok) return empty;
    const account = (await accountRes.json()) as HorizonAccountForSponsorship;

    const nativeBalanceRecord = account.balances.find((b) => b.asset_type === "native");
    const reserve = {
      balanceLumens: nativeBalanceRecord?.balance ?? "0",
      numSubEntries: account.subentry_count,
      numSponsoring: account.num_sponsoring ?? 0,
      numSponsored: account.num_sponsored ?? 0,
      sellingLiabilities: nativeBalanceRecord?.selling_liabilities ?? "0",
    };

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
    for (const key of Object.keys(account.data ?? {})) {
      try {
        // Data-entry names are arbitrary strings and can contain "/", "#", "?", spaces,
        // etc. - encode, or such a name silently truncates the path and queries a
        // different key entirely (a wrong-inclusion risk, not just a missed one).
        const dataRes = await fetchWithTimeout(
          `${base}/accounts/${owner}/data/${encodeURIComponent(key)}`
        );
        if (dataRes.status === 404) {
          // Genuine "this data entry doesn't exist (or isn't sponsored)" - null is correct.
          dataSponsors[key] = null;
        } else if (!dataRes.ok) {
          // Any other non-OK (429/500/503/...) is an unknown state, not a confirmed
          // "not sponsored" - must not be silently recorded as null.
          return {
            ...empty,
            accountSponsor: account.sponsor ?? null,
            trustlineSponsors,
            signerSponsors,
            fetchFailed: true,
            reserve: null,
          };
        } else {
          dataSponsors[key] = ((await dataRes.json()).sponsor ?? null) as string | null;
        }
      } catch {
        return {
          ...empty,
          accountSponsor: account.sponsor ?? null,
          trustlineSponsors,
          signerSponsors,
          fetchFailed: true,
          reserve: null,
        };
      }
    }

    // Always fetched, unconditionally: Horizon's main account resource never exposes an
    // owner's open offers, so this is the only way to sweep them, and gating it on a
    // historical "offer candidate" (as an earlier version of this function did) would
    // recreate exactly the wrapped-operation blind spot described in the function comment.
    const offerSponsors: Record<string, string | null> = {};
    let offersFetchFailed = false;
    {
      let nextUrl: string | null = `${base}/accounts/${owner}/offers?limit=200`;
      while (nextUrl) {
        let res: Response;
        try {
          res = await fetchWithTimeout(nextUrl);
        } catch {
          offersFetchFailed = true;
          break;
        }
        if (!res.ok) {
          offersFetchFailed = true;
          break;
        }
        const page = (await res.json()) as HorizonOffersPage;
        const records = page._embedded?.records ?? [];
        for (const o of records) offerSponsors[String(o.id)] = o.sponsor ?? null;
        const nextHref = page._links?.next?.href;
        nextUrl = nextHref && records.length === 200 ? nextHref : null;
      }
    }

    if (offersFetchFailed) {
      // Partial offer data can't be trusted either way - same "unknown, don't guess"
      // rule as the data-entry non-OK case above.
      return {
        ...empty,
        accountSponsor: account.sponsor ?? null,
        trustlineSponsors,
        signerSponsors,
        dataSponsors,
        fetchFailed: true,
        reserve: null,
      };
    }

    return {
      accountSponsor: account.sponsor ?? null,
      trustlineSponsors,
      signerSponsors,
      offerSponsors,
      dataSponsors,
      fetchFailed: false,
      reserve,
    };
  } catch {
    return empty;
  }
}

/**
 * Fan out `fetchOwnerLiveState` over a list of owners in bounded batches rather than one
 * unbounded Promise.all - a sponsor of many accounts must not self-inflict rate limiting,
 * and fetchWithTimeout already bounds how long any single hung connection can stall.
 * Shared by enumerateSponsoredEntriesUnguarded and assessSponsorshipAffordability, the two
 * call sites that fan out this same per-owner read over an owner list.
 */
export async function fetchOwnerLiveStatesBounded(
  owners: string[],
  network: Network
): Promise<Map<string, OwnerLiveState>> {
  const liveStateEntries: Array<[string, OwnerLiveState]> = [];
  for (let i = 0; i < owners.length; i += OWNER_FETCH_CONCURRENCY) {
    const batch = owners.slice(i, i + OWNER_FETCH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(
        async (owner): Promise<[string, OwnerLiveState]> => [
          owner,
          await fetchOwnerLiveState(owner, network),
        ]
      )
    );
    liveStateEntries.push(...batchResults);
  }
  return new Map(liveStateEntries);
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
): Promise<{
  entries: SponsoredEntry[];
  claimantCounts: Map<string, number>;
  incomplete: boolean;
}> {
  const base = PATH_ROUTING_API_URLS[network];
  const claimantCounts = new Map<string, number>();
  if (!base) return { entries: [], claimantCounts, incomplete: true };

  const entries: SponsoredEntry[] = [];
  let incomplete = false;
  let nextUrl: string | null =
    `${base}/claimable_balances?sponsor=${address}&limit=${CB_PAGE_LIMIT}`;

  while (nextUrl && entries.length < CB_MAX_TOTAL) {
    // As in discoverSponsorshipCandidates: parsing and iteration live inside the try so a
    // malformed body degrades to "incomplete" instead of throwing out of the account read.
    let recordCount = 0;
    let nextHref: string | undefined;
    try {
      const res = await fetchWithTimeout(nextUrl);
      if (!res.ok) {
        incomplete = true;
        break;
      }

      const page = (await res.json()) as HorizonClaimableBalancesPage;
      const records = page?._embedded?.records ?? [];
      recordCount = records.length;

      // Defensive filter: trust the server-side ?sponsor= scoping, but never rely on it
      // exclusively - each record carries its own sponsor field too.
      for (const b of records) {
        if (b.sponsor !== address) continue;
        entries.push({ kind: "claimable_balance", balanceId: b.id });
        // A claimable balance costs its sponsor one base reserve per claimant, so the
        // reserve cross-check downstream needs this count - it is not derivable from the
        // SponsoredEntry shape.
        claimantCounts.set(b.id, b.claimants?.length ?? 1);
      }

      nextHref = page?._links?.next?.href;
    } catch {
      incomplete = true;
      break;
    }

    nextUrl = nextHref && recordCount === CB_PAGE_LIMIT ? nextHref : null;
  }
  if (nextUrl) incomplete = true; // hit CB_MAX_TOTAL with more pages remaining

  return { entries, claimantCounts, incomplete };
}

/**
 * @param numSponsoringKnown whether `numSponsoring` came from a read that actually
 * succeeded. A defaulted-to-zero `numSponsoring` is NOT ground truth: trusting it would
 * turn a failed read into a confident "this account sponsors nothing", which is exactly
 * the false negative this enumeration exists to prevent. When false, enumeration still
 * runs but the result is always reported as incomplete.
 */
export async function enumerateSponsoredEntries(
  address: string,
  network: Network,
  numSponsoring: number,
  numSponsoringKnown: boolean
): Promise<{ sponsoredEntries: SponsoredEntry[]; sponsorshipEnumerationIncomplete: boolean }> {
  // A trustworthy zero is a complete answer on its own, and it covers the large majority
  // of real accounts. Skipping the I/O here keeps every close-flow endpoint that reads
  // account state off the operations-history/claimable-balance fetch path entirely.
  // Deliberately gated on numSponsoringKnown: never skip real work on an untrusted zero.
  if (numSponsoringKnown && numSponsoring === 0) {
    return { sponsoredEntries: [], sponsorshipEnumerationIncomplete: false };
  }

  try {
    return await enumerateSponsoredEntriesUnguarded(
      address,
      network,
      numSponsoring,
      numSponsoringKnown
    );
  } catch (err) {
    // Last-resort backstop: this module is embedded in the account read that every close
    // endpoint depends on, so a bug or an unforeseen response shape here must degrade to
    // an honest "incomplete", never take down analyze/plan/transactions.
    if (process.env.NODE_ENV !== "production") {
      logger.warn("enumeration failed, reporting incomplete:", err);
    }
    return { sponsoredEntries: [], sponsorshipEnumerationIncomplete: true };
  }
}

async function enumerateSponsoredEntriesUnguarded(
  address: string,
  network: Network,
  numSponsoring: number,
  numSponsoringKnown: boolean
): Promise<{ sponsoredEntries: SponsoredEntry[]; sponsorshipEnumerationIncomplete: boolean }> {
  const [{ candidates, incomplete: discoveryIncomplete }, cbResult] = await Promise.all([
    discoverSponsorshipCandidates(address, network),
    fetchClaimableBalancesBySponsor(address, network),
  ]);

  const owners = new Set<string>();
  for (const c of candidates) owners.add(c.owner);

  const liveStateByOwner = await fetchOwnerLiveStatesBounded(Array.from(owners), network);

  const reconciled = reconcileSponsoredEntries(
    address,
    candidates,
    liveStateByOwner,
    cbResult.entries,
    discoveryIncomplete,
    cbResult.incomplete,
    numSponsoring,
    cbResult.claimantCounts
  );

  return {
    sponsoredEntries: reconciled.sponsoredEntries,
    // An untrustworthy numSponsoring disables the reserve cross-check that is the only
    // backstop against a silently-truncated enumeration, so the result can never be
    // reported as complete no matter what enumeration turned up.
    sponsorshipEnumerationIncomplete:
      reconciled.sponsorshipEnumerationIncomplete || !numSponsoringKnown,
  };
}
