"use client";

import { useCallback, useRef, useState } from "react";
import {
  usePlaygroundStore,
  type PlaygroundAccounts,
  type SceneNode,
  type SceneNodeKind,
} from "@/store/playground";
import { operationToSceneAction } from "@/lib/scene-actions";
import {
  EPHEMERAL_ASSETS,
  EURC_DEMO_AMOUNT,
  JUNK_DATA_ENTRIES,
  JUNK_OFFERS,
  LWDEMO_AMOUNT,
  USDC_DEMO_AMOUNT,
  type MessStepDef,
} from "@/lib/mess-plan";
import type { AccountState, IntentOperation } from "@lumenwipe/sdk";

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
  demolishLog: { txId: string; hash: string; summary: string; operations: IntentOperation[] }[];
  demolishDone: boolean;
}

interface UsePlaygroundExecutionResult {
  start: () => void;
  demolish: () => void;
  progressStatus: string | null;
}

class SessionExpiredError extends Error {}

// Plain-language mapping for the machine error codes the playground's own
// routes return (see app/api/session/**/route.ts) - CLAUDE.md's "user-facing
// errors are plain language; never surface raw SDK codes or stack traces"
// invariant applies here too, not just to apps/api/apps/web. Any code not
// listed here (including a raw `detail` string from an underlying SDK error)
// falls through to the generic message - it never reaches the user verbatim.
const ERROR_MESSAGES: Record<string, string> = {
  session_not_found: "This demo session expired. Start a new one.",
  friendbot_failed: "Could not fund the demo account. Please try again.",
  rate_limited: "Too many attempts. Please wait a moment and try again.",
};

function plainErrorMessage(code: string | undefined): string {
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  return "Something went wrong. Please try again.";
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (res.status === 404) throw new SessionExpiredError("Session expired");
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new Error(plainErrorMessage(body.error));
  }
  return (await res.json()) as T;
}

// Orbit radius/duration by node kind - matches the deleted
// `lib/playground/scene-nodes.ts` (git show f416924^:apps/web/lib/playground/scene-nodes.ts),
// inlined here since it was a small, single-purpose helper with no other
// callers. One ring per kind is what OrbitalScene's four RING_FRACTIONS guide
// rings visually group by.
const RING: Record<SceneNodeKind, { radius: number; durationSec: number }> = {
  signer: { radius: 95, durationSec: 26 },
  trustline: { radius: 135, durationSec: 34 },
  data: { radius: 175, durationSec: 44 },
  offer: { radius: 215, durationSec: 56 },
};

const GOLDEN_ANGLE = 137.5;

function offerLabel(index: number): string {
  const o = JUNK_OFFERS[index];
  if (!o) return `Offer #${index + 1}`;
  const sell = o.selling === "native" ? "XLM" : o.selling;
  const buy = o.buying === "native" ? "XLM" : o.buying;
  return `Sell ${sell} → ${buy}`;
}

function buildSceneNode(nodeId: string, seq: number): SceneNode {
  const [prefix, rest] = nodeId.split(":");

  let kind: SceneNodeKind;
  let label: string;

  switch (prefix) {
    case "tl":
      kind = "trustline";
      label = rest;
      break;
    case "data":
      kind = "data";
      label = JUNK_DATA_ENTRIES.find((d) => d.key === rest)?.key ?? rest;
      break;
    case "offer":
      kind = "offer";
      label = offerLabel(Number(rest));
      break;
    case "signer":
      kind = "signer";
      label = "Forgotten co-signer";
      break;
    default:
      throw new Error(`Unknown scene node id: ${nodeId}`);
  }

  const ring = RING[kind];
  return {
    id: nodeId,
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
  };
}

/** Updates the displayed balance on an already-docked node when a mess step
 *  funds it rather than creating it (`MessStepDef.updatesNodeIds`) - ports the
 *  deleted `applyBalanceUpdates` (git show f416924^:apps/web/hooks/usePlaygroundExecution.ts). */
function applyBalanceUpdates(step: MessStepDef): void {
  const { updateNode } = usePlaygroundStore.getState();
  if (step.id === "FUND_RARE") {
    for (const nodeId of step.updatesNodeIds) {
      const code = nodeId.startsWith("tl:") ? nodeId.slice(3) : null;
      if (!code) continue;
      const amount = EPHEMERAL_ASSETS.find((a) => a.code === code)?.amount ?? null;
      if (amount) updateNode(nodeId, { balance: amount });
    }
  }
  if (step.id === "FUND_LWDEMO") updateNode("tl:LWDEMO", { balance: LWDEMO_AMOUNT });
  if (step.id === "FUND_USDC") updateNode("tl:USDC", { balance: USDC_DEMO_AMOUNT });
  if (step.id === "FUND_EURC") updateNode("tl:EURC", { balance: EURC_DEMO_AMOUNT });
}

const DEMOLISH_REPLAY_STAGGER_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function usePlaygroundExecution(): UsePlaygroundExecutionResult {
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
        applyBalanceUpdates(step);

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

      // Captured before any further state-refreshing: once the demolish POST
      // below completes, the account is merged away and /state's accountState
      // goes null (the "account no longer exists" success path), so this is
      // the last point the DIRTY-phase balance is still live in the store.
      const preDemolishXlm =
        usePlaygroundStore.getState().accountState?.nativeBalanceLumens ?? null;

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

          // A payment (issuer-return) pulse is transient: reset the node back
          // to "docked" once its stagger window has passed so a future round
          // that splits the payment and trustline-removal across separate
          // transactions doesn't leave the node stuck mid-animation.
          if (action.type === "pulse") {
            store.updateNode(action.nodeId, { status: "docked" });
          }
        }
        store.addLog({ label: entry.summary, txHash: entry.hash, kind: "demolish" });
      }

      if (preDemolishXlm) usePlaygroundStore.getState().setRecoveredXlm(preDemolishXlm);
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
