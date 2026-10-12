import type { PlanBlocker } from "@lumenwipe/types";
import type { IssuanceSummary } from "@/lib/close-api/issuance-preflight";

export const ISSUER_SUPPLY_BLOCKER_CODE = "issuer_supply_not_acknowledged";

export interface IssuanceBlocker extends PlanBlocker {
  code: typeof ISSUER_SUPPLY_BLOCKER_CODE;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The blocker for a closing account whose own assets are still held. Shared by
 * `buildAccountPlan` and `buildCloseTransactions`, so the plan and the build refuse the same
 * state until the caller has acknowledged it.
 */
export function assessIssuanceBlockers(
  issuance: IssuanceSummary | null,
  acknowledged: boolean
): IssuanceBlocker[] {
  if (!issuance || acknowledged) return [];
  const { assetCount, holderCount } = issuance;
  return [
    {
      code: ISSUER_SUPPLY_BLOCKER_CODE,
      message:
        `This account issued ${plural(assetCount, "asset", "assets")} that ` +
        `${assetCount === 1 ? "is" : "are"} still held in ${plural(holderCount, "trustline", "trustlines")} ` +
        `or other holdings. Merging this account leaves those holders unable to redeem them. ` +
        `Acknowledge this to continue.`,
    },
  ];
}
