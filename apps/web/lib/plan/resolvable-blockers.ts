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

/**
 * The error that stops "Begin execution", or null when nothing genuinely blocks.
 *
 * The proceed gate re-fetches the plan with the user's decisions, and that plan can carry two
 * very different kinds of blocker. A hard one (destination has no trustline, exchange deposit
 * address, sponsorship) must stop the flow with its message. An acknowledged forfeit is the
 * opposite: `claimable_balance_forfeited` exists BECAUSE the user answered - it is the audit
 * trail of a choice, already rendered as a warning beside the card - and treating it as
 * trapping walled off the close the moment anyone gave a balance up. Only the hard ones stop
 * the flow, and only their messages surface as the error.
 */
export function proceedError(blockers: PlanBlocker[]): string | null {
  const hard = hardBlockersOf(blockers);
  return hard.length > 0 ? hard.map((b) => b.message).join(" ") : null;
}
