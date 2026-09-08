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

/** A Soroban token is keyed by its contract (C...); a classic asset never starts that way. */
export function isTokenContract(assetOrContract: string): boolean {
  return /^C[A-Z2-7]{55}$/.test(assetOrContract);
}

/** Stable decision id for a Soroban token disposition. Must match the API's `tokenDecisionId`. */
function tokenDecisionId(contract: string): string {
  return `token:${contract}`;
}

/** Must match the API's `LEAVE_CHOICE`: the explicit acknowledgement that a token stays behind. */
const LEAVE_CHOICE = "acknowledge_residue";

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
  transferDestinations: TransferDestinations = {},
  tokenConversionFloors: Record<string, string> = {}
): DecisionAnswer[] {
  return Object.entries(dispositions).map(([asset, disposition]): DecisionAnswer => {
    const id = isTokenContract(asset) ? tokenDecisionId(asset) : assetDecisionId(asset);
    switch (disposition) {
      case "convert": {
        // A token's convert answer carries the floor the plan quoted, so the API can refuse a
        // route that drifted under it and the browser can hold the swap to it. Without a floor the
        // API refuses the answer, which is the intended outcome.
        const floor = isTokenContract(asset) ? tokenConversionFloors[asset] : undefined;
        return floor
          ? { id, choice: "convert_to_xlm", params: { minAmountOut: floor } }
          : { id, choice: "convert_to_xlm" };
      }
      case "issuer":
        return { id, choice: "return_to_issuer" };
      case "transfer": {
        const destination = transferDestinations[asset];
        return destination
          ? { id, choice: TRANSFER_CHOICE, params: { destination } }
          : { id, choice: TRANSFER_CHOICE };
      }
      // Only meaningful for a Soroban token; the API refuses it for a trustline, loudly.
      case "leave":
        return { id, choice: LEAVE_CHOICE };
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

  const claimedPerAsset = claimedAmounts(accountState, claimableBalanceSelections);

  for (const [asset, disposition] of Object.entries(dispositions)) {
    if (disposition !== "transfer" || isTokenContract(asset)) continue;
    const destination = destinations[asset];
    if (!destination) continue;
    const trustline = trustlines.find((tl) => tl.asset === asset);
    const floor = parseFloat(trustline?.balance ?? "0") + (claimedPerAsset.get(asset) ?? 0);
    if (floor <= 0) continue;
    transfers[asset] = { destination, amount: floor.toFixed(7) };
  }
  return transfers;
}

/**
 * The Soroban token transfers the user chose, keyed by token contract, with the balance the
 * analysis read in base units. verify() holds the transfer to at least that amount, to the
 * destination typed here, and to nothing else. A token the account no longer shows is skipped:
 * there is nothing to vouch for.
 */
export function chosenTokenTransfers(
  dispositions: Record<string, AssetDisposition>,
  destinations: Record<string, string>,
  accountState: AccountState | null
): Record<string, { destination: string; amount: string }> {
  const transfers: Record<string, { destination: string; amount: string }> = {};
  const tokens = accountState?.sorobanTokens?.tokens ?? [];
  for (const [contract, disposition] of Object.entries(dispositions)) {
    if (disposition !== "transfer" || !isTokenContract(contract)) continue;
    const destination = destinations[contract];
    if (!destination) continue;
    // The floor is the balance the analysis read. Zero when the read shows none (a token an exit
    // pays out during the close, or one the plan confirmed after this read): the destination and
    // the shape still pin the transfer; only the amount is unknown until the payout lands.
    const token = tokens.find((t) => t.contract === contract);
    const amount = token && /^\d+$/.test(token.balance) ? token.balance : "0";
    transfers[contract] = { destination, amount };
  }
  return transfers;
}

/**
 * The Soroban token conversions the user chose, keyed by token contract, with the least XLM (in
 * stroops) the plan quoted and they accepted. verify() holds the built swap to at least that
 * figure, and to paying it into this account and no other.
 */
export function chosenTokenConversions(
  dispositions: Record<string, AssetDisposition>,
  floors: Record<string, string>
): Record<string, { minAmountOut: string }> {
  const conversions: Record<string, { minAmountOut: string }> = {};
  for (const [contract, disposition] of Object.entries(dispositions)) {
    if (disposition !== "convert" || !isTokenContract(contract)) continue;
    const floor = floors[contract];
    if (typeof floor !== "string" || !/^[1-9]\d*$/.test(floor)) continue;
    conversions[contract] = { minAmountOut: floor };
  }
  return conversions;
}

/**
 * The Soroban tokens the close disposed of, for the receipt: what was sent, converted, or - the
 * one outcome someone will most need to look up later - deliberately left with the address.
 */
export function receiptTokenSummary(
  accountState: AccountState | null
): Array<{ asset: string; code: string }> {
  return (accountState?.sorobanTokens?.tokens ?? [])
    .filter((t) => /^[1-9]\d*$/.test(t.balance))
    .map((t) => ({
      asset: t.contract,
      code: t.symbol ?? `${t.contract.slice(0, 4)}…${t.contract.slice(-4)}`,
    }));
}

/**
 * The non-native amounts this close will claim, summed per asset - the client-side twin of the
 * API's `claimedAmountsPerAsset`, on the same will-it-be-claimed rule: a currently-claimable
 * balance is claimed unless explicitly forfeited, one the account cannot claim yet only on an
 * explicit remediation.
 */
export function claimedAmounts(
  accountState: AccountState | null,
  claimableBalanceSelections: Record<string, ClaimableBalanceSelection>
): Map<string, number> {
  const perAsset = new Map<string, number>();
  if (!accountState) return perAsset;
  const trustlines = accountState.trustlines ?? [];
  const authorized = new Set(trustlines.filter((tl) => tl.authorized).map((tl) => tl.asset));
  for (const b of accountState.claimableBalances ?? []) {
    if (b.asset === "native") continue;
    const selection = claimableBalanceSelections[b.id];
    const willClaim = authorized.has(b.asset)
      ? selection !== "forfeit"
      : selection === "add_trustline_then_claim";
    if (!willClaim) continue;
    perAsset.set(b.asset, (perAsset.get(b.asset) ?? 0) + parseFloat(b.amount));
  }
  return perAsset;
}

/**
 * What the completion receipt lists: the assets whose balances this close disposed of, and the
 * trustlines it removed - including the ones the close itself added to claim with.
 *
 * Built from load-time trustlines alone, the receipt omitted every asset that arrived through a
 * claim: an EURC returned to its issuer and a USDC swapped away simply did not appear in the
 * permanent record of an irreversible close, and the removed-trustlines count was short by the
 * lines the plan itself had opened.
 */
export function receiptAssetSummary(
  accountState: AccountState | null,
  claimableBalanceSelections: Record<string, ClaimableBalanceSelection>
): {
  handledAssets: Array<{ asset: string; code: string }>;
  removedTrustlines: Array<{ asset: string; code: string }>;
} {
  if (!accountState) return { handledAssets: [], removedTrustlines: [] };
  const trustlines = accountState.trustlines ?? [];
  const claimed = claimedAmounts(accountState, claimableBalanceSelections);

  const code = (asset: string) => asset.split(":")[0] ?? asset;
  const handled = new Map<string, { asset: string; code: string }>();
  for (const tl of trustlines) {
    if (parseFloat(tl.balance) > 0 || (claimed.get(tl.asset) ?? 0) > 0) {
      handled.set(tl.asset, { asset: tl.asset, code: tl.code });
    }
  }
  for (const asset of claimed.keys()) {
    if (!handled.has(asset)) handled.set(asset, { asset, code: code(asset) });
  }

  const removed = new Map<string, { asset: string; code: string }>();
  for (const tl of trustlines) removed.set(tl.asset, { asset: tl.asset, code: tl.code });
  for (const asset of claimed.keys()) {
    if (!removed.has(asset)) removed.set(asset, { asset, code: code(asset) });
  }

  return { handledAssets: [...handled.values()], removedTrustlines: [...removed.values()] };
}
