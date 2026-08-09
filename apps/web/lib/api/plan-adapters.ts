import type { PlanResponse } from "@lumenwipe/sdk";
import type { PlannedStep } from "@/types/plan";
import type { ClaimPredicate } from "@/types/account";

/**
 * Per-asset convertibility consumed by the analyze UI. Relocated here from the old
 * client-side builder (fast-path) now that the plan comes from the API.
 */
export interface AssetConvertibility {
  asset: string;
  code: string;
  balance: string;
  convertible: boolean;
}

/**
 * Derives the analyze-page convertibility list from the API plan's asset decision points.
 * The API only offers the "convert to XLM" choice when a conversion route exists, so the
 * presence of that option is exactly the convertibility signal the UI needs.
 */
export function decisionPointsToConversions(plan: PlanResponse): AssetConvertibility[] {
  return plan.decisionPoints
    .filter((dp) => dp.type === "asset_disposition")
    .map((dp) => {
      const asset = String(dp.subject.asset ?? "");
      return {
        asset,
        code: asset.includes(":") ? asset.split(":")[0] : asset,
        balance: String(dp.subject.balance ?? "0"),
        convertible: dp.options.some((o) => o.id === "convert_to_xlm"),
      };
    });
}

/** Per-claimable-balance decision consumed by the analyze UI. */
export interface ClaimableBalanceDecision {
  balanceId: string;
  asset: string;
  code: string;
  amount: string;
  /** Claimable now (native, or an authorized trustline exists) vs. needs remediation. */
  currentlyClaimable: boolean;
  /** This account's own claim predicate on the balance. */
  predicate: ClaimPredicate;
}

const UNCONDITIONAL: ClaimPredicate = { type: "unconditional" };

/**
 * Derives the analyze-page claimable-balance decision list from the API plan's
 * `claimable_balance` decision points.
 */
export function decisionPointsToClaimableBalances(plan: PlanResponse): ClaimableBalanceDecision[] {
  return plan.decisionPoints
    .filter((dp) => dp.type === "claimable_balance")
    .map((dp) => {
      const asset = String(dp.subject.asset ?? "");
      return {
        balanceId: String(dp.subject.balanceId ?? ""),
        asset,
        code: asset === "native" ? "XLM" : asset.split(":")[0],
        amount: String(dp.subject.amount ?? "0"),
        currentlyClaimable: Boolean(dp.subject.currentlyClaimable),
        predicate: (dp.subject.predicate as ClaimPredicate | undefined) ?? UNCONDITIONAL,
      };
    });
}

/**
 * Normalizes the API plan's serialized steps into full `PlannedStep`s for the store/sidebar,
 * adding the client-only execution fields (status, txXdr, txHash, error) the API omits.
 */
export function apiStepsToPlannedSteps(plan: PlanResponse): PlannedStep[] {
  return (plan.steps as Partial<PlannedStep>[]).map((s, i) => ({
    index: s.index ?? i,
    type: s.type as PlannedStep["type"],
    title: s.title ?? "",
    description: s.description ?? "",
    operationCount: s.operationCount ?? 0,
    estimatedFeeLumens: s.estimatedFeeLumens ?? "0",
    affectedAsset: s.affectedAsset,
    txXdr: null,
    status: "pending",
    txHash: null,
    error: null,
  }));
}
