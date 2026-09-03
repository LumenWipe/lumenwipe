"use client";

import { useCallback, useRef, useState } from "react";
import { exitExpectations } from "@/lib/stellar/exit-expectations";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import type { CloseTransaction } from "@lumenwipe/sdk";
import type { AccountState } from "@/types/account";
import type { AssetDisposition } from "@/types/plan";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import { runClose, InsufficientSignatureWeightError, type PendingRound } from "@lumenwipe/sdk";
import { fetchCloseTransactions } from "@/lib/api/close-client";
import {
  chosenTransfers,
  claimableSelectionsToDecisions,
  destinationAcknowledgementToDecisions,
  dispositionsToDecisions,
} from "@/lib/api/close-decisions";
import { verifyCloseTransaction } from "@/lib/stellar/verify";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import { requiredSignatureWeight } from "@/lib/stellar/thresholds";
import { evaluateSignatureContributions, accumulatedWeight } from "@/lib/stellar/signature-weight";
import { verifyPreAuthTxHash } from "@/lib/stellar/pre-auth-tx";
import { submitViaApi } from "@/lib/stellar/submit-via-api";
import { requestMediatorCosignature } from "@/lib/stellar/mediator";
import { notifyStatsRefresh } from "@/lib/stats-events";
import type { TransactionSigner } from "@/lib/stellar/signer";
import type { AccountSigner } from "@/types/account";

/** Required vs. accumulated signing weight for the transaction that stopped a close, plus the
 *  account's known signers who haven't contributed yet - consumed by the multi-wallet-switch UI
 *  (issue #100) to let the user bring in another signer without re-deriving this state. */
