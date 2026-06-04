"use client";

import { useState, useCallback } from "react";
import { Keypair, TransactionBuilder, Account } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASES, getMediatorPublicKey } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import { getRpcServer } from "@/lib/stellar/rpc";
import { submitAndWait } from "@/lib/stellar/submit";
import { saveSession } from "@/lib/session/store";
import { fetchConversionPath } from "@/lib/se-api/paths";
import { buildRemoveDataEntriesTx } from "@/lib/stellar/tx-builder/data-entries";
import { buildCancelOffersTx } from "@/lib/stellar/tx-builder/offers";
import {
  buildConvertAssetTx,
  buildSendToIssuerTx,
} from "@/lib/stellar/tx-builder/asset-conversion";
import { buildRemoveTrustlinesTx } from "@/lib/stellar/tx-builder/trustlines";
import { buildNormalizeSignersTx } from "@/lib/stellar/tx-builder/signers";
import { buildMergeTx, buildMediatorMergePaymentTx } from "@/lib/stellar/tx-builder/merge";
import { requestMediatorCosignature } from "@/lib/stellar/mediator";
import { batchItems } from "@/lib/stellar/tx-builder/batching";
import type { PlannedStep } from "@/types/plan";

export function useStepExecution() {
  const network = useNetworkStore((s) => s.network);
  const store = useDemolishStore();
  const [progressStatus, setProgressStatus] = useState<string | null>(null);

  // Build unsigned XDR for a given step using the current on-chain sequence
  const buildStepXdr = useCallback(
    async (step: PlannedStep): Promise<string> => {
      const { sourceAddress, accountState, destinationAddress, memo, memoType } = store;
      if (!sourceAddress || !accountState || !destinationAddress) {
        throw new Error("Missing account state for transaction building");
      }

      const server = getRpcServer(network);
      const liveAccount = await server.getAccount(sourceAddress);
      const sdkAccount = new Account(sourceAddress, liveAccount.sequenceNumber());

      // Find which batch of items this step corresponds to
      const { dataEntries, openOffers, trustlines, signers } = accountState;

      switch (step.type) {
        case "NORMALIZE_SIGNERS": {
          const extras = signers.filter((s) => s.key !== sourceAddress);
          return buildNormalizeSignersTx(sdkAccount, extras, network);
        }

        case "REMOVE_DATA_ENTRIES": {
          const batches = batchItems(dataEntries, 100);
          const batchIdx = getBatchIndex(step, "REMOVE_DATA_ENTRIES", store.executionPlan);
          return buildRemoveDataEntriesTx(sdkAccount, batches[batchIdx] ?? dataEntries, network);
        }

        case "CANCEL_OFFERS": {
          const batches = batchItems(openOffers, 100);
          const batchIdx = getBatchIndex(step, "CANCEL_OFFERS", store.executionPlan);
          return buildCancelOffersTx(sdkAccount, batches[batchIdx] ?? openOffers, network);
        }

        case "CONVERT_ASSETS": {
          const tl = trustlines.find((t) => t.asset === step.affectedAsset);
          if (!tl) throw new Error(`Trustline not found: ${step.affectedAsset}`);
          const path = await fetchConversionPath(tl.asset, tl.balance, network);
          if (!path) {
            return buildSendToIssuerTx(sdkAccount, tl, network);
          }
          return buildConvertAssetTx(sdkAccount, tl, path, network);
        }

        case "REMOVE_TRUSTLINES": {
          const batches = batchItems(trustlines, 100);
          const batchIdx = getBatchIndex(step, "REMOVE_TRUSTLINES", store.executionPlan);
          return buildRemoveTrustlinesTx(sdkAccount, batches[batchIdx] ?? trustlines, network);
        }

        case "MERGE": {
          if (store.mediatorRequired) {
            const mediator = getMediatorPublicKey(network);
            if (!mediator) {
              throw new Error(
                "This destination needs the exchange (mediator) flow, but no shared mediator account is configured on this deployment."
              );
            }
            // Forward essentially the full live balance through the shared mediator.
            const res = await fetch(`/api/${network}/account/${sourceAddress}`);
            if (!res.ok) {
              throw new Error("Could not read the account balance to build the merge.");
            }
            const live = (await res.json()) as { nativeBalanceLumens: string };
            return buildMediatorMergePaymentTx(
              sdkAccount,
              mediator,
              destinationAddress,
              live.nativeBalanceLumens,
              memo,
              network,
              memoType
            );
          }
          return buildMergeTx(sdkAccount, destinationAddress, memo, network, memoType);
        }

        default:
          throw new Error(`Unknown step type: ${step.type}`);
      }
    },
    [network, store]
  );

  const executeStep = useCallback(
    async (step: PlannedStep, secretKey: string) => {
      const {
        markStepConfirmed,
        markStepFailed,
        updateStep,
        setPhase,
        sessionId,
        sourceAddress,
        destinationAddress,
        memo,
        mediatorRequired,
        mediatorPublicKey,
        executionPlan,
      } = store;

      setPhase("STEP_EXECUTING");
      updateStep(step.index, { status: "signing" });

      try {
        setProgressStatus("Building transaction...");
        const unsigned = await buildStepXdr(step);
        updateStep(step.index, { txXdr: unsigned });

        // Sign with the provided secret key
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

        // Persist session progress
        if (sessionId && sourceAddress && destinationAddress) {
          await saveSession({
            id: sessionId,
            network,
            sourceAddress,
            destinationAddress,
            memo: memo,
            mediatorPublicKey,
            completedSteps: executionPlan
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
    [network, store, buildStepXdr]
  );

  return { executeStep, progressStatus, buildStepXdr };
}

function getBatchIndex(step: PlannedStep, type: string, plan: PlannedStep[]): number {
  const stepsOfType = plan.filter((s) => s.type === type);
  return stepsOfType.findIndex((s) => s.index === step.index);
}

/**
 * Fire-and-forget: tells the backend to count this merge.
 * Never blocks the UI - errors are swallowed intentionally.
 */
function recordMergeStats(txHash: string, network: string): void {
  fetch("/api/stats/record", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txHash, network }),
  }).catch(() => {
    // stats are non-critical - ignore failures
  });
}
