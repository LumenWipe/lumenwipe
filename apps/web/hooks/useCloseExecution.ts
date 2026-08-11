"use client";

import { useCallback, useState } from "react";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import type { CloseTransaction } from "@lumenwipe/sdk";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import { runClose } from "@/lib/api/close-engine";
import { fetchCloseTransactions } from "@/lib/api/close-client";
import { claimableSelectionsToDecisions, dispositionsToDecisions } from "@/lib/api/close-decisions";
import { verifyCloseTransaction } from "@/lib/stellar/verify";
import { submitViaApi } from "@/lib/stellar/submit-via-api";
import { requestMediatorCosignature } from "@/lib/stellar/mediator";
import { notifyStatsRefresh } from "@/lib/stats-events";
import type { TransactionSigner } from "@/lib/stellar/signer";

/**
 * Drives a full close against the API: the browser fetches unsigned transactions round by
 * round, VERIFIES each one against the user's own choices before signing (the trust anchor),
 * signs via the given signer (co-signing the mediator forward payment when needed), submits
 * through the proxy, and marks the plan steps each transaction covers as confirmed. The
 * account state is re-read server-side every round, so an interrupted close resumes by
 * simply running again.
 */
export function useCloseExecution() {
  const network = useNetworkStore((s) => s.network);
  const sourceAddress = useDemolishStore((s) => s.sourceAddress);
  const destinationAddress = useDemolishStore((s) => s.destinationAddress);
  const memo = useDemolishStore((s) => s.memo);
  const mediatorRequired = useDemolishStore((s) => s.mediatorRequired);
  const mediatorPublicKey = useDemolishStore((s) => s.mediatorPublicKey);
  const markCoveredConfirmed = useDemolishStore((s) => s.markCoveredConfirmed);
  const setPhase = useDemolishStore((s) => s.setPhase);
  const setLastError = useDemolishStore((s) => s.setLastError);

  const [progressStatus, setProgressStatus] = useState<string | null>(null);

  const run = useCallback(
    async (signer: TransactionSigner): Promise<void> => {
      if (!sourceAddress || !destinationAddress) {
        setLastError("Missing account or destination.");
        setPhase("STEP_FAILED");
        return;
      }

      const passphrase = NETWORK_PASSPHRASES[network];
      const mediator = mediatorRequired ? mediatorPublicKey : null;
      // Read dispositions/selections live so a mid-flow re-decision is honored.
      const claimableBalanceSelections = useDemolishStore.getState().claimableBalanceSelections;
      const decisions = [
        ...dispositionsToDecisions(useDemolishStore.getState().assetDispositions),
        ...claimableSelectionsToDecisions(claimableBalanceSelections),
      ];
      // The set of assets the user themselves chose to add a trustline for, to claim an
      // otherwise-unreachable balance - verify()'s only basis for allowing a raised (non-
      // removal) change_trust op. Sourced from the user's own decisions, never the API.
      const claimTrustlineAssets = Object.entries(claimableBalanceSelections)
        .filter(([, selection]) => selection === "add_trustline_then_claim")
        .map(([balanceId]) => {
          const balance = useDemolishStore
            .getState()
            .accountState?.claimableBalances.find((b) => b.id === balanceId);
          return balance?.asset ?? null;
        })
        .filter((asset): asset is string => asset !== null);

      setPhase("STEP_EXECUTING");
      try {
        await runClose({
          getTransactions: () =>
            fetchCloseTransactions(
              {
                source: sourceAddress,
                destination: destinationAddress,
                decisions,
                memo: memo ?? undefined,
              },
              network
            ),
          verify: (tx: CloseTransaction) =>
            verifyCloseTransaction({
              unsignedXdr: tx.xdr,
              network,
              expected: {
                source: sourceAddress,
                destination: destinationAddress,
                mediator,
                memo,
                claimTrustlineAssets,
              },
            }),
          signAndSubmit: async (tx: CloseTransaction) => {
            setProgressStatus("Signing transaction…");
            let signedXdr = await signer.sign(tx.xdr, passphrase);

            // A merge through the shared mediator is one atomic transaction: the user
            // signed the merge; the backend co-signs the mediator's forward payment. It
            // cannot change destination or amount, so funds can never be diverted.
            if (mediator && tx.covers.includes("MERGE")) {
              setProgressStatus("Co-signing the forward payment…");
              // The user's signature already binds the exact transaction verify() approved.
              // Defense-in-depth: the mediator may ONLY add its signature — assert it did not
              // alter the body (the tx hash is over the body, not the signatures) before submit.
              const approvedHash = TransactionBuilder.fromXDR(signedXdr, passphrase)
                .hash()
                .toString("hex");
              const cosignedXdr = await requestMediatorCosignature(signedXdr, network);
              const cosigned = TransactionBuilder.fromXDR(cosignedXdr, passphrase);
              if (cosigned.hash().toString("hex") !== approvedHash) {
                throw new Error("The co-signed transaction does not match what you approved.");
              }
              signedXdr = cosignedXdr;
            }

            setProgressStatus("Submitting to Stellar network…");
            const { txHash } = await submitViaApi(signedXdr, network);
            return txHash;
          },
          onConfirmed: (tx, hash) => {
            markCoveredConfirmed(tx.covers, hash);
            if (tx.covers.includes("MERGE") || tx.covers.includes("CLOSE_ACCOUNT")) {
              recordMergeStats(hash, network);
            }
          },
          onProgress: setProgressStatus,
        });
        setPhase("COMPLETE");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : typeof err === "string" ? err : "The close failed.";
        setLastError(message);
        setPhase("STEP_FAILED");
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
      markCoveredConfirmed,
      setPhase,
      setLastError,
    ]
  );

  return { run, progressStatus };
}

/**
 * Records a confirmed merge for the live stats counter without blocking execution.
 * Failures are logged, not surfaced — the close already succeeded.
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
