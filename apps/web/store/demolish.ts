import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import type { AccountState } from "@/types/account";
import type {
  PlannedStep,
  DemolishPhase,
  AssetDisposition,
  ClaimableBalanceSelection,
  StepType,
} from "@/types/plan";

interface DemolishState {
  // Inputs
  sourceAddress: string | null;
  destinationAddress: string | null;
  memo: string | null;
  memoType: "text" | "id" | "hash" | null;
  /**
   * The destination the user explicitly confirmed they control, for a destination the
   * exchange registry does not recognize. Stored as the address rather than a boolean so
   * the confirmation cannot outlive the address it was given for: editing the destination
   * leaves this pointing at the old one, which no longer matches.
   */
  destinationAcknowledgedFor: string | null;

  // Preflight
  phase: DemolishPhase;
  accountState: AccountState | null;
  executionPlan: PlannedStep[];
  currentStepIndex: number;

  // Per-asset disposition: swap to XLM ("convert"), return to issuer ("issuer"), or send the
  // balance intact to an account of the user's choosing ("transfer")
  assetDispositions: Record<string, AssetDisposition>;

  // Where each "transfer" disposition sends its balance, keyed by the same asset string.
  // Kept here, in the user's own state, because verify() binds the transaction's payment
  // destination against it before signing - reading it back from the plan or the transaction
  // would make the check circular and prove nothing.
  transferDestinations: Record<string, string>;

  // Per-claimable-balance selection, keyed by balance id: claim it, add a trustline then
  // claim it, or forfeit it.
  claimableBalanceSelections: Record<string, ClaimableBalanceSelection>;

  // Mediator
  mediatorRequired: boolean;

  // Error
  lastError: string | null;

  // Session
  sessionId: string | null;

  // Actions
  setAddresses: (
    source: string,
    dest: string,
    memo?: string,
    memoType?: "text" | "id" | "hash"
  ) => void;
  /** Records (or clears, with null) the destination the user confirmed they control. */
  acknowledgeDestination: (address: string | null) => void;
  setPhase: (phase: DemolishPhase) => void;
  setAccountState: (state: AccountState) => void;
  setPlan: (plan: PlannedStep[]) => void;
  setAssetDisposition: (asset: string, action: AssetDisposition) => void;
  setTransferDestination: (asset: string, destination: string | null) => void;
  setClaimableBalanceSelection: (balanceId: string, selection: ClaimableBalanceSelection) => void;
  setMediatorRequired: (required: boolean) => void;
  setCurrentStepIndex: (index: number) => void;
  updateStep: (index: number, patch: Partial<PlannedStep>) => void;
  markStepConfirmed: (index: number, txHash: string) => void;
  /**
   * Marks every not-yet-confirmed step whose type appears in `coveredTypes` as confirmed.
   * A single API-built transaction can cover several plan steps (a fused close), so one
   * confirmation lands multiple steps at once.
   */
  markCoveredConfirmed: (coveredTypes: StepType[], txHash: string) => void;
  markStepFailed: (index: number, error: string) => void;
  setLastError: (error: string | null) => void;
  initSession: () => void;
  restoreSession: (id: string) => void;
  reset: () => void;
}

/**
 * Drops disposition entries for assets the new account state no longer holds a
 * trustline for, while preserving decisions for assets that still exist. A fresh
 * scan of the same account therefore keeps the user's per-asset choices.
 */
/** Drops entries for assets the account no longer holds, so a re-analyze cannot leave a
 *  destination attached to a trustline that is gone. */
/** Assets a decision can legitimately be about: held in a trustline, or sitting in a claimable
 *  balance the user may choose to claim. Pruning to trustlines alone dropped the disposition of
 *  an asset arriving through a claim on every account re-read, and the auto-convert default
 *  silently refilled it - executing a swap the user had explicitly declined. */
function decidableAssets(accountState: AccountState): Set<string> {
  return new Set([
    ...accountState.trustlines.map((tl) => tl.asset),
    ...accountState.claimableBalances.filter((b) => b.asset !== "native").map((b) => b.asset),
  ]);
}

function pruneToPresentAssets(
  destinations: Record<string, string>,
  accountState: AccountState
): Record<string, string> {
  const present = decidableAssets(accountState);
  const next: Record<string, string> = {};
  for (const [asset, destination] of Object.entries(destinations)) {
    if (present.has(asset)) next[asset] = destination;
  }
  return next;
}

function pruneDispositions(
  dispositions: Record<string, AssetDisposition>,
  accountState: AccountState
): Record<string, AssetDisposition> {
  const present = decidableAssets(accountState);
  const next: Record<string, AssetDisposition> = {};
  for (const [asset, action] of Object.entries(dispositions)) {
    if (present.has(asset)) next[asset] = action;
  }
  return next;
}

/**
 * Drops selection entries for claimable balances the new account state no longer reports
 * (already claimed by another claimant, or expired), while preserving selections for balances
 * that still exist - same rationale as `pruneDispositions`.
 */
