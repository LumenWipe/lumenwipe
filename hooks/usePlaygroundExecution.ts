"use client";

import { useCallback, useRef, useState } from "react";
import { usePlaygroundStore } from "@/store/playground";
import type { PlaygroundAccounts } from "@/store/playground";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { buildStepXdrForPlan } from "@/lib/stellar/step-engine";
import { submitAndWait } from "@/lib/stellar/submit";
import { NoConversionPathError } from "@/lib/utils/errors";
import { buildSceneNode } from "@/lib/playground/scene-nodes";
import {
  EURC_DEMO_AMOUNT,
  LWDEMO_AMOUNT,
  USDC_DEMO_AMOUNT,
  type MessStepDef,
} from "@/lib/playground/mess-plan";
import { parseAsset } from "@/lib/utils/assets";
import type { AccountState } from "@/types/account";
import type { PlannedStep } from "@/types/plan";

interface SessionResponse {
  sessionId: string;
  demoPublic: string;
  expiresAt: number;
  messPlan: MessStepDef[];
  accounts: PlaygroundAccounts;
}

class SessionExpiredError extends Error {}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/playground${path}`, {
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

  const refreshState = useCallback(async (): Promise<AccountState | null> => {
    const { sessionId, setAccountState } = usePlaygroundStore.getState();
    if (!sessionId) return null;
    const { accountState } = await api<{ accountState: AccountState | null }>(
      `/session/${sessionId}/state`
    );
    setAccountState(accountState);
    return accountState;
  }, []);

  /** Phase A: create the custodial account and run the full mess sequence. */
  const start = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    nodeSeq.current = 0;
    const store = usePlaygroundStore.getState();

    try {
      store.reset();
      store.setPhase("CREATING_ACCOUNT");
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

        // After SETUP the account exists on-chain with its initial XLM balance.
        // Fetch it immediately so CoreAccount shows the real balance rather than
        // 0 throughout the entire mess phase.
        if (step.id === "SETUP") {
          await refreshState();
        }
      }

      setProgressStatus("Reading the account state...");
      const accountState = await refreshState();
      if (!accountState) throw new Error("Account state unavailable after the mess phase");

      const final = usePlaygroundStore.getState();
      final.setPlan(buildPlan(accountState, false).steps);
      final.setPhase("DIRTY");
    } catch (err) {
      fail(err);
    } finally {
      setProgressStatus(null);
      running.current = false;
    }
  }, [fail, refreshState]);

  /** Phase B: run the real demolish engine, signing remotely. */
  const demolish = useCallback(async () => {
    if (running.current) return;
    running.current = true;

    try {
      const { sessionId, demoPublic, accounts } = usePlaygroundStore.getState();
      if (!sessionId || !demoPublic || !accounts) {
        throw new Error("No active playground session");
      }
      usePlaygroundStore.getState().setPhase("DEMOLISHING");

      const signRemotely = async (unsignedXdr: string): Promise<string> => {
        const { transaction } = await api<{ transaction: string }>(`/session/${sessionId}/sign`, {
          method: "POST",
          body: JSON.stringify({ transaction: unsignedXdr }),
        });
        return transaction;
      };

      const plan = usePlaygroundStore.getState().executionPlan;
      for (const planned of plan) {
        if (planned.status === "confirmed") continue;
        const store = usePlaygroundStore.getState();
        const step: PlannedStep = { ...planned, status: "pending", error: null };
        store.setCurrentStepIndex(step.index);
        store.updateStep(step.index, { status: "signing", error: null });

        const accountState = store.accountState;
        if (!accountState) throw new Error("Account state missing during demolish");

        const ctx = {
          network: "testnet" as const,
          sourceAddress: demoPublic,
          accountState,
          destinationAddress: accounts.mm,
          memo: null,
          memoType: null,
          mediatorRequired: false,
          executionPlan: plan,
          assetDispositions: {},
        };

        setProgressStatus(`Building: ${step.title}`);
        let unsigned: string;
        try {
          unsigned = await buildStepXdrForPlan(step, ctx);
        } catch (err) {
          if (err instanceof NoConversionPathError && step.type === "CONVERT_ASSETS") {
            // No DEX route for this junk asset: return it to its issuer instead.
            store.updateStep(step.index, { fallbackToIssuer: true });
            unsigned = await buildStepXdrForPlan({ ...step, fallbackToIssuer: true }, ctx);
          } else {
            throw err;
          }
        }

        markConverting(step);

        setProgressStatus(`Signing: ${step.title}`);
        const signed = await signRemotely(unsigned);

        store.updateStep(step.index, { status: "submitted" });
        const { txHash } = await submitAndWait(signed, "testnet", setProgressStatus);

        const after = usePlaygroundStore.getState();
        after.markStepConfirmed(step.index, txHash);
        after.addLog({ label: step.title, txHash, kind: "demolish" });
        applyDemolishNodeEffects(step, txHash);

        if (step.type === "MERGE") {
          // The merge transfers the full remaining balance to the MM.
          if (accountState.nativeBalanceLumens) {
            after.setRecoveredXlm(accountState.nativeBalanceLumens);
          }
          after.setPhase("COMPLETE");
          // Count this demolish in the global stats (testnet).
          fetch("/api/stats/record", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ txHash, network: "testnet" }),
          }).catch((err) => console.error("[playground] stats record failed:", err));
          // Best-effort: recycle ephemeral issuers and drop the session.
          fetch(`/api/playground/session/${sessionId}/cleanup`, { method: "POST" }).catch((err) =>
            console.error("[playground] cleanup request failed:", err)
          );
        } else {
          await refreshState();
        }
      }
    } catch (err) {
      fail(err);
    } finally {
      setProgressStatus(null);
      running.current = false;
    }
  }, [fail, refreshState]);

  return { start, demolish, progressStatus };
}

function applyBalanceUpdates(step: MessStepDef): void {
  const { updateNode } = usePlaygroundStore.getState();
  if (step.id === "FUND_RARE") {
    // Update all nodes that are listed in the step's updatesNodeIds.
    for (const nodeId of step.updatesNodeIds) {
      const code = nodeId.startsWith("tl:") ? nodeId.slice(3) : null;
      if (!code) continue;
      const amount = code === "AIRDROP1" ? "1000000" : code === "RUGPULL" ? "13.37" : null;
      if (amount) updateNode(nodeId, { balance: amount });
    }
  }
  if (step.id === "FUND_LWDEMO") updateNode("tl:LWDEMO", { balance: LWDEMO_AMOUNT });
  if (step.id === "FUND_USDC") updateNode("tl:USDC", { balance: USDC_DEMO_AMOUNT });
  if (step.id === "FUND_EURC") updateNode("tl:EURC", { balance: EURC_DEMO_AMOUNT });
}

function markConverting(step: PlannedStep): void {
  if (step.type !== "CONVERT_ASSETS" || !step.affectedAsset) return;
  const { code } = parseAsset(step.affectedAsset);
  usePlaygroundStore.getState().updateNode(`tl:${code}`, { status: "converting" });
}

function applyDemolishNodeEffects(step: PlannedStep, txHash: string): void {
  const store = usePlaygroundStore.getState();
  const byKind = (kind: string) =>
    store.nodes.filter((n) => n.kind === kind && n.status !== "destroyed").map((n) => n.id);

  switch (step.type) {
    case "NORMALIZE_SIGNERS":
      store.destroyNodes(byKind("signer"), txHash);
      break;
    case "REMOVE_DATA_ENTRIES":
      store.destroyNodes(byKind("data"), txHash);
      break;
    case "CANCEL_OFFERS":
      store.destroyNodes(byKind("offer"), txHash);
      break;
    case "CONVERT_ASSETS": {
      if (!step.affectedAsset) break;
      const { code } = parseAsset(step.affectedAsset);
      store.updateNode(`tl:${code}`, { status: "docked", balance: "0" });
      break;
    }
    case "REMOVE_TRUSTLINES":
      store.destroyNodes(byKind("trustline"), txHash);
      break;
    case "MERGE":
      break;
  }
}
