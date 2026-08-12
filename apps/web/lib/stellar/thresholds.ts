import type { IntentOperation } from "@/types/close-api";
import type { AccountThresholds } from "@/types/account";

export type ThresholdCategory = "low" | "med" | "high";

const CATEGORY_RANK: Record<ThresholdCategory, number> = { low: 0, med: 1, high: 2 };

/**
 * Stellar's real per-operation threshold category (stellar-core's OperationFrame::
 * getThresholdLevel). SetOptions is the one conditional case: it only needs the account's high
 * threshold when it touches a signer, master weight, or any threshold field - every other
 * SetOptions field (home domain, flags, ...) needs only medium. ManageData does not override
 * getThresholdLevel() in stellar-core, so it inherits the medium default; ClaimClaimableBalance
 * does override it, returning low.
 */
export function operationThresholdCategory(op: IntentOperation): ThresholdCategory {
  switch (op.type) {
    case "claim_claimable_balance":
      return "low";
    case "account_merge":
      return "high";
    case "set_options":
      return op.signer !== null ||
        op.masterWeight !== null ||
        op.lowThreshold !== null ||
        op.medThreshold !== null ||
        op.highThreshold !== null
        ? "high"
        : "med";
    case "manage_data":
    case "payment":
    case "path_payment_strict_send":
    case "change_trust":
    case "manage_sell_offer":
    case "revoke_sponsorship":
      return "med";
    case "unknown":
      // Fail closed: an operation this app doesn't recognize must never be treated as
      // needing less signing weight than the account's strictest category.
      return "high";
  }
}

/**
 * The actual signing weight a transaction needs: the max threshold category across its
 * operations, resolved against the account's real thresholds. Never a single account-wide
 * number - Stellar's threshold categories are per-operation, per-transaction.
 */
export function requiredSignatureWeight(
  operations: IntentOperation[],
  thresholds: AccountThresholds
): number {
  const category = operations.reduce<ThresholdCategory>((max, op) => {
    const c = operationThresholdCategory(op);
    return CATEGORY_RANK[c] > CATEGORY_RANK[max] ? c : max;
  }, "low");
  return thresholds[category];
}
