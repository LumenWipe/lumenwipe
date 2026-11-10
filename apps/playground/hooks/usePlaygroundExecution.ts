"use client";

import { useCallback, useRef, useState } from "react";
import {
  usePlaygroundStore,
  type PlaygroundAccounts,
  type SceneNode,
  type SceneNodeKind,
} from "@/store/playground";
import { operationToSceneAction } from "@/lib/scene-actions";
import { SCENE_NODE_KINDS, type MessStepDef, type SceneNodeSpec } from "@/lib/scenarios";
import type { AccountState, IntentOperation } from "@lumenwipe/sdk";
import { GENERIC_ERROR_COPY } from "@/lib/error-copy";
import {
  DecisionBlockedError,
  PlanBlockedError,
  PlaygroundApiError,
  playgroundRequest,
  SessionExpiredError,
} from "@/lib/playground-api";

interface SessionResponse {
  sessionId: string;
  demoPublic: string;
  expiresAt: number;
  messPlan: MessStepDef[];
  accounts: PlaygroundAccounts;
}

interface DemolishLogEntry {
  txId: string;
  hash: string;
  summary: string;
  operations: IntentOperation[];
}

interface StateResponse {
  demoPublic: string;
  accountState: AccountState | null;
  completedMessSteps: string[];
  demolishLog: DemolishLogEntry[];
  demolishDone: boolean;
}

/** One demolish round: what it confirmed, whether the account is gone, and the rounds left. */
export interface DemolishRoundResponse {
  done: boolean;
  confirmed: DemolishLogEntry[];
  remainingSteps: number | null;
}

/** A recorded allowance and whether the API lists it; `index` is its spender's position. */
interface ListedAllowance {
  index: number;
  token: string;
  spender: string;
  listed: boolean;
  amount: string | null;
}

