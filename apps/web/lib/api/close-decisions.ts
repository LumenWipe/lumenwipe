import type {
  AssetDisposition,
  ClaimableBalanceSelection,
  TransferDestinations,
} from "@/types/plan";
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

/** Stable decision id for the unrecognized-destination acknowledgement. Must match the API's
 *  `destinationDecisionId`. Scoped to the address so the answer cannot be replayed for a
 *  different destination - the API enforces the same scoping. */
function destinationDecisionId(address: string): string {
  return `destination:${address}`;
}

/** Must match the API's `DESTINATION_ACK_CHOICE`. Drift fails loud: the API answers an
 *  unacknowledged destination with 422. */
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
  return [{ id: destinationDecisionId(destination), choice: DESTINATION_ACK_CHOICE }];
}

/** Must match the API's `TRANSFER_CHOICE`. */
const TRANSFER_CHOICE = "transfer_to_account";

/**
 * Maps the store's per-asset dispositions into the `DecisionAnswer[]` the API's close endpoints
 * expect. The decision id and choice strings must match the API's
 * `deriveDecisionPoints`/`resolveDispositions` contract exactly.
 *
 * A `switch`, not a ternary. This used to read `disposition === "convert" ? ... :
 * "return_to_issuer"`, which quietly mapped anything that was not `convert` onto burning the
 * asset - so the moment `transfer` existed as a disposition, choosing it would have sent the
 * balance to its issuer instead of to the user's account, with no error anywhere. The `never`
 * makes a future disposition a compile error rather than a silent burn.
 *
 * The transfer destination travels on the answer it belongs to, so it cannot be detached from
 * the asset it was chosen for. An asset marked `transfer` with no destination emits no
 * destination, and the API refuses the build rather than defaulting - which is the intended
 * outcome, since every default available destroys the balance.
 */
export function dispositionsToDecisions(
  dispositions: Record<string, AssetDisposition>,
  transferDestinations: TransferDestinations = {}
): DecisionAnswer[] {
  return Object.entries(dispositions).map(([asset, disposition]): DecisionAnswer => {
    const id = assetDecisionId(asset);
    switch (disposition) {
      case "convert":
        return { id, choice: "convert_to_xlm" };
      case "issuer":
        return { id, choice: "return_to_issuer" };
      case "transfer": {
        const destination = transferDestinations[asset];
        return destination
          ? { id, choice: TRANSFER_CHOICE, params: { destination } }
          : { id, choice: TRANSFER_CHOICE };
      }
      default: {
        const unhandled: never = disposition;
        throw new Error(`Unhandled asset disposition: ${String(unhandled)}`);
      }
    }
  });
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
