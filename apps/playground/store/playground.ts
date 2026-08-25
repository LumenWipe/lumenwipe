import { create } from "zustand";
import type { AccountState } from "@lumenwipe/sdk";
import type { MessStepDef, PlaygroundCustomConfig, PlaygroundMode } from "@/lib/mess-plan";
import { DEFAULT_CUSTOM_CONFIG } from "@/lib/mess-plan";

export type PlaygroundPhase =
  | "IDLE"
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
  lastError: string | null;
  /** XLM recovered so far during the demolish phase (for the core counter). */
  recoveredXlm: string | null;
  /** Mode selected on the IDLE screen. Survives COMPLETE/EXPIRED resets. */
  selectedMode: PlaygroundMode;
  customConfig: PlaygroundCustomConfig;

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
  setRecoveredXlm: (xlm: string) => void;
  setLastError: (error: string | null) => void;
  setSelectedMode: (mode: PlaygroundMode) => void;
  setCustomConfig: (config: PlaygroundCustomConfig) => void;
  reset: () => void;
}

const sessionInitialState = {
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
  lastError: null,
  recoveredXlm: null,
};

let logCounter = 0;

export const usePlaygroundStore = create<PlaygroundState>((set) => ({
  ...sessionInitialState,
  selectedMode: "standard",
  customConfig: DEFAULT_CUSTOM_CONFIG,

  setPhase: (phase) => set({ phase }),

  startSession: ({ sessionId, demoPublic, expiresAt, accounts, messPlan }) =>
    set((state) => ({
      ...sessionInitialState,
      phase: "MESSING",
      sessionId,
      demoPublic,
      expiresAt,
      accounts,
      messPlan,
      selectedMode: state.selectedMode,
      customConfig: state.customConfig,
    })),

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

  setRecoveredXlm: (recoveredXlm) => set({ recoveredXlm }),

  setLastError: (lastError) => set({ lastError }),

  setSelectedMode: (selectedMode) => set({ selectedMode }),

  setCustomConfig: (customConfig) => set({ customConfig }),

  reset: () =>
    set((state) => ({
      ...sessionInitialState,
      selectedMode: state.selectedMode,
      customConfig: state.customConfig,
    })),
}));
