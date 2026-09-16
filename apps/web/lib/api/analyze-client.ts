import type { PlanResponse } from "@lumenwipe/sdk";
import type { AccountState } from "@/types/account";
import type { ClaimableBalanceSelection } from "@/types/plan";

/** The claim answers the analysis carries, keyed by claimable-balance id. */
export type ClaimAnswers = Record<string, ClaimableBalanceSelection>;

export interface AnalysisDeps {
  /** Reads the account. Rejects with the error the caller wants the user to see. */
  fetchAccount: () => Promise<AccountState>;
  /** Builds the destination-less plan for a set of claim answers. */
  fetchPlan: (answers: ClaimAnswers) => Promise<PlanResponse>;
  /** Refreshes the served exchange registry. The real loader degrades to its bundled floor
   *  instead of rejecting (lib/exchange-registry). */
  loadRegistry: () => Promise<unknown>;
  /** The claim answers held right now, as the plan should be asked for them. */
  readAnswers: () => ClaimAnswers;
  /** Publishes the account state to the store. */
  applyAccount: (account: AccountState) => void;
}

export interface Analysis {
  account: AccountState;
  plan: PlanResponse;
}

/**
 * Reads the account and builds its plan, both at once.
 *
 * The plan does not depend on the account response - the API re-reads live state itself - so
 * awaiting one before starting the other cost the user two full server-side account reads back
 * to back, with nothing on screen until both landed.
 *
 * The one thing the old order did buy was sending the plan the claim answers AFTER
 * `applyAccount` had pruned them down to the balances the account still holds. That prune is
 * redundant for this request: the API resolves claim answers against its own live read
 * (`resolveClaimableBalanceSelections`, close.controller.ts) and silently skips every answer
 * whose balance it does not hold - the same set the client prune removes, and no error either
 * way. So the un-pruned answers produce the identical plan, and nothing has to be rebuilt.
 * The store prune still runs; it is what keeps the rest of the close from carrying a dead
 * answer. This function simply no longer has to wait for it.
 */
export async function loadAnalysis(deps: AnalysisDeps): Promise<Analysis> {
  const accountPromise = deps.fetchAccount();
  // A plan rejection must not go unhandled while the account read is still in flight, and must
  // never replace the account's own error: the account is what the page cannot render without.
  const planOutcome = deps.fetchPlan(deps.readAnswers()).then(
    (plan) => ({ ok: true as const, plan }),
    (error: unknown) => ({ ok: false as const, error })
  );
  const registryDone = deps.loadRegistry().catch(() => undefined);

  const account = await accountPromise;
  deps.applyAccount(account);
  // Awaited before handing back, as it was when it sat between the two fetches: verify() reads
  // the registry synchronously at signing time and cannot wait for it then.
  await registryDone;

  const outcome = await planOutcome;
  if (!outcome.ok) throw outcome.error;
  return { account, plan: outcome.plan };
}
