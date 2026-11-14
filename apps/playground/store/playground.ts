import { create } from "zustand";
import type { AccountState } from "@lumenwipe/sdk";
import {
  STANDARD_SELECTION,
  type FeatureSetId,
  type MessStepDef,
  type OfferAsset,
  type SceneNodeKind as PlannedNodeKind,
  type ScenarioId,
  type ScenarioSelection,
} from "@/lib/scenarios";

/** A feature set's preset, or a random wallet. */
export type PresetId = FeatureSetId | "random";

/** The kinds the scene draws: every kind the registry plans, and a generic one for anything else. */
export type SceneNodeKind = PlannedNodeKind | "generic";

export type PlaygroundPhase =
  "IDLE" | "MESSING" | "DIRTY" | "DEMOLISHING" | "COMPLETE" | "EXPIRED" | "ERROR";

/** Why the session ended: its record is gone, or its countdown ran out and its account remains. */
export type ExpiredReason = "gone" | "time_up";

export type SceneNodeStatus = "incoming" | "docked" | "converting" | "destroyed";

export interface SceneNode {
  id: string;
  kind: SceneNodeKind;
  label: string;
  balance: string | null;
  status: SceneNodeStatus;
  txHash: string | null;
  orbit: { radius: number; durationSec: number; phaseDeg: number };
  /** For an offer node: the pair it trades, and the chain's offer id once bound to it. */
  offer: { selling: OfferAsset; buying: OfferAsset } | null;
  offerId: string | null;
}

export interface LogEntry {
  id: string;
  label: string;
  txHash: string | null;
  kind: "mess" | "demolish" | "info";
  at: number;
}

/** Where one batch member's close stands. */
export type BatchCloseStatus = "waiting" | "closing" | "closed" | "blocked" | "failed";

/** The API's read-only plan for one member, as the batch plan route answers it. */
export interface BatchPlanLine {
  status: "ready" | "needs_decisions" | "blocked" | "complete";
  blockers: { code: string; message: string }[];
}

export interface BatchMember {
  sessionId: string;
  demoPublic: string;
  /** What the member's mess holds, in a few words. */
  label: string;
  messPlan: MessStepDef[];
  messDone: number;
  /** The API's plan; "unavailable" when the batch plan could not be read, null before it is. */
  plan: BatchPlanLine | "unavailable" | null;
  close: BatchCloseStatus;
  /** Why the close stopped, for a blocked member, with the blockers its session can resolve. */
  stop: StoppedClose | null;
  /** Plain-language copy for a blocked or failed close. */
  message: string | null;
  /** Hashes of the member's confirmed close transactions. */
  hashes: string[];
}

/** A batch run: its members in creation order, and which one the close reports blocked. */
export interface BatchRun {
  batchId: string;
  blockedIndex: number;
  members: BatchMember[];
}

/** One account (0), or a batch of two or three. */
export type BatchSize = 0 | 2 | 3;

/** Why the close stopped before building: decisions it could not answer, or blockers the API
 *  reported, with the ones the session can resolve. */
export interface StoppedClose {
  decisionIds: string[];
  blockers: string[];
  resolvable: string[];
}

export interface PlaygroundAccounts {
  issuer: string;
  mm: string;
  lwdemoAsset: string;
  ephemeral: Array<{ code: string; publicKey: string }>;
  /** The account the session's transfers go to; null when it transfers nothing. */
  transferRecipient: string | null;
  /** The claimant, sponsor or beneficiary accounts the session created. */
  helpers: Array<{ role: string; publicKey: string }>;
}

interface PlaygroundState {
  phase: PlaygroundPhase;
  sessionId: string | null;
  demoPublic: string | null;
  expiresAt: number | null;
  /** Whether the session's one extension has been used. */
  extended: boolean;
  /** Set with the EXPIRED phase. */
  expiredReason: ExpiredReason | null;
  accounts: PlaygroundAccounts | null;
  messPlan: MessStepDef[];
  currentMessIndex: number;
  nodes: SceneNode[];
  log: LogEntry[];
  accountState: AccountState | null;
  lastError: string | null;
  /** The decision ids that stopped the close, when the last error was such a stop. */
  blocker: StoppedClose | null;
  /** The reserve the account held at the state read just before its first close round; null when
   *  that read did not happen or failed. The receipt shows it as part of the merged amount. */
  preCloseReserveXlm: number | null;
  /** The last error stopped a close that had started: the demo can resume it. */
  demolishFailed: boolean;
  /** The session's close as SDK code, once the server has built it. */
  sdkSnippet: string | null;
  /** The scenarios picked on the IDLE screen, and the preset they came from (null once edited).
   *  Both survive COMPLETE/EXPIRED resets. */
  selection: ScenarioSelection;
  preset: PresetId | null;
  /** The replay code the selection was generated from; null once it is edited by hand. */
  seed: string | null;
  /** Scenarios this deployment cannot run (GET /api/scenarios), with their reasons. */
  unavailable: ReadonlyMap<ScenarioId, string>;
  /** One account, or the size of the batch to start; survives resets like the selection. */
  batchSize: BatchSize;
  /** The batch being run, if the session is one. */
  batch: BatchRun | null;
  /** A shared link (`?seed=` or `?selection=`) is still being applied: the run cannot start yet,
   *  or it would start with the selection the link is about to replace. */
  linkPending: boolean;

