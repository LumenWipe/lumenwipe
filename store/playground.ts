import { create } from "zustand";
import type { AccountState } from "@/types/account";
import type { PlannedStep } from "@/types/plan";
import type { MessStepDef } from "@/lib/playground/mess-plan";

export type PlaygroundPhase =
  | "IDLE"
  | "CREATING_ACCOUNT"
  | "MESSING"
  | "DIRTY"
  | "DEMOLISHING"
  | "COMPLETE"
  | "EXPIRED"
  | "ERROR";

export type SceneNodeKind = "trustline" | "offer" | "data" | "signer";
export type SceneNodeStatus = "incoming" | "docked" | "converting" | "destroyed";

export interface SceneNode {
  id: string;
  kind: SceneNodeKind;
  label: string;
  balance: string | null;
  status: SceneNodeStatus;
  txHash: string | null;
  orbit: { radius: number; durationSec: number; phaseDeg: number };
}

export interface LogEntry {
  id: string;
  label: string;
  txHash: string | null;
  kind: "mess" | "demolish" | "info";
  at: number;
}

export interface PlaygroundAccounts {
  issuer: string;
  mm: string;
  lwdemoAsset: string;
  ephemeral: Array<{ code: string; publicKey: string }>;
}

interface PlaygroundState {
  phase: PlaygroundPhase;
  sessionId: string | null;
  demoPublic: string | null;
  expiresAt: number | null;
  accounts: PlaygroundAccounts | null;
  messPlan: MessStepDef[];
  currentMessIndex: number;
  nodes: SceneNode[];
  log: LogEntry[];
  accountState: AccountState | null;
  executionPlan: PlannedStep[];
  currentStepIndex: number;
  lastError: string | null;
  /** XLM recovered so far during the demolish phase (for the core counter). */
  recoveredXlm: string | null;

  setPhase: (phase: PlaygroundPhase) => void;
  startSession: (payload: {
    sessionId: string;
    demoPublic: string;
    expiresAt: number;
    accounts: PlaygroundAccounts;
    messPlan: MessStepDef[];
  }) => void;
  setCurrentMessIndex: (index: number) => void;
  dockNodes: (nodes: SceneNode[], txHash: string) => void;
  updateNode: (id: string, patch: Partial<SceneNode>) => void;
  destroyNodes: (ids: string[], txHash: string) => void;
  addLog: (entry: Omit<LogEntry, "id" | "at">) => void;
  setAccountState: (state: AccountState | null) => void;
  setPlan: (plan: PlannedStep[]) => void;
  setCurrentStepIndex: (index: number) => void;
  updateStep: (index: number, patch: Partial<PlannedStep>) => void;
  markStepConfirmed: (index: number, txHash: string) => void;
  markStepFailed: (index: number, error: string) => void;
  setRecoveredXlm: (xlm: string) => void;
  setLastError: (error: string | null) => void;
  reset: () => void;
}

const initialState = {
  phase: "IDLE" as PlaygroundPhase,
  sessionId: null,
  demoPublic: null,
  expiresAt: null,
  accounts: null,
  messPlan: [],
  currentMessIndex: 0,
  nodes: [],
  log: [],
  accountState: null,
  executionPlan: [],
  currentStepIndex: 0,
  lastError: null,
  recoveredXlm: null,
};

let logCounter = 0;

export const usePlaygroundStore = create<PlaygroundState>((set) => ({
  ...initialState,

  setPhase: (phase) => set({ phase }),

  startSession: ({ sessionId, demoPublic, expiresAt, accounts, messPlan }) =>
    set({
      ...initialState,
      phase: "MESSING",
      sessionId,
      demoPublic,
      expiresAt,
      accounts,
      messPlan,
    }),

  setCurrentMessIndex: (currentMessIndex) => set({ currentMessIndex }),

  dockNodes: (nodes, txHash) =>
    set((state) => ({
      nodes: [
        ...state.nodes,
        ...nodes.map((n) => ({ ...n, status: "docked" as SceneNodeStatus, txHash })),
      ],
    })),

  updateNode: (id, patch) =>
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    })),

  destroyNodes: (ids, txHash) =>
    set((state) => ({
      nodes: state.nodes.map((n) =>
        ids.includes(n.id) ? { ...n, status: "destroyed" as SceneNodeStatus, txHash } : n
      ),
    })),

  addLog: (entry) =>
    set((state) => ({
      log: [...state.log, { ...entry, id: `log-${logCounter++}`, at: Date.now() }],
    })),

  setAccountState: (accountState) => set({ accountState }),

  setPlan: (executionPlan) => set({ executionPlan }),

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
    })),

  markStepFailed: (index, error) =>
    set((state) => ({
      executionPlan: state.executionPlan.map((s) =>
        s.index === index ? { ...s, status: "failed", error } : s
      ),
      phase: "ERROR",
      lastError: error,
    })),

  setRecoveredXlm: (recoveredXlm) => set({ recoveredXlm }),

  setLastError: (lastError) => set({ lastError }),

  reset: () => set(initialState),
}));
