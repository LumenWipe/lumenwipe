import type { Network } from "@/config/networks";
import { journeyOf, type JourneyStateName } from "@/lib/journey/journey-state";
import { useDemolishStore } from "@/store/demolish";
import type { AccountState } from "@/types/account";
import { isValidGAddress } from "@/lib/utils/validation";
import { memoField } from "@/lib/plan/memo-field";
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

/** The transfer destinations that are account addresses, the same rule the read side applies,
 *  so a half-typed or mistaken field value is never written and never makes the rest unreadable. */
function wellFormed(destinations: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(destinations).filter(([, d]) => isValidGAddress(d)));
}

/** The inputs this tab keeps for `source`. The destination and memo are the last ones the user
 *  typed, which the snapshot already holds once there is one, an emptied field included. Before
 *  the account is read, the asset answers and what they were given for are carried over from the
 *  last snapshot rather than emptied. */
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
    destination: previous ? previous.destination : state.destinationAddress,
    memo: previous ? previous.memo : state.memo,
    memoType: previous ? previous.memoType : state.memoType,
    destinationAcknowledgedFor: state.destinationAcknowledgedFor,
    claimableBalanceSelections: state.claimableBalanceSelections,
    assetDispositions: account ? state.assetDispositions : (previous?.assetDispositions ?? {}),
    transferDestinations: wellFormed(
      account ? state.transferDestinations : (previous?.transferDestinations ?? {})
    ),
    seen: account ? seen : (previous?.seen ?? {}),
  };
}

const BEFORE_CONSENT: readonly JourneyStateName[] = ["untouched", "planned", "reviewed", "unknown"];

/** Whether the store's close is still before its review confirm, the only time inputs are kept:
 *  none outlives the consent given on review. */
function keepable(state: State, source: string): boolean {
  return (
    (state.sourceAddress === null || state.sourceAddress === source) &&
    BEFORE_CONSENT.includes(journeyOf(state).state)
  );
}

function previousOf(network: Network, source: string): DecisionSnapshot | null {
  const read = readDecisions(network, source);
  return read.kind === "restored" ? read.snapshot : null;
}

/** Saves the store's inputs for `source` as they are now. */
export function keepDecisions(network: Network, source: string): void {
  const state = useDemolishStore.getState();
  if (!keepable(state, source)) return;
  writeDecisions(snapshotOf(network, source, state, previousOf(network, source)));
}

/** Saves what the destination and memo fields show, which the store learns only on proceeding.
 *  A destination that is not a valid address yet is kept as none, so it never makes the rest
 *  of the snapshot unreadable. */
export function keepDestinationDraft(
  network: Network,
  source: string,
  destination: string,
  memo: string,
  memoType: DecisionSnapshot["memoType"]
): void {
  const state = useDemolishStore.getState();
  if (!keepable(state, source)) return;
  const snapshot = snapshotOf(network, source, state, previousOf(network, source));
  // Only a memo that could be sent is kept: one over the byte limit, of the wrong shape for its
  // type, or holding a key never reaches storage.
  const field = memoField(destination, memo, memoType === "id" ? "id" : "text");
  const kept = field.error === null ? field.normalized : "";
  writeDecisions({
    ...snapshot,
    destination: isValidGAddress(destination) ? destination : null,
    memo: kept || null,
    memoType: kept ? field.memoType : null,
  });
}

/** Puts back the inputs that do not depend on what the account holds, before it is read. The
 *  destination acknowledgement is restored only for the very address it was given for: the
 *  destination now in the store (a resumed close's) or the restored one. */
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
