import type { ClaimPredicate } from "@/types/account";

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
