import type { PlanBlocker } from "@/types/plan";

/**
 * Blocker codes the user can clear from the analyze screen itself.
 *
 * The API reports an unresolved claimable balance as a blocker AND offers the decision that
 * resolves it, which is the designed pattern - the plan stays auditable about what it chose not
 * to do. A client that treats every blocker as "this close cannot proceed" therefore hides the
 * very controls that would unblock it.
 *
 * This lived as a private predicate in PlanView while the analyze page used a bare
 * `blockers.length === 0`, and the two disagreeing is what made a real mainnet account
 * unclosable: 23 claimable-balance blockers emptied the asset list, so its 38 balances never
 * rendered a card, while `conversions.every(...)` on the resulting empty array reported every
 * asset resolved. The user could reach "Begin execution" and then be refused for decisions the
 * UI had never shown them.
 */
const RESOLVABLE_HERE = new Set(["claimable_balance_forfeited", "claimable_balance_unclaimable"]);

export function isResolvableHere(blocker: Pick<PlanBlocker, "code">): boolean {
  return blocker.code !== undefined && RESOLVABLE_HERE.has(blocker.code);
}

/** Blockers that genuinely stop the close, as opposed to ones the user can answer on this page. */
export function hardBlockersOf<T extends Pick<PlanBlocker, "code">>(blockers: T[]): T[] {
  return blockers.filter((b) => !isResolvableHere(b));
}