interface UsePlaygroundExecutionResult {
  start: () => void;
  demolish: () => void;
  resolve: (blocker: string) => void;
  progressStatus: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function api<T>(path: string, init?: RequestInit): Promise<T> {
  return playgroundRequest<T>(fetch, path, init);
}

// Orbit radius/duration by node kind - adapted from the deleted
// `lib/playground/scene-nodes.ts` (git show f416924^:apps/web/lib/playground/scene-nodes.ts),
// inlined here since it was a small, single-purpose helper with no other
// callers. One ring per kind is what OrbitalScene's five RING_FRACTIONS guide
// rings visually group by - keep these two in sync.
//
// Radii pushed out from the original's 95/135/175/215: CoreAccount grows up
// to 144px (h-36) plus a 60px glow at the lg breakpoint, and a labeled node
// pill reaches into its own orbit radius, so the original inner rings left
// the innermost nodes (especially signer, the smallest ring) overlapping the
// core account's glow at wider viewports.
const RING: Record<SceneNodeKind, { radius: number; durationSec: number }> = {
  signer: { radius: 150, durationSec: 26 },
  trustline: { radius: 180, durationSec: 34 },
  data: { radius: 210, durationSec: 44 },
  offer: { radius: 240, durationSec: 56 },
  // A protocol position orbits outside the account's own entries: it lives in a contract.
  position: { radius: 265, durationSec: 64 },
  // An allowance also lives in a contract, the token's: it shares the positions' ring.
  allowance: { radius: 265, durationSec: 72 },
  // Shares the outer guide ring: OrbitalScene draws one ring per planned kind.
  generic: { radius: 240, durationSec: 48 },
};

const GOLDEN_ANGLE = 137.5;

const sceneKind = (kind: string): SceneNodeKind =>
  SCENE_NODE_KINDS.find((k) => k === kind) ?? "generic";

/** A plan's node spec as the scene draws it. A kind this client does not know renders as a generic
 *  node rather than failing the run, which would strand a funded account. */
export function buildSceneNode(
  spec: Omit<SceneNodeSpec, "kind"> & { kind: string },
  seq: number
): SceneNode {
  const { id, label } = spec;
  const kind = sceneKind(spec.kind);
  const ring = RING[kind];
  return {
    id,
    kind,
    label,
    balance: null,
    status: "incoming",
    txHash: null,
    orbit: {
      radius: ring.radius,
      durationSec: ring.durationSec + (seq % 3) * 4,
      phaseDeg: (seq * GOLDEN_ANGLE) % 360,
    },
    offer: spec.offer ?? null,
    offerId: null,
  };
}

/** Sets the displayed balance on the already-docked nodes a mess step funds. */
function applyBalanceUpdates(step: MessStepDef): void {
  const { updateNode } = usePlaygroundStore.getState();
  for (const { nodeId, balance } of step.balances) updateNode(nodeId, { balance });
}

const DEMOLISH_STAGGER_MS = 500;

/** More rounds than any playground close takes (it needs one); a close that keeps asking for
 *  another is stopped here instead of looping. */
export const DEMOLISH_MAX_ROUNDS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The progress line before round `round` (zero-based), "Round 2 of about 3" once the API has
 *  estimated what is left. */
export function demolishRoundStatus(round: number, remainingSteps: number | null): string {
  if (round === 0) return "Closing the account...";
  if (remainingSteps === null) return `Closing the account, round ${round + 1}...`;
  const total = Math.max(round + 1, round + remainingSteps);
  return `Closing the account, round ${round + 1} of about ${total}...`;
}

/** Plays one confirmed transaction on the scene, operation by operation, then logs it with its
 *  hash (the log links it to the explorer). */
async function animateConfirmed(entry: DemolishLogEntry): Promise<void> {
  const store = usePlaygroundStore.getState();
  for (const op of entry.operations) {
    const live = usePlaygroundStore.getState().nodes.filter((n) => n.status !== "destroyed");
    const action = operationToSceneAction(op, live);
    if (!action) continue;

    if (action.type === "destroy") {
      store.destroyNodes(action.nodeIds, entry.hash);
    } else if (action.type === "pulse") {
      store.updateNode(action.nodeId, { status: "converting" });
    }
    // "merge" is handled once the close is done - not per-operation, since it's the terminal
    // state for the whole scene.
    await sleep(DEMOLISH_STAGGER_MS);

    // A payment (issuer-return) pulse is transient: reset the node back to "docked" once its
    // stagger window has passed so a round that splits the payment and trustline-removal across
    // separate transactions doesn't leave the node stuck mid-animation.
    if (action.type === "pulse") {
      store.updateNode(action.nodeId, { status: "docked" });
    }
  }
  store.addLog({ label: entry.summary, txHash: entry.hash, kind: "demolish" });
}

export function usePlaygroundExecution(): UsePlaygroundExecutionResult {
  const [progressStatus, setProgressStatus] = useState<string | null>(null);
  const running = useRef(false);
  const nodeSeq = useRef(0);
  // Hashes already played on the scene, so a resumed close never plays a transaction twice.
  const shown = useRef(new Set<string>());
  // The balance before the close started, kept across resumes for the completion summary.
  const preDemolishXlm = useRef<string | null>(null);
  // Whether the session's allowances were revoked, so a resumed close does not list them again.
  const allowancesRevoked = useRef(false);

  const fail = useCallback((err: unknown) => {
    const store = usePlaygroundStore.getState();
    if (err instanceof SessionExpiredError) {
      store.setPhase("EXPIRED");
      return;
    }
    if (!(err instanceof PlaygroundApiError)) console.error("[playground] unexpected error:", err);
    store.setLastError(
      err instanceof PlaygroundApiError ? err.message : GENERIC_ERROR_COPY,
      err instanceof DecisionBlockedError
        ? { decisionIds: err.decisionIds, blockers: [], resolvable: [] }
        : err instanceof PlanBlockedError
          ? { decisionIds: [], blockers: err.blockers, resolvable: err.resolvable }
          : null
    );
    store.setPhase("ERROR");
  }, []);

  const refreshState = useCallback(async (): Promise<StateResponse | null> => {
    const { sessionId, setAccountState } = usePlaygroundStore.getState();
    if (!sessionId) return null;
    const state = await api<StateResponse>(`/session/${sessionId}/state`);
    setAccountState(state.accountState);
    return state;
  }, []);

  /** Phase A: create the custodial account and run the full mess sequence. */
  const start = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    nodeSeq.current = 0;
    shown.current = new Set();
    preDemolishXlm.current = null;
    allowancesRevoked.current = false;
    const store = usePlaygroundStore.getState();

    try {
      store.reset();
      store.setPhase("MESSING");
      setProgressStatus("Creating & funding the demo account...");

      // A random wallet is sent as its replay code, and the server regenerates it.
      const { selection, seed } = usePlaygroundStore.getState();
      const session = await api<SessionResponse>("/session", {
        method: "POST",
        body: JSON.stringify(seed ? { seed } : { selection }),
      });
      usePlaygroundStore.getState().startSession(session);
      usePlaygroundStore.getState().addLog({
        label: `Demo account funded: ${session.demoPublic.slice(0, 8)}…`,
        txHash: null,
        kind: "info",
      });

      for (let i = 0; i < session.messPlan.length; i++) {
        const step = session.messPlan[i];
        const s = usePlaygroundStore.getState();
        s.setCurrentMessIndex(i);
        setProgressStatus(step.label);

        const { txHash } = await api<{ txHash: string | null }>(
          `/session/${session.sessionId}/mess`,
          {
            method: "POST",
            body: JSON.stringify({ stepId: step.id }),
          }
        );

        const after = usePlaygroundStore.getState();
        // A null hash: the step had nothing to send, so its line is not shown as on-chain activity.
        after.addLog({ label: step.label, txHash, kind: txHash === null ? "info" : "mess" });
        if (step.nodes.length > 0) {
          after.dockNodes(
            step.nodes.map((node) => buildSceneNode(node, nodeSeq.current++)),
            txHash
          );
        }
        applyBalanceUpdates(step);

        if (step.id === "SETUP") {
          await refreshState();
        }
      }

      setProgressStatus("Reading the account state...");
      const state = await refreshState();
      if (!state?.accountState) throw new Error("Account state unavailable after the mess phase");
      usePlaygroundStore.getState().bindOffers(state.accountState.openOffers);

      usePlaygroundStore.getState().setPhase("DIRTY");
      // Best effort: without it the page only leaves out the code panel.
      api<unknown>(`/session/${session.sessionId}/sdk-snippet`)
        .then((body) => {
          const now = usePlaygroundStore.getState();
          const snippet = isRecord(body) ? body.snippet : null;
          if (typeof snippet === "string" && now.sessionId === session.sessionId) {
            now.setSdkSnippet(snippet);
          }
        })
        .catch(() => {});
    } catch (err) {
      fail(err);
    } finally {
      setProgressStatus(null);
      running.current = false;
    }
  }, [fail, refreshState]);

  const showConfirmed = useCallback(async (entries: DemolishLogEntry[]) => {
    for (const entry of entries) {
      if (shown.current.has(entry.hash)) continue;
      shown.current.add(entry.hash);
      await animateConfirmed(entry);
    }
  }, []);

  const complete = useCallback((sessionId: string) => {
    if (preDemolishXlm.current) {
      usePlaygroundStore.getState().setRecoveredXlm(preDemolishXlm.current);
    }
    usePlaygroundStore.getState().setPhase("COMPLETE");

    fetch(`/api/session/${sessionId}/cleanup`, { method: "POST" }).catch((err) =>
      console.error("[playground] cleanup request failed:", err)
    );
  }, []);

  /**
   * Before the close: shows what the API's allowance list finds for the demo, then revokes every
   * allowance the session recorded, one request per revoke. The list is best effort, so the record
   * decides what is revoked. The server builds each revoke through the API and signs it only once
   * both revoke checks accept it.
   */
  const revokeAllowances = useCallback(async (sessionId: string) => {
    setProgressStatus("Reading the demo's allowances through the LumenWipe API...");
    const { allowances } = await api<{ allowances: ListedAllowance[] }>(
      `/session/${sessionId}/allowances`
    );
    const listed = allowances.filter((a) => a.listed).length;
    usePlaygroundStore.getState().addLog({
      label: `The API lists ${listed} of the ${allowances.length} allowance${allowances.length === 1 ? "" : "s"} this demo approved`,
      txHash: null,
      kind: "info",
    });
    for (const allowance of allowances) {
      setProgressStatus(`Revoking spender ${allowance.index}'s allowance...`);
      const { txHash } = await api<{ txHash: string }>(`/session/${sessionId}/allowances/revoke`, {
        method: "POST",
        body: JSON.stringify({ spender: allowance.spender }),
      });
      const store = usePlaygroundStore.getState();
      store.destroyNodes([`allowance:${allowance.index}`], txHash);
      store.addLog({
        label: `Revoke spender ${allowance.index}'s allowance`,
        txHash,
        kind: "demolish",
      });
    }
  }, []);

  /**
   * Phase B: run the real close engine server-side one round per request, playing each confirmed
   * transaction as its round returns. Called again after an error, it resumes: the server carries
   * on from the account's live state and settles anything left in flight.
   */
  const demolish = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    const { sessionId } = usePlaygroundStore.getState();

    try {
      if (!sessionId) throw new Error("No active playground session");

      const store = usePlaygroundStore.getState();
      // Captured on the first attempt only: once rounds land, /state's accountState shrinks, and
      // once the merge lands it goes null (the "account no longer exists" success path).
      if (!store.demolishFailed) {
        preDemolishXlm.current = store.accountState?.nativeBalanceLumens ?? null;
      }
      store.setDemolishFailed(false);
      store.setLastError(null);
      store.setPhase("DEMOLISHING");

      const seedsAllowances = store.messPlan.some((s) => s.action.kind === "approve_allowance");
      if (seedsAllowances && !allowancesRevoked.current) {
        await revokeAllowances(sessionId);
        allowancesRevoked.current = true;
      }

      let remainingSteps: number | null = null;
      for (let round = 0; ; round++) {
        if (round === DEMOLISH_MAX_ROUNDS) throw new Error("The close did not converge");
        setProgressStatus(demolishRoundStatus(round, remainingSteps));
        const result = await api<DemolishRoundResponse>(`/session/${sessionId}/demolish/round`, {
          method: "POST",
        });
        await showConfirmed(result.confirmed);
        if (result.done) break;
        remainingSteps = result.remainingSteps;
      }

      complete(sessionId);
    } catch (err) {
      if (sessionId && !(err instanceof SessionExpiredError)) {
        // What a failed round confirmed before it stopped is played too, and a close whose answer
        // was lost after it finished completes instead of offering a resume.
        const state = await refreshState().catch(() => null);
        if (state) await showConfirmed(state.demolishLog);
        if (state?.demolishDone) {
          complete(sessionId);
          return;
        }
        usePlaygroundStore.getState().setDemolishFailed(true);
      }
      fail(err);
    } finally {
      setProgressStatus(null);
      running.current = false;
    }
  }, [complete, fail, refreshState, revokeAllowances, showConfirmed]);

  /** Runs the session's planned fix for a blocker, then resumes the close, which plans again. */
  const resolve = useCallback(
    async (blocker: string) => {
      const { sessionId } = usePlaygroundStore.getState();
      if (!sessionId || running.current) return;
      setProgressStatus("Clearing the blocker...");
      try {
        await api<{ ok: true }>(`/session/${sessionId}/resolve`, {
          method: "POST",
          body: JSON.stringify({ blocker }),
        });
      } catch (err) {
        setProgressStatus(null);
        fail(err);
        return;
      }
      await demolish();
    },
    [demolish, fail]
  );

  return { start, demolish, resolve, progressStatus };
}
