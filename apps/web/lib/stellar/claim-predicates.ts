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

/**
 * Plain-language description of a claim predicate, for surfacing next to a claimable-balance
 * decision. Returns null for the unconditional case (nothing worth saying).
 */
export function describeClaimPredicate(predicate: ClaimPredicate): string | null {
  switch (predicate.type) {
    case "unconditional":
      return null;
    case "before_absolute_time":
      return `Claimable until ${new Date(Number(predicate.absBeforeEpoch) * 1000).toLocaleDateString()}.`;
    case "before_relative_time":
      return `Claimable until ${new Date(Number(predicate.deadlineEpoch) * 1000).toLocaleDateString()}.`;
    case "and":
    case "or": {
      const parts = predicate.predicates.map(describeClaimPredicate).filter((p): p is string => p !== null);
      if (parts.length === 0) return null;
      return parts.join(predicate.type === "and" ? " and " : " or ");
    }
    case "not":
      return "This balance has a claim condition beyond a simple deadline; verify it before proceeding.";
  }
}
