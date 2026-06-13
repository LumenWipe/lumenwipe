import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import type { AccountState } from "@/types/account";
import type { PlannedStep, DemolishPhase, AssetDisposition } from "@/types/plan";

interface DemolishState {
  // Inputs
  sourceAddress: string | null;
  destinationAddress: string | null;
  memo: string | null;
  memoType: "text" | "id" | "hash" | null;

  // Preflight
  phase: DemolishPhase;
  accountState: AccountState | null;
  executionPlan: PlannedStep[];
  currentStepIndex: number;

  // Per-asset disposition: swap to XLM ("convert") or return to issuer ("issuer")
  assetDispositions: Record<string, AssetDisposition>;

  // Multisig
  requiredSignatureCount: number;

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
  setPhase: (phase: DemolishPhase) => void;
  setAccountState: (state: AccountState) => void;
  setPlan: (plan: PlannedStep[]) => void;
  setAssetDisposition: (asset: string, action: AssetDisposition) => void;
  setMediatorRequired: (required: boolean, publicKey?: string) => void;
  setCurrentStepIndex: (index: number) => void;
  updateStep: (index: number, patch: Partial<PlannedStep>) => void;
  markStepConfirmed: (index: number, txHash: string) => void;
  markStepFailed: (index: number, error: string) => void;
  setLastError: (error: string | null) => void;
  initSession: () => void;
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

const initialState = {
  sourceAddress: null,
  destinationAddress: null,
  memo: null,
  memoType: null,
  phase: "IDLE" as DemolishPhase,
  accountState: null,
  executionPlan: [],
  currentStepIndex: 0,
  assetDispositions: {},
  requiredSignatureCount: 1,
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

  setPhase: (phase) => set({ phase }),

  setAccountState: (accountState) =>
    set((s) => ({
      accountState,
      requiredSignatureCount: Math.max(1, accountState.thresholds.med),
      // Keep per-asset decisions across a re-scan of the SAME assets (e.g. the
      // analyze-page refresh button, which re-runs the fetch and lands here):
      // wiping them dropped a user's "return to issuer" choice, after which the
      // fused close silently re-quoted the asset and failed with a lost route.
      // Prune to assets still present so a genuinely-gone trustline can't carry a
      // stale decision into the build.
      assetDispositions: pruneDispositions(s.assetDispositions, accountState),
    })),

  // Reset the step pointer whenever a new plan is installed: a prior run may have
  // advanced currentStepIndex, and a new (often shorter) plan must start at step 0
  // so executionPlan[currentStepIndex] never points past the end.
  setPlan: (executionPlan) => set({ executionPlan, currentStepIndex: 0 }),

  setAssetDisposition: (asset, action) =>
    set((s) => ({ assetDispositions: { ...s.assetDispositions, [asset]: action } })),

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

  reset: () => set(initialState),
}));
