"use client";

import { useState, useCallback } from "react";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import { submitAndWait } from "@/lib/stellar/submit";
import { saveSession } from "@/lib/session/store";
import { buildStepXdrForPlan } from "@/lib/stellar/step-engine";
import { requestMediatorCosignature } from "@/lib/stellar/mediator";
import { notifyStatsRefresh } from "@/lib/stats-events";
import type { PlannedStep } from "@/types/plan";

export function useStepExecution() {
  const network = useNetworkStore((s) => s.network);

  // Fine-grained selectors: this hook only re-renders when one of these
  // specific values changes, not on every store write during execution.
  const sourceAddress = useDemolishStore((s) => s.sourceAddress);
  const destinationAddress = useDemolishStore((s) => s.destinationAddress);
  const accountState = useDemolishStore((s) => s.accountState);
  const memo = useDemolishStore((s) => s.memo);
  const memoType = useDemolishStore((s) => s.memoType);
  const mediatorRequired = useDemolishStore((s) => s.mediatorRequired);
  const mediatorPublicKey = useDemolishStore((s) => s.mediatorPublicKey);
  const sessionId = useDemolishStore((s) => s.sessionId);

  const markStepConfirmed = useDemolishStore((s) => s.markStepConfirmed);
  const markStepFailed = useDemolishStore((s) => s.markStepFailed);
  const updateStep = useDemolishStore((s) => s.updateStep);
  const setPhase = useDemolishStore((s) => s.setPhase);

  const [progressStatus, setProgressStatus] = useState<string | null>(null);

  const buildStepXdr = useCallback(
    async (step: PlannedStep): Promise<string> => {
      if (!sourceAddress || !accountState || !destinationAddress) {
        throw new Error("Missing account state for transaction building");
      }
      return buildStepXdrForPlan(step, {
        network,
        sourceAddress,
        accountState,
        destinationAddress,
        memo,
        memoType,
        mediatorRequired,
        // Read live plan at call time to avoid staleness between batched steps.
        executionPlan: useDemolishStore.getState().executionPlan,
      });
    },
    [network, sourceAddress, accountState, destinationAddress, memo, memoType, mediatorRequired]
  );

  const executeStep = useCallback(
    async (step: PlannedStep, secretKey: string) => {
      setPhase("STEP_EXECUTING");
      updateStep(step.index, { status: "signing" });

      try {
        setProgressStatus("Building transaction...");
        const unsigned = await buildStepXdr(step);
        updateStep(step.index, { txXdr: unsigned });

        setProgressStatus("Signing transaction...");
        const passphrase = NETWORK_PASSPHRASES[network];
        const tx = TransactionBuilder.fromXDR(unsigned, passphrase);
        const keypair = Keypair.fromSecret(secretKey);
        tx.sign(keypair);
        const signedXdr = tx.toEnvelope().toXDR("base64");

        updateStep(step.index, { status: "submitted" });

        // MERGE through the shared mediator: the user signed their half (the
        // merge); the backend co-signs the mediator's forward payment. It is a
        // single atomic transaction, so funds cannot be diverted.
        if (step.type === "MERGE" && mediatorRequired) {
          setProgressStatus("Co-signing the forward payment...");
          const cosignedXdr = await requestMediatorCosignature(signedXdr, network);
          setProgressStatus("Submitting to Stellar network...");
          const { txHash } = await submitAndWait(cosignedXdr, network, setProgressStatus);
          markStepConfirmed(step.index, txHash);
          recordMergeStats(txHash, network);
        } else {
          setProgressStatus("Submitting to Stellar network...");
          const { txHash } = await submitAndWait(signedXdr, network, setProgressStatus);
          markStepConfirmed(step.index, txHash);
          if (step.type === "MERGE") recordMergeStats(txHash, network);
        }

        // Read the live plan AFTER markStepConfirmed so the persisted record
        // includes the step we just confirmed (the closure's executionPlan
        // snapshot would be one step behind).
        if (sessionId && sourceAddress && destinationAddress) {
          const currentPlan = useDemolishStore.getState().executionPlan;
          await saveSession({
            id: sessionId,
            network,
            sourceAddress,
            destinationAddress,
            memo,
            mediatorPublicKey,
            completedSteps: currentPlan
              .filter((s) => s.status === "confirmed" && s.txHash)
              .map((s) => ({
                index: s.index,
                type: s.type,
                txHash: s.txHash!,
                confirmedAt: new Date().toISOString(),
              })),
            currentStepIndex: step.index + 1,
            status: "in_progress",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
        markStepFailed(step.index, message);
      } finally {
        setProgressStatus(null);
      }
    },
    [
      network,
      sourceAddress,
      destinationAddress,
      memo,
      mediatorRequired,
      mediatorPublicKey,
      sessionId,
      buildStepXdr,
      markStepConfirmed,
      markStepFailed,
      updateStep,
      setPhase,
    ]
  );

  return { executeStep, progressStatus, buildStepXdr };
}

/**
 * Tells the backend to count this merge without blocking the execution flow.
 * The live-stats refresh only fires once the backend confirms the record;
 * failures are logged so they remain diagnosable.
 */
function recordMergeStats(txHash: string, network: string): void {
  fetch("/api/stats/record", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txHash, network }),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`stats record returned ${res.status}`);
      notifyStatsRefresh();
    })
    .catch((err) => {
      console.error(`Failed to record merge stats for tx ${txHash}:`, err);
    });
}
