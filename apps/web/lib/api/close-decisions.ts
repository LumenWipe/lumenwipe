import type { AssetDisposition, ClaimableBalanceSelection } from "@/types/plan";
import type { DecisionAnswer } from "@lumenwipe/sdk";

/** Stable decision id for a per-asset disposition. Must match the API's `assetDecisionId`. */
function assetDecisionId(asset: string): string {
  return `asset:${asset.replace(":", "-")}`;
}

/** Stable decision id for a claimable-balance selection. Must match the API's
 *  `claimableBalanceDecisionId`. */
function claimableBalanceDecisionId(balanceId: string): string {
  return `claim:${balanceId}`;
}

/** Must match the API's `DESTINATION_DECISION_ID` / `DESTINATION_ACK_CHOICE`. Drift fails
 *  loud: the API answers an unacknowledged destination with 422. */
const DESTINATION_DECISION_ID = "destination:unrecognized";
const DESTINATION_ACK_CHOICE = "i_control_this_address";

/**
 * Maps the store's recorded acknowledgement into the `DecisionAnswer[]` the API expects for a
 * destination its exchange registry does not recognize.
 *
 * The acknowledgement is stored as the address it was given for, not as a boolean, so this can
 * refuse to carry it over to a different destination: confirming "I control address A" says
 * nothing about address B. A mismatch emits nothing, and the API then refuses the build.
 */
export function destinationAcknowledgementToDecisions(
  acknowledgedFor: string | null,
  destination: string | null
): DecisionAnswer[] {
  if (!destination || acknowledgedFor !== destination) return [];
  return [{ id: DESTINATION_DECISION_ID, choice: DESTINATION_ACK_CHOICE }];
}

/**
 * Maps the store's per-asset dispositions (convert to XLM / return to issuer) into the
 * `DecisionAnswer[]` the API's close endpoints expect. The decision id and choice strings
 * must match the API's `deriveDecisionPoints`/`resolveDispositions` contract exactly.
 */
export function dispositionsToDecisions(
  dispositions: Record<string, AssetDisposition>
): DecisionAnswer[] {
  return Object.entries(dispositions).map(([asset, disposition]) => ({
    id: assetDecisionId(asset),
    choice: disposition === "convert" ? "convert_to_xlm" : "return_to_issuer",
  }));
}

/**
 * Maps the store's per-claimable-balance selections into the `DecisionAnswer[]` the API's
 * close endpoints expect. The decision id and choice strings must match the API's
 * `deriveClaimableBalanceDecisionPoints`/`resolveClaimableBalanceSelections` contract exactly.
 */
export function claimableSelectionsToDecisions(
  selections: Record<string, ClaimableBalanceSelection>
): DecisionAnswer[] {
  return Object.entries(selections).map(([balanceId, selection]) => ({
    id: claimableBalanceDecisionId(balanceId),
    choice: selection,
  }));
}
