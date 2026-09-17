import type { ClaimableBalance, ClaimPredicate, OpenOffer } from "@lumenwipe/types";
import { horizonAssetToString } from "@/lib/utils/assets";
import { horizonPaginate, type HorizonDeps } from "./horizon-http";

interface HorizonOffer {
  id: string | number;
  selling: { asset_type: string; asset_code?: string; asset_issuer?: string };
  buying: { asset_type: string; asset_code?: string; asset_issuer?: string };
  amount: string;
  price: string;
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

const PAGE_LIMIT = 200;
const MAX_TOTAL = 1000;

// Horizon has no separate "created" timestamp for a claimable balance; last_modified_time
// is the creation time for the (overwhelmingly common) case of a balance nothing has
// touched since it was created, so it's used as the anchor for rel_before predicates.
//
// `createdAtEpochSeconds` is null when Horizon itself has none to give: mainnet SDF Horizon
// reports `last_modified_time: null` for a balance created before its retention window (its
// own ledger for that height already answers 410 Gone). unconditional and abs_before/
// abs_before_epoch predicates never need this anchor, so a null one only becomes a problem
// right here, for the one predicate shape that actually depends on it - not for every old
// balance on sight (confirmed live: four real mainnet accounts' spam-airdrop claimable
// balances, all unconditional/abs_before, tripped this before the anchor check moved here).
export function parseClaimPredicate(
  raw: HorizonClaimPredicate,
  createdAtEpochSeconds: number | null
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
    // A "NaN" deadline makes every comparison false downstream, so the client reads a
    // currently-claimable balance as unclaimable and the close leaves it behind, unreachable
    // after the merge. Refuse the read instead of encoding an unusable predicate.
    const epoch = Date.parse(raw.abs_before);
    if (!Number.isFinite(epoch)) {
      throw new Error(`Unparseable abs_before in a claim predicate: ${String(raw.abs_before)}`);
    }
    return { type: "before_absolute_time", absBeforeEpoch: String(Math.floor(epoch / 1000)) };
  }
  if (raw.rel_before !== undefined) {
    const relSeconds = Number(raw.rel_before);
    if (!Number.isFinite(relSeconds)) {
      throw new Error(`Unparseable rel_before in a claim predicate: ${String(raw.rel_before)}`);
    }
    if (createdAtEpochSeconds === null) {
      // The one case that genuinely cannot be evaluated: a NaN anchor would resolve this
      // deadline to NaN, so a balance that is claimable right now could read as unclaimable
      // and be left behind, unreachable once the account is merged. Refuse rather than guess.
      throw new Error(
        "A rel_before claim predicate has no creation time to anchor it against - Horizon " +
          "reported no usable last_modified_time for this balance."
      );
    }
    return {
      type: "before_relative_time",
      relBeforeSeconds: raw.rel_before,
      deadlineEpoch: String(createdAtEpochSeconds + relSeconds),
    };
  }
  return { type: "unconditional" };
}

/**
 * Fetches open DEX offers for an account.
 *
 * Errors propagate rather than yielding []: an offer is a sub-entry, and a silently empty
 * list would let a plan omit its removal and then fail the merge with op_has_sub_entries.
 * A short read still reaches the caller's sub-entry reconciliation, which is what turns
 * incomplete enumeration into a blocker.
 */
export async function fetchOffersFromAdapter(
  address: string,
  deps: HorizonDeps
): Promise<OpenOffer[]> {
  const records = await horizonPaginate<HorizonOffer>(
    `/accounts/${address}/offers?limit=${PAGE_LIMIT}`,
    deps,
    PAGE_LIMIT,
    MAX_TOTAL
  );
  return records.map((o) => ({
    id: String(o.id),
    selling: horizonAssetToString(o.selling),
    buying: horizonAssetToString(o.buying),
    amount: o.amount,
    price: o.price,
  }));
}

/**
 * Fetches claimable balances where `address` is a claimant.
 *
 * These do not count toward numSubEntries, so the reconciliation check cannot catch a short
 * read here - the consequence of missing one is a balance left permanently unreachable after
 * the merge rather than a failed transaction. Errors therefore propagate: an empty list must
 * mean "none exist", never "the read failed".
 */
export async function fetchClaimableBalancesForClaimant(
  address: string,
  deps: HorizonDeps
): Promise<ClaimableBalance[]> {
  const records = await horizonPaginate<HorizonClaimableBalance>(
    `/claimable_balances?claimant=${address}&limit=${PAGE_LIMIT}`,
    deps,
    PAGE_LIMIT,
    MAX_TOTAL
  );
  return records.map((b) => {
    // Null (not just unparseable) when Horizon's own retention window has dropped the ledger
    // this balance was created in - a real, observed mainnet state for old balances, not a
    // malformed response. Most predicates (unconditional, abs_before) never need this anchor,
    // so the failure is deferred to parseClaimPredicate, the one place that actually needs it.
    const parsed = Date.parse(b.last_modified_time);
    const createdAtEpochSeconds = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
    return {
      id: b.id,
      asset: b.asset,
      amount: b.amount,
      sponsor: b.sponsor ?? null,
      claimants: b.claimants.map((c) => ({
        destination: c.destination,
        predicate: parseClaimPredicate(c.predicate, createdAtEpochSeconds),
      })),
    };
  });
}
