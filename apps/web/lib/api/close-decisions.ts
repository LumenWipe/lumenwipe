import type {
  AssetDisposition,
  ClaimableBalanceSelection,
  TransferDestinations,
} from "@/types/plan";
import type { DecisionAnswer } from "@lumenwipe/sdk";
import type { AccountState } from "@/types/account";

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

/**
 * A stable key for a set of claim answers, for use as a React dependency.
 *
 * Identity is not usable here: `setAccountState` rebuilds `claimableBalanceSelections` through
 * `pruneClaimableSelections` on every account read, so the object is new even when no answer
 * changed. A dependency on it made the analyze page's fetch retrigger itself - fetch ->
 * setAccountState -> new reference -> new callback -> effect -> fetch - until the rate limiter
 * stopped it. Sorted so key order cannot make two equal answer sets look different.
 */
export function claimAnswersKey(selections: Record<string, ClaimableBalanceSelection>): string {
  return Object.entries(selections)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, choice]) => `${id}:${choice}`)
    .join("|");
}

/**
 * The per-asset transfers the user chose, with the amount floor verify() holds each payment to.
 *
 * The floor is what the account will hold when the payment runs: today's trustline balance plus
 * every claimable balance of the asset that this close will claim (currently claimable and not
 * forfeited, or explicitly remediated with a new trustline). Building it from trustlines alone
 * meant an asset arriving through a claim never produced an entry, and verify() rejected the
 * payment it had told the user about - after the trustline was added and the balance claimed.
 */
export function chosenTransfers(
  dispositions: Record<string, AssetDisposition>,
  destinations: Record<string, string>,
  accountState: AccountState | null,
  claimableBalanceSelections: Record<string, ClaimableBalanceSelection>
): Record<string, { destination: string; amount: string }> {
  const transfers: Record<string, { destination: string; amount: string }> = {};
  if (!accountState) return transfers;
  // Nullish fallbacks, not assumptions: this runs inside the close loop's error boundary, and
  // an account shape missing either array must degrade to "nothing claimed / nothing held"
  // rather than throw past the transfers the user did choose.
  const trustlines = accountState.trustlines ?? [];
  const claimableBalances = accountState.claimableBalances ?? [];

  const authorized = new Set(trustlines.filter((tl) => tl.authorized).map((tl) => tl.asset));
  const claimedPerAsset = new Map<string, number>();
  for (const b of claimableBalances) {
    if (b.asset === "native") continue;
    const selection = claimableBalanceSelections[b.id];
    const willClaim = authorized.has(b.asset)
      ? selection !== "forfeit"
      : selection === "add_trustline_then_claim";
    if (!willClaim) continue;
    claimedPerAsset.set(b.asset, (claimedPerAsset.get(b.asset) ?? 0) + parseFloat(b.amount));
  }

  for (const [asset, disposition] of Object.entries(dispositions)) {
    if (disposition !== "transfer") continue;
    const destination = destinations[asset];
    if (!destination) continue;
    const trustline = trustlines.find((tl) => tl.asset === asset);
    const floor = parseFloat(trustline?.balance ?? "0") + (claimedPerAsset.get(asset) ?? 0);
    if (floor <= 0) continue;
    transfers[asset] = { destination, amount: floor.toFixed(7) };
  }
  return transfers;
}
