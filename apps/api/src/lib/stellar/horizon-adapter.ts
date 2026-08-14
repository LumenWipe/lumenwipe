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
export function parseClaimPredicate(
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
    const parsed = Date.parse(b.last_modified_time);
    if (!Number.isFinite(parsed)) {
      // This anchors every `rel_before` predicate. A NaN would resolve relative deadlines to
      // NaN, so a balance that is claimable right now could be presented as not claimable and
      // left behind, unreachable once the account is merged.
      throw new Error(
        `Claimable balance ${b.id} has an unusable last_modified_time ` +
          `(${String(b.last_modified_time)}); claim predicates cannot be evaluated against it.`
      );
    }
    const createdAtEpochSeconds = Math.floor(parsed / 1000);
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