function pruneClaimableSelections(
  selections: Record<string, ClaimableBalanceSelection>,
  accountState: AccountState
): Record<string, ClaimableBalanceSelection> {
  const present = new Set(accountState.claimableBalances.map((b) => b.id));
  const next: Record<string, ClaimableBalanceSelection> = {};
  for (const [balanceId, selection] of Object.entries(selections)) {
    if (present.has(balanceId)) next[balanceId] = selection;
  }
  return next;
}

const initialState = {
  sourceAddress: null,
  destinationAddress: null,
  memo: null,
  memoType: null,
  destinationAcknowledgedFor: null,
  phase: "IDLE" as DemolishPhase,
  accountState: null,
  executionPlan: [],
  currentStepIndex: 0,
  assetDispositions: {},
  transferDestinations: {},
  claimableBalanceSelections: {},
  mediatorRequired: false,
  lastError: null,
  sessionId: null,
};

export const useDemolishStore = create<DemolishState>((set) => ({
  ...initialState,

  setAddresses: (source, dest, memo, memoType) =>
    set({
      sourceAddress: source,
      destinationAddress: dest,
      memo: memo ?? null,
      memoType: memoType ?? null,
    }),

  acknowledgeDestination: (address) => set({ destinationAcknowledgedFor: address }),

  setPhase: (phase) => set({ phase }),

  setAccountState: (accountState) =>
    set((s) => ({
      accountState,
      // Keep per-asset decisions across a re-scan of the SAME assets (e.g. the
      // analyze-page refresh button, which re-runs the fetch and lands here):
      // wiping them dropped a user's "return to issuer" choice, after which the
      // fused close silently re-quoted the asset and failed with a lost route.
      // Prune to assets still present so a genuinely-gone trustline can't carry a
      // stale decision into the build.
      assetDispositions: pruneDispositions(s.assetDispositions, accountState),
      transferDestinations: pruneToPresentAssets(s.transferDestinations, accountState),
      claimableBalanceSelections: pruneClaimableSelections(
        s.claimableBalanceSelections,
        accountState
      ),
    })),

  // Reset the step pointer whenever a new plan is installed: a prior run may have
  // advanced currentStepIndex, and a new (often shorter) plan must start at step 0
  // so executionPlan[currentStepIndex] never points past the end.
  setPlan: (executionPlan) => set({ executionPlan, currentStepIndex: 0 }),

  setAssetDisposition: (asset, action) =>
    set((s) => {
      // Switching away from transfer drops the destination with it: a stale one would still be
      // handed to verify(), which would then vouch for a payment the user is no longer asking
      // for.
      if (action === "transfer") {
        return { assetDispositions: { ...s.assetDispositions, [asset]: action } };
      }
      const { [asset]: _dropped, ...rest } = s.transferDestinations;
      return {
        assetDispositions: { ...s.assetDispositions, [asset]: action },
        transferDestinations: rest,
      };
    }),

  setTransferDestination: (asset, destination) =>
    set((s) => {
      if (destination === null) {
        const { [asset]: _cleared, ...rest } = s.transferDestinations;
        return { transferDestinations: rest };
      }
      return { transferDestinations: { ...s.transferDestinations, [asset]: destination } };
    }),

  setClaimableBalanceSelection: (balanceId, selection) =>
    set((s) => ({
      claimableBalanceSelections: { ...s.claimableBalanceSelections, [balanceId]: selection },
    })),

  setMediatorRequired: (required) => set({ mediatorRequired: required }),

  setCurrentStepIndex: (currentStepIndex) => set({ currentStepIndex }),

  updateStep: (index, patch) =>
    set((state) => ({
      executionPlan: state.executionPlan.map((s) => (s.index === index ? { ...s, ...patch } : s)),
    })),

  markStepConfirmed: (index, txHash) =>
    set((state) => ({
      executionPlan: state.executionPlan.map((s) =>
        s.index === index ? { ...s, status: "confirmed", txHash } : s
      ),
      phase: "STEP_CONFIRMED",
    })),

  markCoveredConfirmed: (coveredTypes, txHash) =>
    set((state) => {
      const covered = new Set<StepType>(coveredTypes);
      return {
        executionPlan: state.executionPlan.map((s) =>
          covered.has(s.type) && s.status !== "confirmed"
            ? { ...s, status: "confirmed", txHash }
            : s
        ),
        phase: "STEP_CONFIRMED",
      };
    }),

  markStepFailed: (index, error) =>
    set((state) => ({
      executionPlan: state.executionPlan.map((s) =>
        s.index === index ? { ...s, status: "failed", error } : s
      ),
      phase: "STEP_FAILED",
      lastError: error,
    })),

  setLastError: (lastError) => set({ lastError }),

  initSession: () => set({ sessionId: uuidv4() }),

  // Reuses an existing session ID instead of generating a new one. Used by the
  // resume flow so that subsequent saveSession calls overwrite the same IndexedDB
  // record rather than creating an orphan that remains "in_progress" forever.
  restoreSession: (id) => set({ sessionId: id }),

  reset: () => set(initialState),
}));
