import type { PlanResponse } from "@lumenwipe/sdk";
import type { AccountState } from "@/types/account";
import type { ClaimableBalanceSelection } from "@/types/plan";
import { claimAnswersKey } from "@/lib/api/close-decisions";

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
  /** The claim answers held right now. Read once up front and again after `applyAccount`. */
  readAnswers: () => ClaimAnswers;
  /** Publishes the account state. Pruning the stored claim answers is its side effect. */
  applyAccount: (account: AccountState) => void;
}

export interface Analysis {
  account: AccountState;
  plan: PlanResponse;
  /** True when the plan had to be rebuilt because applying the account changed the answers. */
  replanned: boolean;
}

/**
 * Reads the account and builds its plan, both at once.
 *
 * The plan does not depend on the account response - the API re-reads live state itself - so
 * running them one after the other cost the user two full round trips of the same server-side
 * account read. They are ~5s each in production, and the page shows nothing until both land.
 *
 * What the sequence DID buy is the reason this is not a bare `Promise.all`: `applyAccount`
 * prunes the stored claim answers down to the balances the account still holds, and the old
 * order meant the plan was always asked for with the pruned set. Asking in parallel means
 * asking with the un-pruned set, which on a re-analyze of a changed account (or a different
 * account entirely) carries answers about balances that are gone. So the answers the plan was
 * asked with are compared against the ones that survive, and on the rare occasion they differ
 * the in-flight plan is discarded and rebuilt - paying the old cost only in the case that
 * actually needed it, never on a first load or an unchanged re-scan.
 */
export async function loadAnalysis(deps: AnalysisDeps): Promise<Analysis> {
  const sentAnswers = deps.readAnswers();
  const accountPromise = deps.fetchAccount();
  // A plan rejection must not go unhandled while the account read is still in flight, and must
  // never replace the account's own error: the account is what the page cannot render without.
  const planOutcome = deps.fetchPlan(sentAnswers).then(
    (plan) => ({ ok: true as const, plan }),
    (error: unknown) => ({ ok: false as const, error })
  );
  const registryDone = deps.loadRegistry().catch(() => undefined);

  const account = await accountPromise;
  deps.applyAccount(account);
  // Awaited before handing back, as it was when it sat between the two fetches: verify() reads
  // the registry synchronously at signing time and cannot wait for it then.
  await registryDone;

  const answers = deps.readAnswers();
  if (claimAnswersKey(answers) !== claimAnswersKey(sentAnswers)) {
    await planOutcome;
    return { account, plan: await deps.fetchPlan(answers), replanned: true };
  }

  const outcome = await planOutcome;
  if (!outcome.ok) throw outcome.error;
  return { account, plan: outcome.plan, replanned: false };
}
