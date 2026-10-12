import type { AccountState, ClaimableBalance, ClaimPredicate } from "@lumenwipe/types";
import { CLAIM_PREDICATE_MARGIN_SECONDS } from "@/config/constants";

/**
 * Evaluates whether `claimant` could submit ClaimClaimableBalance right now under `predicate`.
 * `claimant` is not read by any branch below - no ClaimPredicate variant is claimant-dependent -
 * but is kept in the signature so call sites are self-documenting about which claimant's
 * predicate they're evaluating (matching the shape callers already have via `claimants[]`).
 */
export function isClaimableNow(predicate: ClaimPredicate, claimant: string, now: Date): boolean {
  const nowEpochSeconds = Math.floor(now.getTime() / 1000);

  switch (predicate.type) {
    case "unconditional":
      return true;
    case "and":
      return predicate.predicates.every((p) => isClaimableNow(p, claimant, now));
    case "or":
      return predicate.predicates.some((p) => isClaimableNow(p, claimant, now));
    case "not":
      return !isClaimableNow(predicate.predicate, claimant, now);
    case "before_absolute_time":
      return nowEpochSeconds < Number(predicate.absBeforeEpoch);
    case "before_relative_time":
      return nowEpochSeconds < Number(predicate.deadlineEpoch);
  }
}

function boundaries(predicate: ClaimPredicate): number[] {
  switch (predicate.type) {
    case "unconditional":
      return [];
    case "and":
    case "or":
      return predicate.predicates.flatMap(boundaries);
    case "not":
      return boundaries(predicate.predicate);
    case "before_absolute_time":
      return [Number(predicate.absBeforeEpoch)];
    case "before_relative_time":
      return [Number(predicate.deadlineEpoch)];
  }
}

function holdsAt(predicate: ClaimPredicate, epochSeconds: number): boolean {
  return isClaimableNow(predicate, "", new Date(epochSeconds * 1000));
}

/** The account's own predicate on a balance; absent means it cannot claim it at all. */
export function ownClaimPredicate(
  balance: ClaimableBalance,
  address: string
): ClaimPredicate | null {
  return balance.claimants.find((c) => c.destination === address)?.predicate ?? null;
}

/**
 * Whether the predicate holds from `evalEpoch` through the end of a transaction's validity
 * window. Checked at both ends because `not(before T)` must already hold now while
 * `before T` must still hold when the claim lands. An unknown ledger time only trusts an
 * unconditional predicate.
 */
export function predicateHoldsThroughWindow(
  predicate: ClaimPredicate,
  evalEpoch: number | null | undefined
): boolean {
  if (evalEpoch === null || evalEpoch === undefined) return predicate.type === "unconditional";
  return (
    holdsAt(predicate, evalEpoch) && holdsAt(predicate, evalEpoch + CLAIM_PREDICATE_MARGIN_SECONDS)
  );
}

/** The earliest moment after `evalEpoch` from which the predicate holds, or null if it never will. */
export function claimableFromEpoch(predicate: ClaimPredicate, evalEpoch: number): number | null {
  const later = [...new Set(boundaries(predicate))]
    .filter((t) => Number.isFinite(t) && t > evalEpoch)
    .sort((a, b) => a - b);
  return later.find((t) => holdsAt(predicate, t)) ?? null;
}

export type ClaimStatus = "claimable" | "needs_trustline" | "predicate_blocked";

/**
 * The one place that decides whether a claim could be submitted for this balance now. Plan,
 * decisions and the builder all call it. A closed predicate wins over a missing trustline:
 * adding a trustline cannot make such a balance claimable.
 */
export function claimStatus(
  balance: ClaimableBalance,
  account: Pick<AccountState, "address" | "trustlines">,
  evalEpoch: number | null | undefined
): ClaimStatus {
  const predicate = ownClaimPredicate(balance, account.address);
  if (predicate === null || !predicateHoldsThroughWindow(predicate, evalEpoch)) {
    return "predicate_blocked";
  }
  const assetUsable =
    balance.asset === "native" ||
    account.trustlines.some((tl) => tl.authorized && tl.asset === balance.asset);
  return assetUsable ? "claimable" : "needs_trustline";
}

export function isCurrentlyClaimable(
  balance: ClaimableBalance,
  account: Pick<AccountState, "address" | "trustlines">,
  evalEpoch: number | null | undefined
): boolean {
  return claimStatus(balance, account, evalEpoch) === "claimable";
}

export function predicateBlockedNote(
  evalEpoch: number | null | undefined,
  claimableFrom: number | null
): string {
  if (evalEpoch === null || evalEpoch === undefined) {
    return "Whether this balance can be claimed could not be confirmed right now; try again.";
  }
  if (claimableFrom === null) {
    return "This balance can no longer be claimed by this account.";
  }
  const when = new Date(claimableFrom * 1000).toISOString().slice(0, 16).replace("T", " ");
  return `This balance becomes claimable from ${when} UTC, so it cannot be claimed in this close.`;
}

export const CLAIM_ANSWER_STALE_MESSAGE =
  "A claimable balance on this account can no longer be handled the way it was answered, " +
  "because its claim window or its trustline changed. Review the plan again before continuing.";

/**
 * Whether a per-balance answer is valid for what the account can do with the balance now.
 * `add_trustline_then_claim` stays valid once the trustline exists: answers are re-sent every
 * round, and by a later batch it is a plain claim.
 */
export function selectionFitsStatus(selection: string, status: ClaimStatus): boolean {
  if (selection === "forfeit") return true;
  if (selection === "claim") return status === "claimable";
  return (
    selection === "add_trustline_then_claim" &&
    (status === "needs_trustline" || status === "claimable")
  );
}
