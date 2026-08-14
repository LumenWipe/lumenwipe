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

  // Per-asset disposition: swap to XLM ("convert") or return to issuer ("issuer")
  assetDispositions: Record<string, AssetDisposition>;

  // Per-claimable-balance selection, keyed by balance id: claim it, add a trustline then
  // claim it, or forfeit it.
  claimableBalanceSelections: Record<string, ClaimableBalanceSelection>;

  // Mediator
  mediatorRequired: boolean;
  mediatorPublicKey: string | null;

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
  setClaimableBalanceSelection: (balanceId: string, selection: ClaimableBalanceSelection) => void;
  setMediatorRequired: (required: boolean, publicKey?: string) => void;
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
function pruneDispositions(
  dispositions: Record<string, AssetDisposition>,
  accountState: AccountState
): Record<string, AssetDisposition> {
  const present = new Set(accountState.trustlines.map((tl) => tl.asset));
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
  claimableBalanceSelections: {},
  mediatorRequired: false,
  mediatorPublicKey: null,
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
    set((s) => ({ assetDispositions: { ...s.assetDispositions, [asset]: action } })),

  setClaimableBalanceSelection: (balanceId, selection) =>
    set((s) => ({
      claimableBalanceSelections: { ...s.claimableBalanceSelections, [balanceId]: selection },
    })),

  setMediatorRequired: (required, publicKey) =>
    set({ mediatorRequired: required, mediatorPublicKey: publicKey ?? null }),

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
