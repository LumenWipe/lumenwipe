"use client";

import { useCallback, useRef, useState } from "react";
import { usePlaygroundStore, type PlaygroundAccounts, type SceneNode, type SceneNodeKind } from "@/store/playground";
import { operationToSceneAction } from "@/lib/scene-actions";
import type { MessStepDef } from "@/lib/mess-plan";
import type { AccountState } from "@lumenwipe/sdk";

interface SessionResponse {
  sessionId: string;
  demoPublic: string;
  expiresAt: number;
  messPlan: MessStepDef[];
  accounts: PlaygroundAccounts;
}

interface StateResponse {
  demoPublic: string;
  accountState: AccountState | null;
  completedMessSteps: string[];
  demolishLog: { txId: string; hash: string; operations: import("@lumenwipe/sdk").IntentOperation[] }[];
  demolishDone: boolean;
}

class SessionExpiredError extends Error {}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (res.status === 404) throw new SessionExpiredError("Session expired");
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new Error(body.detail ?? body.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

/** Random but stable-feeling orbit parameters for a newly docked node. Same
 *  shape the deleted `lib/playground/scene-nodes.ts` used - inlined here since
 *  it was a small, single-purpose helper with no other callers. */
function randomOrbit(seq: number): SceneNode["orbit"] {
  const rings = [95, 135, 175, 215];
  const radius = rings[seq % rings.length];
  const durationSec = 18 + (seq % 5) * 4;
  const phaseDeg = (seq * 47) % 360;
  return { radius, durationSec, phaseDeg };
}

function kindForNodeId(nodeId: string): SceneNodeKind {
  if (nodeId.startsWith("tl:")) return "trustline";
  if (nodeId.startsWith("offer:")) return "offer";
  if (nodeId.startsWith("data:")) return "data";
  return "signer";
}

function labelForNodeId(nodeId: string): string {
  if (nodeId.startsWith("tl:")) return nodeId.slice(3);
  if (nodeId.startsWith("data:")) return nodeId.slice(5);
  if (nodeId.startsWith("offer:")) return `Offer ${nodeId.slice(6)}`;
  return "Extra signer";
}

function buildSceneNode(nodeId: string, seq: number): SceneNode {
  return {
    id: nodeId,
    kind: kindForNodeId(nodeId),
    label: labelForNodeId(nodeId),
    balance: null,
    status: "incoming",
    txHash: null,
    orbit: randomOrbit(seq),
  };
}

const DEMOLISH_REPLAY_STAGGER_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function usePlaygroundExecution() {
  const [progressStatus, setProgressStatus] = useState<string | null>(null);
  const running = useRef(false);
  const nodeSeq = useRef(0);

  const fail = useCallback((err: unknown) => {
    const store = usePlaygroundStore.getState();
    if (err instanceof SessionExpiredError) {
      store.setPhase("EXPIRED");
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    store.setLastError(message);
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
    const store = usePlaygroundStore.getState();

    try {
      store.reset();
      store.setPhase("MESSING");
      setProgressStatus("Creating & funding the demo account...");

      const { selectedMode, customConfig } = usePlaygroundStore.getState();
      const session = await api<SessionResponse>("/session", {
        method: "POST",
        body: JSON.stringify({ mode: selectedMode, customConfig }),
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

        const { txHash } = await api<{ txHash: string }>(`/session/${session.sessionId}/mess`, {
          method: "POST",
          body: JSON.stringify({ stepId: step.id }),
        });

        const after = usePlaygroundStore.getState();
        after.addLog({ label: step.label, txHash, kind: "mess" });
        if (step.nodeIds.length > 0) {
          after.dockNodes(
            step.nodeIds.map((id) => buildSceneNode(id, nodeSeq.current++)),
            txHash
          );
        }

        if (step.id === "SETUP") {
          await refreshState();
        }
      }

      setProgressStatus("Reading the account state...");
      const state = await refreshState();
      if (!state?.accountState) throw new Error("Account state unavailable after the mess phase");

      usePlaygroundStore.getState().setPhase("DIRTY");
    } catch (err) {
      fail(err);
    } finally {
      setProgressStatus(null);
      running.current = false;
    }
  }, [fail, refreshState]);

  /** Phase B: run the real close engine server-side, then replay what it did. */
  const demolish = useCallback(async () => {
    if (running.current) return;
    running.current = true;

    try {
      const { sessionId } = usePlaygroundStore.getState();
      if (!sessionId) throw new Error("No active playground session");

      usePlaygroundStore.getState().setPhase("DEMOLISHING");
      setProgressStatus("Closing the account...");

      const result = await api<{ done: boolean }>(`/session/${sessionId}/demolish`, {
        method: "POST",
      });
      if (!result.done) throw new Error("The close did not complete");

      const state = await refreshState();
      if (!state) throw new Error("Session state unavailable after demolish");

      for (const entry of state.demolishLog) {
        const store = usePlaygroundStore.getState();
        for (const op of entry.operations) {
          const liveNodeIds = usePlaygroundStore
            .getState()
            .nodes.filter((n) => n.status !== "destroyed")
            .map((n) => n.id);
          const action = operationToSceneAction(op, liveNodeIds);
          if (!action) continue;

          if (action.type === "destroy") {
            store.destroyNodes(action.nodeIds, entry.hash);
          } else if (action.type === "pulse") {
            store.updateNode(action.nodeId, { status: "converting" });
          }
          // "merge" is handled after the loop, once, below - not per-operation,
          // since it's the terminal state for the whole scene.
          await sleep(DEMOLISH_REPLAY_STAGGER_MS);
        }
        store.addLog({ label: "Close transaction confirmed", txHash: entry.hash, kind: "demolish" });
      }

      const finalState = usePlaygroundStore.getState().accountState;
      const recovered = finalState?.nativeBalanceLumens ?? null;
      if (recovered) usePlaygroundStore.getState().setRecoveredXlm(recovered);
      usePlaygroundStore.getState().setPhase("COMPLETE");

      fetch(`/api/session/${sessionId}/cleanup`, { method: "POST" }).catch((err) =>
        console.error("[playground] cleanup request failed:", err)
      );
    } catch (err) {
      fail(err);
    } finally {
      setProgressStatus(null);
      running.current = false;
    }
  }, [fail, refreshState]);

  return { start, demolish, progressStatus };
}
