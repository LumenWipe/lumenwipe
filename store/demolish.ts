import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import type { AccountState } from "@/types/account";
import type { PlannedStep, DemolishPhase } from "@/types/plan";

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
  setMediatorRequired: (required: boolean, publicKey?: string) => void;
  setCurrentStepIndex: (index: number) => void;
  updateStep: (index: number, patch: Partial<PlannedStep>) => void;
  markStepConfirmed: (index: number, txHash: string) => void;
  markStepFailed: (index: number, error: string) => void;
  setLastError: (error: string | null) => void;
  initSession: () => void;
  reset: () => void;
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
    set({
      accountState,
      requiredSignatureCount: Math.max(1, accountState.thresholds.med),
    }),

  setPlan: (executionPlan) => set({ executionPlan }),

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
