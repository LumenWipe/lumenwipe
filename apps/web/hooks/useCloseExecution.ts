"use client";

import { useCallback, useRef, useState } from "react";
import { exitExpectations } from "@/lib/stellar/exit-expectations";
import { FeeBumpTransaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { CloseTransaction } from "@lumenwipe/sdk";
import type { AccountState } from "@/types/account";
import type { AssetDisposition } from "@/types/plan";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import {
  runClose,
  isSubmitRefused,
  resolveSubmission,
  submissionClosesAccount,
  CloseOutcomeUnknownError,
  CloseStateChangedError,
  CloseTransactionFailedError,
  InsufficientSignatureWeightError,
  type CloseProgressEvent,
  type PendingRound,
  type UnresolvedSubmission,
} from "@lumenwipe/sdk";
import { fetchCloseTransactions } from "@/lib/api/close-client";
import {
  chosenClassicConversions,
  chosenTokenConversions,
  chosenTokenTransfers,
  chosenTransfers,
  closeDecisions,
} from "@/lib/api/close-decisions";
import { verifyCloseTransaction } from "@/lib/stellar/verify";
import { confirmedMemo } from "@/lib/plan/memo-field";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import { requiredSignatureWeight } from "@/lib/stellar/thresholds";
import { verifyPreAuthTxHash } from "@/lib/stellar/pre-auth-tx";
import {
  assertMasterSignsSignerRemoval,
  assertPreimageRemovesItsSigner,
} from "@/lib/stellar/signing-guards";
import {
  accumulatedWeight,
  applyConfirmedTransaction,
  evaluateSignatureContributions,
  parseRoundSignerState,
  type SignerState,
} from "@/lib/stellar/signature-weight";
import { lookupViaApi, submitViaApi } from "@/lib/stellar/submit-via-api";
import { mergesAccount, submissionHash, submissionValidUntil } from "@/lib/stellar/submission";
import {
  closeOwner,
  ensureCloseSession,
  ownsStore,
  type CloseOwner,
} from "@/lib/session/close-record";
import { findUnresolved } from "@/lib/session/recovery";
import {
  clearUnconfirmedFor,
  confirmationOf,
  recordConfirmed,
  saveUnconfirmed,
} from "@/lib/session/store";
import { requestMediatorCosignature } from "@/lib/stellar/mediator";
import { mediatorAllowedFor } from "@/lib/exchange-registry";
import { requestFeeBumpSponsorship } from "@/lib/stellar/fee-bump-sponsor";
import { notifyStatsRefresh } from "@/lib/stats-events";
import {
  closeFailureMessage,
  closeRetryIsSafe,
  CLOSE_INTERRUPTED,
  HASH_NOT_KEPT,
  NO_MERGE_CONFIRMED,
  requestIdOf,
  UserFacingError,
  type CloseFailureStage,
} from "@/lib/utils/user-error";
import { toHex } from "@/lib/stellar/hex";
import {
  refusedTransferAsset,
  TransferDestinationRefusedError,
  TRANSFER_DESTINATION_REFUSED_NOTICE,
} from "@/lib/plan/transfer-destination";
import {
  HashXPreimageSigner,
  WALLET_CONNECT_WALLET_ID,
  WalletKitSigner,
  type TransactionSigner,
} from "@/lib/stellar/signer";
import {
  confirmedTransactions,
  isConfirmation,
  positionOf,
  waitOf,
  type CloseProgress,
  type ProgressPosition,
  type ProgressWait,
} from "@/lib/execution/progress";
import type { AccountSigner } from "@/types/account";

export interface RunOptions {
  /** Runs right before each signature of the run; throwing stops the run with nothing signed or
   *  sent for that transaction. */
  beforeSign?: () => Promise<void>;
}

/** Required vs. accumulated signing weight for the transaction that stopped a close, the
 *  signers whose signature on it already counts, and the account's known signers who haven't
 *  contributed yet - consumed by the multi-wallet-switch UI (issue #100) to let the user bring in
 *  another signer without re-deriving this state. Display only: the weight checks in `sign`
 *  re-evaluate the envelope itself. */
export interface SignatureStatus {
  requiredWeight: number;
  accumulatedWeight: number;
  contributed: AccountSigner[];
  remainingSigners: AccountSigner[];
}

async function keepDurably(owner: CloseOwner, submission: UnresolvedSubmission): Promise<boolean> {
  try {
    const sessionId = await ensureCloseSession(owner);
    return sessionId !== null && ownsStore(owner) && (await saveUnconfirmed(sessionId, submission));
  } catch (err) {
    console.error("[session] could not keep the unconfirmed hash:", err);
    return false;
  }
}

function assertStillOwns(owner: CloseOwner): void {
  if (!ownsStore(owner)) throw new UserFacingError(CLOSE_INTERRUPTED);
}

/** Remembers an unsettled transaction across a refresh, before it is sent: with the hash only in
 *  memory a refresh would walk around the hold, so a failed save stops the send. Clearing never
 *  stops anything: the transaction settled, and a stale record costs one extra lookup. Every write
 *  is for `owner`, and the store is touched only while it still holds that close. */
async function recordSubmission(
  owner: CloseOwner,
  submission: UnresolvedSubmission | null
): Promise<void> {
  const { setUnconfirmedSubmission } = useDemolishStore.getState();
  if (submission) {
    if (!(await keepDurably(owner, submission))) throw new UserFacingError(HASH_NOT_KEPT);
    setUnconfirmedSubmission(submission);
    return;
  }
  if (ownsStore(owner)) setUnconfirmedSubmission(null);
  try {
    await clearUnconfirmedFor(owner.network, owner.source);
  } catch (err) {
    console.error("[session] could not clear the unconfirmed hash:", err);
  }
}

/** Records a confirmed transaction in the saved close the run started with, never another one.
 *  It never stops the close: a failed write, or a record another tab dismissed, only shows a
 *  notice. Called after the store marked the transaction's steps. */
function recordProgress(
  owner: CloseOwner,
  recordId: string | null,
  covers: readonly string[],
  txHash: string
): void {
  const plan = ownsStore(owner) ? useDemolishStore.getState().executionPlan : null;
  const open = plan?.findIndex((s) => s.status !== "confirmed") ?? -1;
  const confirmation = confirmationOf(
    covers,
    txHash,
    plan ? (open === -1 ? plan.length : open) : null
  );
  const written = recordId ? recordConfirmed(recordId, confirmation) : Promise.resolve(false);
  void written
    .catch((err: unknown) => {
      console.error("[session] could not record the confirmed transaction:", err);
      return false;
    })
    .then((saved) => {
      if (!saved && ownsStore(owner)) useDemolishStore.getState().setProgressNotSaved(true);
    });
}

/** What the signer's prompt is, for the progress line. */
function signingWait(signer: TransactionSigner): ProgressWait {
  if (signer instanceof WalletKitSigner) {
    return signer.walletId === WALLET_CONNECT_WALLET_ID ? "wallet-app" : "wallet";
  }
  if (signer instanceof HashXPreimageSigner) return "preimage";
  return "key";
}

export const PLAN_CHANGED_NOTICE =
  "Your account changed while the close was being prepared, so nothing was submitted for that step. The plan below has been refreshed from your account as it is now: review it and confirm again to continue.";

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
  const memoType = useDemolishStore((s) => s.memoType);
  const markCoveredConfirmed = useDemolishStore((s) => s.markCoveredConfirmed);
  const markCoveredStatus = useDemolishStore((s) => s.markCoveredStatus);
  const setPhase = useDemolishStore((s) => s.setPhase);
  const setLastError = useDemolishStore((s) => s.setLastError);
  const discardPlan = useDemolishStore((s) => s.discardPlan);
  const clearPlanHash = useDemolishStore((s) => s.clearPlanHash);

  const [progress, setProgress] = useState<CloseProgress | null>(null);
  const [signatureStatus, setSignatureStatus] = useState<SignatureStatus | null>(null);
  const [retrySafe, setRetrySafe] = useState<boolean | null>(null);
  const [stillUnconfirmed, setStillUnconfirmed] = useState(false);
  // Whether the transaction in flight carries a preimage: refused or failed, it was still sent.
  const carriedPreimageRef = useRef(false);
  // Survives across separate run() calls on the same hook instance (unlike state, a ref
  // update doesn't itself trigger a re-render) so a second signer resumes onto the exact
  // partially-signed envelope the first signer left behind, instead of re-fetching and
  // discarding that signature.
  const pendingRoundRef = useRef<PendingRound | null>(null);
  // The signers and thresholds the current round is signed against. A round can remove signers
  // and lower thresholds, so it follows each round's own read and each confirmed transaction,
  // and survives a pause so a resumed round is judged against the same state.
  const signerStateRef = useRef<SignerState | null>(null);
  const signerStateForRef = useRef<string | null>(null);

  // Moves the progress line to `wait`. The clock behind the elapsed line restarts only when what
  // is waited on changes, never on a re-render or a repeated report of the same wait.
  const showProgress = useCallback(
    (wait: ProgressWait | null, position: ProgressPosition | null = null): void => {
      setProgress((current) => {
        if (wait === null) return null;
        if (
          current?.wait === wait &&
          current.position?.n === position?.n &&
          current.position?.total === position?.total &&
          current.position?.atLeast === position?.atLeast
        ) {
          return current;
        }
        return { wait, position, since: Date.now() };
      });
    },
    []
  );

  const run = useCallback(
    async (signer: TransactionSigner, options: RunOptions = {}): Promise<void> => {
      // One run per close: a page remounted mid-run has lost its own record of the first.
      if (useDemolishStore.getState().signingRun) return;
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
      const snapshot = useDemolishStore.getState().accountState;
      const snapshotState: SignerState = {
        signers: snapshot?.signers ?? [],
        thresholds: snapshot?.thresholds ?? { low: 0, med: 1, high: 1 },
      };
      const stateFor = `${network}:${sourceAddress}`;
      if (signerStateForRef.current !== stateFor) {
        pendingRoundRef.current = null;
        signerStateRef.current = null;
        signerStateForRef.current = stateFor;
      }
      if (!signerStateRef.current) signerStateRef.current = snapshotState;
      const resuming = pendingRoundRef.current !== null;
      const knownSigners = (resuming ? signerStateRef.current : snapshotState).signers;
      if (!knownSigners.some((s) => s.key === signer.publicKey)) {
        pendingRoundRef.current = null;
        setSignatureStatus(null);
        setLastError(
          resuming && snapshotState.signers.some((s) => s.key === signer.publicKey)
            ? "An earlier step of this close removed this key from the account's signers. Connect one of the signers it still has and try again."
            : "The signer you're using isn't one of this account's known signers. Reconnect the correct wallet or secret key and try again."
        );
        setPhase("STEP_FAILED");
        return;
      }

      const passphrase = NETWORK_PASSPHRASES[network];
      const initialSignerState = signerStateRef.current;
      const roundSignerState = (): SignerState => signerStateRef.current ?? initialSignerState;
      // Read dispositions/selections live so a mid-flow re-decision is honored.
      const claimableBalanceSelections = useDemolishStore.getState().claimableBalanceSelections;
      const accountState = useDemolishStore.getState().accountState;
      const decisions = closeDecisions(
        useDemolishStore.getState(),
        sourceAddress,
        destinationAddress,
        (accountState?.sorobanTokens?.tokens ?? []).map((tk) => tk.contract)
      );
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

      // Set with the check above, before any await, so a leave during the reads below clears it.
      useDemolishStore.getState().setSigningRun(true);
      setPhase("STEP_EXECUTING");
      // A retry starts with a clean list. A step left submitted keeps it: it may be on the ledger.
      useDemolishStore.getState().resetUnsettledSteps();
      setSignatureStatus(null);
      setRetrySafe(true);
      setStillUnconfirmed(false);
      carriedPreimageRef.current = false;
      const flight = { stage: "before-submit" as CloseFailureStage };
      // The transaction the loop is on, for the steps it marks. Display only: nothing that is
      // verified, signed or sent is read from here.
      let inFlight: CloseTransaction | null = null;
      // Numbering for the progress line, counted across retries and resumes (see positionOf).
      let confirmedBefore: number | null = null;
      let confirmedInRun = 0;
      let position: ProgressPosition | null = null;
      const signerWait = signingWait(signer);
      // A submission left over from an earlier attempt is settled by runClose before anything
      // else. Confirmed, it reaches onResolved; failed, it is thrown; expired, it says nothing, so
      // the first event of the run is where it is known to have expired.
      // Read just before runClose, once the saved record below has been put in the store.
      let leftOver: UnresolvedSubmission | null = null;
      let leftOverOpen = false;
      const onProgressEvent = (event: CloseProgressEvent): void => {
        if (!ownsStore(owner)) return;
        const expired = leftOverOpen ? leftOver : null;
        if (expired) {
          leftOverOpen = false;
          // Expired without landing: those steps are waiting again, not sent.
          markCoveredStatus(expired.covers, expired.coversTargets, "pending");
        }
        const wait = waitOf(event, signerWait);
        if (!("txIndex" in event)) {
          position = null;
          showProgress(wait);
          return;
        }
        confirmedBefore ??= confirmedTransactions(useDemolishStore.getState().executionPlan);
        if (isConfirmation(event)) confirmedInRun += 1;
        position = positionOf(event, confirmedBefore, confirmedInRun);
        // A null wait (submitting) is said by prepare and submit below.
        if (wait !== null) showProgress(wait, position);
      };
      const owner = closeOwner(network, sourceAddress);
      // The memo and type the request asks for are the ones every transaction is verified against.
      const sentMemo = confirmedMemo(destinationAddress, memo, memoType);
      // Saved by an earlier page load: until it settles, this account signs nothing new.
      const recorded = await findUnresolved(network, sourceAddress);
      if (recorded?.unconfirmed && !useDemolishStore.getState().unconfirmedSubmission) {
        useDemolishStore.getState().setUnconfirmedSubmission(recorded.unconfirmed);
      }
      try {
        // Found here, before a signature or a sponsorship is spent on a send that could not start.
        const recordId = await ensureCloseSession(owner).catch(() => {
          throw new UserFacingError(HASH_NOT_KEPT);
        });
        leftOver = useDemolishStore.getState().unconfirmedSubmission;
        leftOverOpen = leftOver !== null;
        const { mergeConfirmed } = await runClose(
          {
            planHash: useDemolishStore.getState().planHash ?? undefined,
            getTransactions: async ({ planHash }) => {
              // Before every round, so a registry that changed since the review stops the close
              // between rounds, with nothing of the next one fetched or signed.
              const live = useDemolishStore.getState();
              const refused = refusedTransferAsset(
                live.assetDispositions,
                live.transferDestinations
              );
              if (refused !== null) throw new TransferDestinationRefusedError(refused);
              const batch = await fetchCloseTransactions(
                {
                  source: sourceAddress,
                  destination: destinationAddress,
                  decisions,
                  memo: sentMemo?.memo,
                  // The type checked on the plan page goes with the memo, so an id memo to an
                  // unlisted wallet is not sent as text. A listed exchange's type is checked again.
                  memoType:
                    sentMemo?.memoType === "text" || sentMemo?.memoType === "id"
                      ? sentMemo.memoType
                      : undefined,
                  planHash,
                },
                network
              );
              signerStateRef.current =
                parseRoundSignerState(batch.sourceAccount) ?? signerStateRef.current;
              return batch;
            },
            verify: (tx: CloseTransaction) => {
              inFlight = tx;
              return verifyCloseTransaction({
                unsignedXdr: tx.xdr,
                network,
                expected: {
                  source: sourceAddress,
                  destination: destinationAddress,
                  // The floor under the forwarded amount. Empty defaults fail closed: with no
                  // balance read, any forward is judged short rather than trusted.
                  nativeBalance: accountState?.nativeBalanceLumens ?? "0",
                  memo: sentMemo?.memo ?? null,
                  memoType: sentMemo?.memoType ?? null,
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
                  tokenTransfers: chosenTokenTransfers(
                    useDemolishStore.getState().assetDispositions,
                    useDemolishStore.getState().transferDestinations,
                    accountState
                  ),
                  classicConversions: chosenClassicConversions(
                    useDemolishStore.getState().assetDispositions,
                    useDemolishStore.getState().classicConversionFloors
                  ),
                  tokenConversions: chosenTokenConversions(
                    useDemolishStore.getState().assetDispositions,
                    useDemolishStore.getState().tokenConversionFloors,
                    accountState
                  ),
                  ...exitExpectations(accountState, network),
                },
              });
            },
            // The network needs at least one matching signature even where a threshold is 0.
            requiredWeight: (tx: CloseTransaction) =>
              Math.max(
                1,
                requiredSignatureWeight(
                  intentFromXdr(tx.xdr, passphrase).operations,
                  roundSignerState().thresholds
                )
              ),
            sign: async (tx: CloseTransaction, xdr: string) => {
              assertStillOwns(owner);
              inFlight = tx;
              // Computed from the exact XDR verify() approved, before any signer touches it -
              // the anchor for both checks below. The hash covers only the transaction body
              // (source, ops, sequence, memo, fee), never signatures, so it stays valid
              // whether taken before or after signing.
              const approvedHash = toHex(TransactionBuilder.fromXdr(xdr, passphrase).hash());
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
                evaluateSignatureContributions(xdr, passphrase, roundSignerState().signers)
              );
              // A key the round no longer lists would add a signature the network refuses as
              // extra, so it is not asked to sign; the round pauses for a current signer.
              if (!roundSignerState().signers.some((s) => s.key === signer.publicKey)) {
                return { xdr, weight: preSignWeight };
              }
              assertPreimageRemovesItsSigner(xdr, passphrase, sourceAddress, signer.publicKey);
              // The signer's own live check, at each signature of the run and not only at its
              // start: a wallet session that changed since stops here, before it is asked.
              await options.beforeSign?.();
              markCoveredStatus(tx.covers, tx.coversTargets, "signing");
              const signedXdr = await signer.sign(xdr, passphrase);

              // A connected wallet (WalletKitSigner) is a black box outside this app's trust
              // boundary - unlike SecretKeySigner, which signs by parsing this exact xdr and
              // re-serializing it (so its output can never diverge in body), an external signer
              // could in principle return a signature over a different transaction, or no
              // signature at all. Assert both before trusting the result any further.
              const signedTx = TransactionBuilder.fromXdr(signedXdr, passphrase);
              if (toHex(signedTx.hash()) !== approvedHash) {
                throw new UserFacingError(
                  "The signed transaction does not match what you approved."
                );
              }

              const contributions = evaluateSignatureContributions(
                signedXdr,
                passphrase,
                roundSignerState().signers
              );
              const weight = accumulatedWeight(contributions);
              if (weight <= preSignWeight) {
                throw new UserFacingError(
                  "This signer didn't add a new signature. If you already signed with this key, connect a different signer."
                );
              }
              return { xdr: signedXdr, weight };
            },
            prepare: async (tx: CloseTransaction, xdr: string) => {
              let finalXdr = xdr;
              carriedPreimageRef.current = evaluateSignatureContributions(
                xdr,
                passphrase,
                roundSignerState().signers
              ).some((c) => c.contributed && c.signer.type === "hash_x");
              assertMasterSignsSignerRemoval(xdr, passphrase, sourceAddress);

              // A merge through the shared mediator is one atomic transaction: the user
              // signed the merge; the backend co-signs the mediator's forward payment. It
              // cannot change destination or amount, so funds can never be diverted. Decided
              // from the bundled registry, as `verify()` decides it, never from the store: a
              // restored session can carry a stale value, and the store is for display.
              if (mediatorAllowedFor(destinationAddress) && tx.covers.includes("MERGE")) {
                showProgress("relay", position);
                // Defense-in-depth: the mediator may ONLY add its signature - assert it did not
                // alter the body, and that it actually added one, before submit.
                const approvedHash = toHex(TransactionBuilder.fromXdr(xdr, passphrase).hash());
                const preCosignCount = TransactionBuilder.fromXdr(xdr, passphrase).signatures
                  .length;
                const cosignedXdr = await requestMediatorCosignature(xdr, network);
                const cosigned = TransactionBuilder.fromXdr(cosignedXdr, passphrase);
                if (toHex(cosigned.hash()) !== approvedHash) {
                  throw new UserFacingError(
                    "The co-signed transaction does not match what you approved."
                  );
                }
                if (cosigned.signatures.length <= preCosignCount) {
                  throw new UserFacingError("The relay account did not add its signature.");
                }
                finalXdr = cosignedXdr;
              }

              // The account cannot pay this transaction's own fee without dropping below its
              // reserve (architecture.md §8.1) - the API built it with fee zero and flagged it;
              // wrap it in a sponsored fee-bump envelope before submitting, done last, after
              // every signature the inner transaction needs (the user's own, and the mediator's
              // co-sign above, when both apply) - wrapping never touches the inner transaction,
              // but the inner transaction has to be complete before there is anything to wrap.
              if (tx.needsSponsoredFee) {
                showProgress("sponsor", position);
                const approved = TransactionBuilder.fromXdr(finalXdr, passphrase);
                const approvedHash = toHex(approved.hash());
                const approvedSignatureCount = approved.signatures.length;
                const sponsoredXdr = await requestFeeBumpSponsorship(finalXdr, network);
                const sponsored = TransactionBuilder.fromXdr(sponsoredXdr, passphrase);
                // Defense-in-depth, matching the mediator co-sign above: the sponsor may only
                // wrap the exact transaction it was handed and add its own signature over the
                // envelope - never alter what the inner transaction does. The hash check alone
                // only covers the transaction body (source, ops, sequence, memo, fee, timebounds)
                // - it says nothing about the inner transaction's own signatures, which the hash
                // never covers - so the signature count is checked separately to catch a sponsor
                // that reconstructs the same body but drops the signatures already on it.
                if (!(sponsored instanceof FeeBumpTransaction)) {
                  throw new UserFacingError("The sponsor did not return a fee-bump transaction.");
                }
                if (toHex(sponsored.innerTransaction.hash()) !== approvedHash) {
                  throw new UserFacingError(
                    "The sponsored transaction does not match what you approved."
                  );
                }
                if (sponsored.innerTransaction.signatures.length < approvedSignatureCount) {
                  throw new UserFacingError(
                    "The sponsor dropped a signature already on this transaction."
                  );
                }
                if (sponsored.signatures.length === 0) {
                  throw new UserFacingError("The sponsor did not add its signature.");
                }
                finalXdr = sponsoredXdr;
              }

              // A transaction with no end could land at any time, so it could never be given up on.
              if (submissionValidUntil(finalXdr, passphrase) === null) {
                throw new UserFacingError(
                  "This transaction has no time limit, so it was not sent. Nothing changed."
                );
              }
              return finalXdr;
            },
            submit: async (tx: CloseTransaction, xdr: string) => {
              assertStillOwns(owner);
              showProgress("network", position);
              flight.stage = "submitted";
              markCoveredStatus(tx.covers, tx.coversTargets, "submitted");
              const { txHash } = await submitViaApi(xdr, network);
              return txHash;
            },
            reconcile: {
              hashOf: (xdr) => submissionHash(xdr, passphrase),
              closesAccount: (xdr) => mergesAccount(xdr, passphrase, sourceAddress),
              validUntil: (xdr) => submissionValidUntil(xdr, passphrase),
              lookup: (hash) => lookupViaApi(hash, network),
              onSubmission: (submission) => recordSubmission(owner, submission),
              unresolved: leftOver ?? undefined,
              onResolved: (submission) => {
                leftOverOpen = false;
                if (ownsStore(owner)) {
                  clearPlanHash();
                  markCoveredConfirmed(
                    submission.covers,
                    submission.hash,
                    submission.needsSponsoredFee,
                    submission.coversTargets
                  );
                }
                recordProgress(owner, recordId, submission.covers, submission.hash);
              },
            },
            onConfirmed: (tx, hash) => {
              if (ownsStore(owner)) {
                carriedPreimageRef.current = false;
                clearPlanHash();
                markCoveredConfirmed(tx.covers, hash, tx.needsSponsoredFee, tx.coversTargets);
                // A step the API named but the confirmed envelope did not carry out (a merge
                // the client did not parse) is not confirmed, and no longer in flight.
                if (inFlight) markCoveredStatus(inFlight.covers, inFlight.coversTargets, "pending");
                inFlight = null;
                signerStateRef.current = applyConfirmedTransaction(
                  roundSignerState(),
                  tx.xdr,
                  passphrase,
                  intentFromXdr(tx.xdr, passphrase).operations,
                  sourceAddress
                );
                if (tx.covers.includes("MERGE") || tx.covers.includes("CLOSE_ACCOUNT")) {
                  notifyStatsRefresh();
                }
                flight.stage = "before-submit";
              }
              recordProgress(owner, recordId, tx.covers, hash);
            },
            onProgressEvent,
          },
          pendingRoundRef.current ?? undefined
        );
        if (!ownsStore(owner)) return;
        pendingRoundRef.current = null; // full success - nothing left to resume
        signerStateRef.current = null;
        signerStateForRef.current = null;
        if (mergeConfirmed) {
          setPhase("COMPLETE");
        } else {
          setLastError(NO_MERGE_CONFIRMED);
          setPhase("STEP_FAILED");
        }
      } catch (err) {
        // The store holds another account now: nothing of this run belongs on its screen.
        if (!ownsStore(owner)) return;
        // The transaction that stopped the run. A failure found by hash names its own, which may
        // be a left-over from an earlier attempt that this run never verified.
        const stopped: Pick<CloseTransaction, "covers" | "coversTargets"> | null =
          err instanceof CloseTransactionFailedError
            ? err.submission
            : (inFlight as CloseTransaction | null);
        if (err instanceof InsufficientSignatureWeightError) {
          // Paused for another signer, not failed: the panel below the steps says what is needed.
          markCoveredStatus(err.pending.tx.covers, err.pending.tx.coversTargets, "pending");
          pendingRoundRef.current = err.pending;
          const contributions = evaluateSignatureContributions(
            err.pending.xdr,
            passphrase,
            roundSignerState().signers
          );
          setSignatureStatus({
            requiredWeight: err.pending.requiredWeight,
            accumulatedWeight: err.pending.accumulatedWeight,
            contributed: contributions.filter((c) => c.contributed).map((c) => c.signer),
            remainingSigners: contributions.filter((c) => !c.contributed).map((c) => c.signer),
          });
          setLastError(
            `This account needs ${err.pending.requiredWeight - err.pending.accumulatedWeight} more signing weight. Connect another signer to continue.`
          );
          setPhase("STEP_FAILED");
          return;
        }
        if (
          err instanceof CloseOutcomeUnknownError ||
          useDemolishStore.getState().unconfirmedSubmission
        ) {
          pendingRoundRef.current = null;
          setSignatureStatus(null);
          setLastError(null);
          setPhase("STEP_UNCONFIRMED");
          return;
        }
        if (err instanceof CloseStateChangedError) {
          pendingRoundRef.current = null;
          signerStateRef.current = null;
          signerStateForRef.current = null;
          setSignatureStatus(null);
          discardPlan(PLAN_CHANGED_NOTICE);
          return;
        }
        if (err instanceof TransferDestinationRefusedError) {
          pendingRoundRef.current = null;
          setSignatureStatus(null);
          discardPlan(TRANSFER_DESTINATION_REFUSED_NOTICE);
          return;
        }
        // A non-weight failure (network error, verify rejection) invalidates any resumable
        // state - retrying should start clean, not silently reuse a possibly-stale envelope.
        // Clearing signatureStatus too ensures the UI falls through to the "failed" branch
        // (which renders lastError) instead of re-rendering the "pending more signatures"
        // panel with no explanation of what went wrong.
        pendingRoundRef.current = null;
        setSignatureStatus(null);
        const failedAt: CloseFailureStage =
          err instanceof CloseTransactionFailedError ||
          (flight.stage === "submitted" && isSubmitRefused(err))
            ? "refused"
            : flight.stage;
        const carried = carriedPreimageRef.current;
        // A refusal of a transaction this device's clock already called expired: a clock set
        // wrong makes every transaction look that way, and the network refuses it as tx_too_late.
        const validUntil =
          err instanceof CloseTransactionFailedError
            ? err.submission.validUntil
            : inFlight
              ? submissionValidUntil((inFlight as CloseTransaction).xdr, passphrase)
              : null;
        const clockPastExpiry =
          failedAt === "refused" && validUntil !== null && Date.now() > validUntil * 1000;
        const message = closeFailureMessage(
          err,
          failedAt,
          useDemolishStore.getState().executionPlan,
          carried,
          clockPastExpiry
        );
        // Sent and not refused, the transaction may still land: its steps stay submitted, never
        // failed. Every other stage is a transaction that did not, or will not, take effect.
        if (stopped && failedAt !== "submitted") {
          markCoveredStatus(stopped.covers, stopped.coversTargets, "failed", message);
        }
        setRetrySafe(closeRetryIsSafe(err, failedAt, carried));
        setLastError(message, requestIdOf(err));
        setPhase("STEP_FAILED");
      } finally {
        showProgress(null);
        if (ownsStore(owner)) useDemolishStore.getState().setSigningRun(false);
      }
    },
    [
      network,
      sourceAddress,
      destinationAddress,
      memo,
      memoType,
      markCoveredConfirmed,
      markCoveredStatus,
      showProgress,
      setPhase,
      setLastError,
      discardPlan,
      clearPlanHash,
    ]
  );

  // Settles the unknown transaction by its hash alone: nothing is signed or sent, so a check can
  // never change what happens on the ledger.
  const checkUnconfirmed = useCallback(async (): Promise<void> => {
    const {
      unconfirmedSubmission: submission,
      sourceAddress: source,
      sessionId,
    } = useDemolishStore.getState();
    if (!submission || !source) return;
    const owner = closeOwner(network, source);
    showProgress("checking");
    setStillUnconfirmed(false);
    const settled = await resolveSubmission(submission, (hash) => lookupViaApi(hash, network));
    showProgress(null);
    if (settled.outcome === "unknown") {
      setStillUnconfirmed(ownsStore(owner));
      return;
    }
    await recordSubmission(owner, null);
    if (!ownsStore(owner)) return;
    if (settled.outcome === "expired") {
      markCoveredStatus(submission.covers, submission.coversTargets, "pending");
      setPhase("STEP_EXECUTING");
      return;
    }
    if (settled.outcome === "failed") {
      const carried = carriedPreimageRef.current;
      const failure = new CloseTransactionFailedError(submission, settled.message);
      markCoveredStatus(submission.covers, submission.coversTargets, "failed");
      setRetrySafe(closeRetryIsSafe(failure, "refused", carried));
      setLastError(
        closeFailureMessage(failure, "refused", useDemolishStore.getState().executionPlan, carried)
      );
      setPhase("STEP_FAILED");
      return;
    }
    clearPlanHash();
    markCoveredConfirmed(
      submission.covers,
      submission.hash,
      submission.needsSponsoredFee,
      submission.coversTargets
    );
    recordProgress(owner, sessionId, submission.covers, submission.hash);
    if (submissionClosesAccount(submission)) {
      notifyStatsRefresh();
      setPhase("COMPLETE");
    } else {
      setPhase("STEP_EXECUTING");
    }
  }, [
    network,
    markCoveredConfirmed,
    markCoveredStatus,
    showProgress,
    setPhase,
    setLastError,
    clearPlanHash,
  ]);

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
        throw new UserFacingError("Missing account or destination.");
      }

      const passphrase = NETWORK_PASSPHRASES[network];
      verifyPreAuthTxHash(xdr, passphrase, signer.key);
      const sentMemo = confirmedMemo(destinationAddress, memo, memoType);

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
        preAuthorized: true,
        network,
        expected: {
          source: sourceAddress,
          destination: destinationAddress,
          nativeBalance: accountState?.nativeBalanceLumens ?? "0",
          memo: sentMemo?.memo ?? null,
          memoType: sentMemo?.memoType ?? null,
          claimTrustlineAssets,
          accountSigners: accountState?.signers ?? [],
          accountThresholds: accountState?.thresholds ?? { low: 0, med: 1, high: 1 },
          transfers: chosenTransfers(
            useDemolishStore.getState().assetDispositions,
            useDemolishStore.getState().transferDestinations,
            accountState,
            claimableBalanceSelections
          ),
          tokenTransfers: chosenTokenTransfers(
            useDemolishStore.getState().assetDispositions,
            useDemolishStore.getState().transferDestinations,
            accountState
          ),
          classicConversions: chosenClassicConversions(
            useDemolishStore.getState().assetDispositions,
            useDemolishStore.getState().classicConversionFloors
          ),
          tokenConversions: chosenTokenConversions(
            useDemolishStore.getState().assetDispositions,
            useDemolishStore.getState().tokenConversionFloors,
            accountState
          ),
          ...exitExpectations(accountState, network),
        },
      });

      try {
        await submitViaApi(xdr, network);
      } catch (err) {
        if (isSubmitRefused(err)) throw err;
        throw new UserFacingError(
          `This transaction may already be on the network. Look up ${submissionHash(xdr, passphrase)} on an explorer before trying again.`
        );
      }
      useDemolishStore.getState().clearPlanHash();
      if (signerStateRef.current && signerStateForRef.current === `${network}:${sourceAddress}`) {
        signerStateRef.current = applyConfirmedTransaction(
          signerStateRef.current,
          xdr,
          passphrase,
          intentFromXdr(xdr, passphrase).operations,
          sourceAddress
        );
      }
    },
    [network, sourceAddress, destinationAddress, memo, memoType]
  );

  return {
    run,
    progress,
    signatureStatus,
    submitPreAuthTransaction,
    checkUnconfirmed,
    retrySafe,
    stillUnconfirmed,
  };
}