  setPhase: (phase: PlaygroundPhase) => void;
  /** Moves to EXPIRED for `reason`. */
  setExpired: (reason: ExpiredReason) => void;
  /** The countdown as the server stored it, after the extension. */
  setExpiry: (expiresAt: number, extended: boolean) => void;
  startSession: (payload: {
    sessionId: string;
    demoPublic: string;
    expiresAt: number;
    accounts: PlaygroundAccounts;
    messPlan: MessStepDef[];
  }) => void;
  setCurrentMessIndex: (index: number) => void;
  dockNodes: (nodes: SceneNode[], txHash: string | null) => void;
  updateNode: (id: string, patch: Partial<SceneNode>) => void;
  destroyNodes: (ids: string[], txHash: string | null) => void;
  addLog: (entry: Omit<LogEntry, "id" | "at">) => void;
  setAccountState: (state: AccountState | null) => void;
  setPreCloseReserveXlm: (xlm: number | null) => void;
  setLastError: (error: string | null, blocker?: StoppedClose | null) => void;
  setDemolishFailed: (failed: boolean) => void;
  setSdkSnippet: (snippet: string) => void;
  setSelection: (
    selection: ScenarioSelection,
    preset: PresetId | null,
    seed?: string | null
  ) => void;
  setUnavailable: (unavailable: ReadonlyMap<ScenarioId, string>) => void;
  setLinkPending: (linkPending: boolean) => void;
  setBatchSize: (batchSize: BatchSize) => void;
  startBatch: (batch: BatchRun, expiresAt: number) => void;
  updateBatchMember: (index: number, patch: Partial<BatchMember>) => void;
  /** Binds each offer node to the chain offer trading its pair. */
  bindOffers: (offers: readonly { id: string; selling: string; buying: string }[]) => void;
  reset: () => void;
}

const sessionInitialState = {
  phase: "IDLE" as PlaygroundPhase,
  sessionId: null,
  demoPublic: null,
  expiresAt: null,
  extended: false,
  expiredReason: null as ExpiredReason | null,
  accounts: null,
  messPlan: [],
  currentMessIndex: 0,
  nodes: [],
  log: [],
  accountState: null,
  lastError: null,
  blocker: null,
  preCloseReserveXlm: null,
  demolishFailed: false,
  sdkSnippet: null,
  batch: null as BatchRun | null,
};

let logCounter = 0;

/** "native" stays as is; "CODE:ISSUER" becomes its code, which is unique within a session. */
const assetCode = (asset: string): string => asset.split(":")[0] ?? asset;

export const usePlaygroundStore = create<PlaygroundState>((set) => ({
  ...sessionInitialState,
  selection: STANDARD_SELECTION,
  preset: "classic",
  seed: null,
  unavailable: new Map(),
  linkPending: false,
  batchSize: 0,

  setPhase: (phase) => set({ phase }),

  setExpired: (expiredReason) => set({ phase: "EXPIRED", expiredReason }),

  setExpiry: (expiresAt, extended) => set({ expiresAt, extended }),

  startSession: ({ sessionId, demoPublic, expiresAt, accounts, messPlan }) =>
    set((state) => ({
      ...sessionInitialState,
      phase: "MESSING",
      sessionId,
      demoPublic,
      expiresAt,
      accounts,
      messPlan,
      selection: state.selection,
      preset: state.preset,
      seed: state.seed,
      unavailable: state.unavailable,
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

  setPreCloseReserveXlm: (preCloseReserveXlm) => set({ preCloseReserveXlm }),

  setLastError: (lastError, blocker = null) => set({ lastError, blocker }),

  setDemolishFailed: (demolishFailed) => set({ demolishFailed }),

  setSdkSnippet: (sdkSnippet) => set({ sdkSnippet }),

  setSelection: (selection, preset, seed = null) => set({ selection, preset, seed }),

  setUnavailable: (unavailable) => set({ unavailable }),

  setLinkPending: (linkPending) => set({ linkPending }),

  setBatchSize: (batchSize) => set({ batchSize }),

  startBatch: (batch, expiresAt) =>
    set((state) => ({
      ...sessionInitialState,
      phase: "MESSING",
      expiresAt,
      batch,
      selection: state.selection,
      preset: state.preset,
      seed: state.seed,
      unavailable: state.unavailable,
      batchSize: state.batchSize,
    })),

  updateBatchMember: (index, patch) =>
    set((state) =>
      state.batch
        ? {
            batch: {
              ...state.batch,
              members: state.batch.members.map((m, i) => (i === index ? { ...m, ...patch } : m)),
            },
          }
        : {}
    ),

  bindOffers: (offers) =>
    set((state) => ({
      nodes: state.nodes.map((n) => {
        const pair = n.offer;
        if (!pair) return n;
        const match = offers.find(
          (o) => assetCode(o.selling) === pair.selling && assetCode(o.buying) === pair.buying
        );
        return match ? { ...n, offerId: match.id } : n;
      }),
    })),

  reset: () =>
    set((state) => ({
      ...sessionInitialState,
      selection: state.selection,
      preset: state.preset,
      seed: state.seed,
      unavailable: state.unavailable,
    })),
}));
