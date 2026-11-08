import type { Network } from "@/config/networks";
import { readAccount } from "@/lib/api/analyze-client";
import { fetchClosePlan } from "@/lib/api/close-client";
import { closeDecisions } from "@/lib/api/close-decisions";
import {
  apiStepsToPlannedSteps,
  decisionPointsToClaimableBalances,
  decisionPointsToConversions,
  planFeeStroopsOf,
  planTransactionCountOf,
  planTransactionsOf,
} from "@/lib/api/plan-adapters";
import { expectedReceive } from "@/lib/plan/expected-receive";
import {
  comparePlans,
  heldToStoredFloors,
  isComparable,
  signatureOf,
  type PlanChange,
  type PlanSignature,
} from "@/lib/plan/plan-freshness";
import { proceedError } from "@/lib/plan/resolvable-blockers";
import {
  PLAN_FEES_UNREADABLE,
  PLAN_FLOOR_MISSING,
  PLAN_HOLDINGS_CHANGED,
  PLAN_NEEDS_ANSWERS,
  PLAN_NOT_COMPARABLE,
  PLAN_REFRESH_FAILED,
  PLAN_REVIEW_LEFT,
} from "@/lib/utils/user-error";
import type { PlanResponse } from "@lumenwipe/sdk";
import type { AccountState } from "@/types/account";
import { routeForPhase } from "@/lib/journey/route-for-phase";
import { useDemolishStore } from "@/store/demolish";

export type RefreshOutcome =
  /** Nothing material changed: the fresh hash, steps and count are installed, the consent holds. */
  | { kind: "unchanged" }
  /** The fresh plan is installed, and the consent must be given again for it. */
  | { kind: "changed"; changes: PlanChange[] }
  /** The plan cannot be consented to here: an answer is missing or no longer fits the account. */
  | { kind: "needs-analyze"; message: string }
  /** No usable fresh plan: the reviewed one stays, and nothing moves on. */
  | { kind: "failed"; message: string };

const PLAN_HASH = /^[0-9a-f]{64}$/;

/** The answers a plan is requested with, apart from the tokens the account read finds. */
function answersOf(
  state: ReturnType<typeof useDemolishStore.getState>,
  source: string,
  destination: string
): string {
  return JSON.stringify(closeDecisions(state, source, destination, []));
}

/**
 * Plans the reviewed close again with the same answers, through the one path a plan is made by,
 * and compares it with the plan the user reviewed. Nothing is persisted: only the in-memory plan
 * is replaced, and only when the review it was fetched for is still the one on screen.
 */
export async function refreshReviewedPlan(
  network: Network,
  signal?: AbortSignal
): Promise<RefreshOutcome> {
  const start = useDemolishStore.getState();
  const { sourceAddress: source, destinationAddress: destination, planSignature } = start;
  if (!source || !destination) return { kind: "failed", message: PLAN_REFRESH_FAILED };
  // What the review was of: the answers it was consented to with, in the close it belongs to.
  const answers = answersOf(start, source, destination);
  const epoch = start.closeEpoch;

  let account;
  let plan;
  try {
    // The account is read again too: the net estimate depends on its balance, which the plan
    // response does not carry and its hash does not cover.
    account = await readAccount(network, source, signal);
    const tokens = (account.sorobanTokens?.tokens ?? []).map((t) => t.contract);
    plan = await fetchClosePlan(
      { source, destination, decisions: closeDecisions(start, source, destination, tokens) },
      network,
      signal
    );
  } catch {
    return { kind: "failed", message: PLAN_REFRESH_FAILED };
  }

  const now = useDemolishStore.getState();
  // Another plan was installed, an answer changed, or the review was left, while this one was
  // being fetched: it answers a review that is no longer the one on screen.
  if (
    now.planSignature !== planSignature ||
    now.closeEpoch !== epoch ||
    routeForPhase(now.phase) !== "review" ||
    now.sourceAddress !== source ||
    now.destinationAddress !== destination ||
    answersOf(now, source, destination) !== answers
  ) {
    return { kind: "failed", message: PLAN_REVIEW_LEFT };
  }

  // A response of an unexpected shape is a failed refresh, never a half-installed plan: every
  // read of it happens before anything is installed.
  try {
    return install(now, account, plan, planSignature);
  } catch {
    return { kind: "failed", message: PLAN_REFRESH_FAILED };
  }
}

function install(
  now: ReturnType<typeof useDemolishStore.getState>,
  account: AccountState,
  plan: PlanResponse,
  planSignature: PlanSignature | null
): RefreshOutcome {
  // Never installed as missing: the build would then be sent without the hash it is held to.
  if (typeof plan.planHash !== "string" || !PLAN_HASH.test(plan.planHash)) {
    return { kind: "failed", message: PLAN_REFRESH_FAILED };
  }
  // The same two gates the analyze page's proceed applies to the plan it fetches.
  const blocked = proceedError(plan.blockers);
  if (blocked !== null) return { kind: "needs-analyze", message: blocked };
  if (plan.status === "needs_decisions") {
    return { kind: "needs-analyze", message: PLAN_NEEDS_ANSWERS };
  }

  // Each of these holds on every refresh until something changes on /analyze, so none of them is
  // a change to consent to again here: that would ask for the same consent forever.
  const fresh = signatureOf(plan, account, now);
  if (planSignature === null) return { kind: "needs-analyze", message: PLAN_NOT_COMPARABLE };
  // Answers are kept per holding: installing an account that lost or gained one would drop or
  // miss some, and the plan just fetched was built with them.
  if (fresh.holdings !== planSignature.holdings) {
    return { kind: "needs-analyze", message: PLAN_HOLDINGS_CHANGED };
  }
  // The least a swap delivers is the floor its answer carries; without one it is unknown.
  if (fresh.unflooredConverts.length > 0) {
    return { kind: "needs-analyze", message: PLAN_FLOOR_MISSING };
  }
  if (!isComparable(fresh)) return { kind: "failed", message: PLAN_FEES_UNREADABLE };
  const changes = comparePlans(planSignature, fresh);

  const steps = apiStepsToPlannedSteps(plan);
  const count = planTransactionCountOf(plan);
  const fee = planFeeStroopsOf(plan);
  // Counted at the stored floors, as the build is: the fresh quotes may promise more.
  const expected =
    fee === null
      ? null
      : heldToStoredFloors(
          expectedReceive({
            account,
            planFeeStroops: fee,
            relayForwardUncounted: false,
            conversions: decisionPointsToConversions(plan),
            dispositions: now.assetDispositions,
            claims: decisionPointsToClaimableBalances(plan),
            claimSelections: now.claimableBalanceSelections,
          }),
          now
        );

  // The holdings are the same ones, so installing this account keeps every answer, and the
  // screen describes the account the build will read.
  now.setAccountState(account);
  // The build is checked against the hash of the plan it was answered from: the fresh one.
  now.setPlan(steps, plan.planHash, count, fresh, planTransactionsOf(plan));
  if (changes.length === 0) {
    // The figure the user consented to stays as shown.
    return { kind: "unchanged" };
  }
  now.setExpectedReceive(expected);
  return { kind: "changed", changes };
}
