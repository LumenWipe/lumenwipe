import type { Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import type { AccountState } from "@/types/account";
import {
  DECISIONS_VERSION,
  assetFingerprint,
  readDecisions,
  writeDecisions,
  type DecisionSnapshot,
} from "./decision-snapshot";

type State = ReturnType<typeof useDemolishStore.getState>;

/** The store holds no answer yet for this account, as after a reload or a resume. */
export function holdsNoDecisions(state: State, source: string): boolean {
  return (
    (state.sourceAddress === null || state.sourceAddress === source) &&
    Object.keys(state.assetDispositions).length === 0 &&
    Object.keys(state.transferDestinations).length === 0 &&
    Object.keys(state.claimableBalanceSelections).length === 0 &&
    state.destinationAcknowledgedFor === null &&
    state.defiPositionsAcknowledgedFor === null &&
    state.issuerSupplyAcknowledgedFor === null &&
    state.positionsLeftBehind.length === 0
  );
}

/** The inputs this tab keeps for `source`. Before the account is read, the asset answers and what
 *  they were given for are carried over from the last snapshot rather than emptied. */
export function snapshotOf(
  network: Network,
  source: string,
  state: State,
  previous: DecisionSnapshot | null
): DecisionSnapshot {
  const account = state.accountState?.address === source ? state.accountState : null;
  const seen: Record<string, string> = {};
  if (account) {
    for (const asset of Object.keys(state.assetDispositions)) {
      const fingerprint = assetFingerprint(account, asset);
      if (fingerprint !== null) seen[asset] = fingerprint;
    }
  }
  return {
    v: DECISIONS_VERSION,
    network,
    source,
    destination: previous?.destination ?? state.destinationAddress,
    memo: previous?.memo ?? state.memo,
    memoType: state.memoType ?? previous?.memoType ?? null,
    destinationAcknowledgedFor: state.destinationAcknowledgedFor,
    defiPositionsAcknowledgedFor: state.defiPositionsAcknowledgedFor,
    issuerSupplyAcknowledgedFor: state.issuerSupplyAcknowledgedFor,
    positionsLeftBehind: state.positionsLeftBehind,
    claimableBalanceSelections: state.claimableBalanceSelections,
    assetDispositions: account ? state.assetDispositions : (previous?.assetDispositions ?? {}),
    transferDestinations: account
      ? state.transferDestinations
      : (previous?.transferDestinations ?? {}),
    seen: account ? seen : (previous?.seen ?? {}),
  };
}

function previousOf(network: Network, source: string): DecisionSnapshot | null {
  const read = readDecisions(network, source);
  return read.kind === "restored" ? read.snapshot : null;
}

/** Saves the store's inputs for `source` as they are now. */
export function keepDecisions(network: Network, source: string): void {
  const state = useDemolishStore.getState();
  if (state.sourceAddress !== null && state.sourceAddress !== source) return;
  writeDecisions(snapshotOf(network, source, state, previousOf(network, source)));
}

/** Saves what the destination and memo fields show, which the store learns only on proceeding. */
export function keepDestinationDraft(
  network: Network,
  source: string,
  destination: string,
  memo: string
): void {
  const state = useDemolishStore.getState();
  if (state.sourceAddress !== null && state.sourceAddress !== source) return;
  const snapshot = snapshotOf(network, source, state, previousOf(network, source));
  writeDecisions({ ...snapshot, destination: destination || null, memo: memo || null });
}

/** Puts back the inputs that do not depend on what the account holds, before it is read. Each
 *  acknowledgement is restored only for the very value it was given for: the destination now in
 *  the store (a resumed close's) or the restored one, and the account itself. */
export function restoreInputs(snapshot: DecisionSnapshot): void {
  const state = useDemolishStore.getState();
  const { source } = snapshot;
  if (state.destinationAddress === null && snapshot.destination !== null) {
    state.setAddresses(
      source,
      snapshot.destination,
      snapshot.memo ?? undefined,
      snapshot.memoType ?? undefined
    );
  }
  const destination = useDemolishStore.getState().destinationAddress;
  if (destination !== null && snapshot.destinationAcknowledgedFor === destination) {
    state.acknowledgeDestination(destination);
  }
  if (snapshot.defiPositionsAcknowledgedFor === source) state.acknowledgeDefiPositions(source);
  if (snapshot.issuerSupplyAcknowledgedFor === source) state.acknowledgeIssuerSupply(source);
  for (const id of snapshot.positionsLeftBehind) {
    if (id.startsWith(`defi_leave:${source}:`)) state.setPositionLeftBehind(id, true);
  }
  for (const [balanceId, selection] of Object.entries(snapshot.claimableBalanceSelections)) {
    state.setClaimableBalanceSelection(balanceId, selection);
  }
}

/** Puts back each asset answer the fresh read still shows unchanged, and returns the assets that
 *  changed since they were answered, which are left for the user to answer again. An asset the
 *  account no longer holds is dropped. */
export function restoreAssetDecisions(snapshot: DecisionSnapshot, account: AccountState): string[] {
  const state = useDemolishStore.getState();
  const changed: string[] = [];
  for (const [asset, disposition] of Object.entries(snapshot.assetDispositions)) {
    const now = assetFingerprint(account, asset);
    if (now === null) continue;
    if (now !== snapshot.seen[asset]) {
      changed.push(asset);
      continue;
    }
    state.setAssetDisposition(asset, disposition);
    const destination = snapshot.transferDestinations[asset];
    if (disposition === "transfer" && destination) state.setTransferDestination(asset, destination);
  }
  return changed;
}