export interface SignatureStatus {
  requiredWeight: number;
  accumulatedWeight: number;
  remainingSigners: AccountSigner[];
}

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
  const markCoveredConfirmed = useDemolishStore((s) => s.markCoveredConfirmed);
  const setPhase = useDemolishStore((s) => s.setPhase);
  const setLastError = useDemolishStore((s) => s.setLastError);

  const [progressStatus, setProgressStatus] = useState<string | null>(null);
  const [signatureStatus, setSignatureStatus] = useState<SignatureStatus | null>(null);
  // Survives across separate run() calls on the same hook instance (unlike state, a ref
  // update doesn't itself trigger a re-render) so a second signer resumes onto the exact
  // partially-signed envelope the first signer left behind, instead of re-fetching and
  // discarding that signature.
  const pendingRoundRef = useRef<PendingRound | null>(null);

  const run = useCallback(
    async (signer: TransactionSigner): Promise<void> => {
      if (!sourceAddress || !destinationAddress) {
        // Both guards below run before the try/catch that normally clears this pending
        // state on an unrelated failure - without clearing it here too, a paused
        // ("needs another signer") panel would stay stuck on screen forever with no
        // indication anything went wrong, since ExecutionWizard only renders `lastError`
        // once `signatureStatus` is cleared.
        pendingRoundRef.current = null;
        setSignatureStatus(null);
        setLastError("Missing account or destination.");
        setPhase("STEP_FAILED");
        return;
      }

      // A valid signer is any key the account actually recognizes - for a single-sig account
      // that's just the master key (itself listed in accountState.signers, per
      // apps/api/src/lib/stellar/account.ts), for a multisig account it's any co-signer.
      const knownSigners = useDemolishStore.getState().accountState?.signers ?? [];
      if (!knownSigners.some((s) => s.key === signer.publicKey)) {
        pendingRoundRef.current = null;
        setSignatureStatus(null);
        setLastError(
          "The signer you're using isn't one of this account's known signers. Reconnect the correct wallet or secret key and try again."
        );
        setPhase("STEP_FAILED");
        return;
      }

      const passphrase = NETWORK_PASSPHRASES[network];
      // Read dispositions/selections live so a mid-flow re-decision is honored.
      const claimableBalanceSelections = useDemolishStore.getState().claimableBalanceSelections;
      const accountState = useDemolishStore.getState().accountState;
      const decisions = [
        ...dispositionsToDecisions(
          useDemolishStore.getState().assetDispositions,
          useDemolishStore.getState().transferDestinations
        ),
        ...claimableSelectionsToDecisions(claimableBalanceSelections),
        // Carried through to every build round: the API refuses to build a close into a
        // destination it doesn't recognize until the user has confirmed they control it.
        ...destinationAcknowledgementToDecisions(
          useDemolishStore.getState().destinationAcknowledgedFor,
          useDemolishStore.getState().destinationAddress
        ),
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
      setSignatureStatus(null);
      try {
        await runClose(
          {
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
                  mediatorRequired,
                  // The floor under the forwarded amount. Empty defaults fail closed: with no
                  // balance read, any forward is judged short rather than trusted.
                  nativeBalance: accountState?.nativeBalanceLumens ?? "0",
                  memo,
                  claimTrustlineAssets,
                  // Empty defaults fail closed: if account state somehow wasn't loaded by
                  // execution time, a set_options op touching any signer is rejected rather
                  // than trusted.
                  accountSigners: accountState?.signers ?? [],
                  accountThresholds: accountState?.thresholds ?? { low: 0, med: 1, high: 1 },
                  transfers: chosenTransfers(
                    useDemolishStore.getState().assetDispositions,
                    useDemolishStore.getState().transferDestinations,
                    accountState,
                    claimableBalanceSelections
                  ),
                  ...exitExpectations(accountState, network),
                },
              }),
            requiredWeight: (tx: CloseTransaction) =>
              requiredSignatureWeight(
                intentFromXdr(tx.xdr, passphrase).operations,
                accountState?.thresholds ?? { low: 0, med: 1, high: 1 }
              ),
            sign: async (tx: CloseTransaction, xdr: string) => {
              setProgressStatus("Signing transaction…");
              // Computed from the exact XDR verify() approved, before any signer touches it -
              // the anchor for both checks below. The hash covers only the transaction body
              // (source, ops, sequence, memo, fee), never signatures, so it stays valid
              // whether taken before or after signing.
              const approvedHash = TransactionBuilder.fromXDR(xdr, passphrase)
                .hash()
                .toString("hex");
              // On a fresh envelope this is 0. On a RESUMED envelope it already carries a
              // prior signer's contribution - captured here (not just "length === 0" on the
              // result) so a signer who does nothing, OR re-signs with a key that already
              // contributed, is caught below rather than silently passing. Weight, not raw
              // signature count: Transaction.sign() unconditionally appends a decorated
              // signature even for an already-used key (stellar-sdk doesn't dedupe), so a
              // same-key re-sign would still increase signature count while contributing
              // nothing new - evaluateSignatureContributions dedupes by signer key, so weight
              // only goes up when a signer that hadn't yet contributed actually does.
              const preSignWeight = accumulatedWeight(
                evaluateSignatureContributions(xdr, passphrase, accountState?.signers ?? [])
              );
              const signedXdr = await signer.sign(xdr, passphrase);

              // A connected wallet (WalletKitSigner) is a black box outside this app's trust
              // boundary - unlike SecretKeySigner, which signs by parsing this exact xdr and
              // re-serializing it (so its output can never diverge in body), an external signer
              // could in principle return a signature over a different transaction, or no
              // signature at all. Assert both before trusting the result any further.
              const signedTx = TransactionBuilder.fromXDR(signedXdr, passphrase);
              if (signedTx.hash().toString("hex") !== approvedHash) {
                throw new Error("The signed transaction does not match what you approved.");
              }

              const contributions = evaluateSignatureContributions(
                signedXdr,
                passphrase,
                accountState?.signers ?? []
              );
              const weight = accumulatedWeight(contributions);
              if (weight <= preSignWeight) {
                throw new Error(
                  "This signer didn't add a new signature. If you already signed with this key, connect a different signer."
                );
              }
              return { xdr: signedXdr, weight };
            },
            submit: async (tx: CloseTransaction, xdr: string) => {
              let finalXdr = xdr;

              // A merge through the shared mediator is one atomic transaction: the user
              // signed the merge; the backend co-signs the mediator's forward payment. It
              // cannot change destination or amount, so funds can never be diverted.
              if (mediatorRequired && tx.covers.includes("MERGE")) {
                setProgressStatus("Co-signing the forward payment…");
                // Defense-in-depth: the mediator may ONLY add its signature - assert it did not
                // alter the body, and that it actually added one, before submit.
                const approvedHash = TransactionBuilder.fromXDR(xdr, passphrase)
                  .hash()
                  .toString("hex");
                const preCosignCount = TransactionBuilder.fromXDR(xdr, passphrase).signatures
                  .length;
                const cosignedXdr = await requestMediatorCosignature(xdr, network);
                const cosigned = TransactionBuilder.fromXDR(cosignedXdr, passphrase);
                if (cosigned.hash().toString("hex") !== approvedHash) {
                  throw new Error("The co-signed transaction does not match what you approved.");
                }
                if (cosigned.signatures.length <= preCosignCount) {
                  throw new Error("The mediator did not add its signature.");
                }
                finalXdr = cosignedXdr;
              }

              setProgressStatus("Submitting to Stellar network…");
              const { txHash } = await submitViaApi(finalXdr, network);
              return txHash;
            },
            onConfirmed: (tx, hash) => {
              markCoveredConfirmed(tx.covers, hash);
              if (tx.covers.includes("MERGE") || tx.covers.includes("CLOSE_ACCOUNT")) {
                recordMergeStats(hash, network);
              }
            },
            onProgress: setProgressStatus,
          },
          pendingRoundRef.current ?? undefined
        );
        pendingRoundRef.current = null; // full success - nothing left to resume
        setPhase("COMPLETE");
      } catch (err) {
        if (err instanceof InsufficientSignatureWeightError) {
          pendingRoundRef.current = err.pending;
          setSignatureStatus({
            requiredWeight: err.pending.requiredWeight,
            accumulatedWeight: err.pending.accumulatedWeight,
            remainingSigners: evaluateSignatureContributions(
              err.pending.xdr,
              passphrase,
              accountState?.signers ?? []
            )
              .filter((c) => !c.contributed)
              .map((c) => c.signer),
          });
          setLastError(
            `This account needs ${err.pending.requiredWeight - err.pending.accumulatedWeight} more signing weight. Connect another signer to continue.`
          );
          setPhase("STEP_FAILED");
          return;
        }
        // A non-weight failure (network error, verify rejection) invalidates any resumable
        // state - retrying should start clean, not silently reuse a possibly-stale envelope.
        // Clearing signatureStatus too ensures the UI falls through to the "failed" branch
        // (which renders lastError) instead of re-rendering the "pending more signatures"
        // panel with no explanation of what went wrong.
        pendingRoundRef.current = null;
        setSignatureStatus(null);
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
      markCoveredConfirmed,
      setPhase,
      setLastError,
    ]
  );

  // Satisfies a pre-auth-tx signer: unlike every other signing path, the transaction here was
  // never built by the API - it's the user's own, already-fully-authorized transaction, whose
  // hash IS the signer's key (see docs on verifyPreAuthTxHash). It cannot be merged onto
  // whatever the round loop currently has pending (different sequence number/operations each
  // round), so it bypasses close-engine.ts entirely and goes straight to /submit. Deliberately
  // leaves pendingRoundRef/signatureStatus/phase untouched: this envelope has nothing to do
  // with whatever round-loop envelope might be mid-accumulation, and clearing that state here
  // would destroy real progress on an unrelated transaction. The caller continues the normal
  // flow afterward (Retry/Add signature) - the API re-reads live state every round, so any work
  // this submission completed is simply absent from the next round's build.
  const submitPreAuthTransaction = useCallback(
    async (signer: AccountSigner, xdr: string): Promise<void> => {
      if (!sourceAddress || !destinationAddress) {
        throw new Error("Missing account or destination.");
      }

      const passphrase = NETWORK_PASSPHRASES[network];
      verifyPreAuthTxHash(xdr, passphrase, signer.key);

      const claimableBalanceSelections = useDemolishStore.getState().claimableBalanceSelections;
      const accountState = useDemolishStore.getState().accountState;
      const claimTrustlineAssets = Object.entries(claimableBalanceSelections)
        .filter(([, selection]) => selection === "add_trustline_then_claim")
        .map(([balanceId]) => {
          const balance = useDemolishStore
            .getState()
            .accountState?.claimableBalances.find((b) => b.id === balanceId);
          return balance?.asset ?? null;
        })
        .filter((asset): asset is string => asset !== null);

      // Every assertCloseIntent check is a self-contained structural assertion (only removals,
      // no signer added/empowered, merge only to an allowed destination, memo integrity, no
      // unrecognized op) rather than a comparison against a per-step "expected operation list"
      // the API would otherwise supply - so all of them apply unmodified to a transaction the
      // API never built. What this cannot check is the transaction's PROVENANCE (whether the
      // user really authorized it, on purpose, for this close) - that's why this path also
      // requires the persistent UI warning, not a code-level check.
      verifyCloseTransaction({
        unsignedXdr: xdr,
        network,
        expected: {
          source: sourceAddress,
          destination: destinationAddress,
          mediatorRequired,
          nativeBalance: accountState?.nativeBalanceLumens ?? "0",
          memo,
          claimTrustlineAssets,
          accountSigners: accountState?.signers ?? [],
          accountThresholds: accountState?.thresholds ?? { low: 0, med: 1, high: 1 },
          transfers: chosenTransfers(
            useDemolishStore.getState().assetDispositions,
            useDemolishStore.getState().transferDestinations,
            accountState,
            claimableBalanceSelections
          ),
          ...exitExpectations(accountState, network),
        },
      });

      await submitViaApi(xdr, network);
    },
    [network, sourceAddress, destinationAddress, memo, mediatorRequired]
  );

  return { run, progressStatus, signatureStatus, submitPreAuthTransaction };
}

/**
 * Records a confirmed merge for the live stats counter without blocking execution.
 * Failures are logged, not surfaced - the close already succeeded.
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
