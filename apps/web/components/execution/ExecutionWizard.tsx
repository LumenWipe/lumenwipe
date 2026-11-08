"use client";

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle, ExternalLink, ShieldCheck } from "lucide-react";
import { explorerAccountUrl, explorerTxUrl, type Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import {
  useCloseExecution,
  type PreAuthSubmission,
  type RunOptions,
} from "@/hooks/useCloseExecution";
import type { AccountSigner } from "@/types/account";
import { useWalletKitConnection } from "@/hooks/useWalletKitConnection";
import { useActiveSigner, type SignerKind } from "@/hooks/useActiveSigner";
import { allows } from "@/lib/journey/claims";
import { routeForPhase } from "@/lib/journey/route-for-phase";
import { useJourneyState } from "@/lib/journey/use-journey-state";
import SecretKeyInput from "@/components/account-entry/SecretKeyInput";
import WalletConnectPanel, { OtherWalletChoice } from "@/components/wallet/WalletConnectPanel";
import PlanSidebar from "./PlanSidebar";
import UnconfirmedPanel from "./UnconfirmedPanel";
import ProgressIndicator from "./ProgressIndicator";
import PreSignPanel from "./PreSignPanel";
import SigningProgress from "./SigningProgress";
import CosignExchange from "./CosignExchange";
import StatusMessage from "@/components/a11y/StatusMessage";
import { SecretKeySigner, SignerReleasedError, type TransactionSigner } from "@/lib/stellar/signer";
import { signerStanding, signerStandingText } from "@/lib/stellar/signer-standing";
import { cosignRequirement, cosignStatement } from "@/lib/stellar/cosign-requirement";
import { relayRoute } from "@/lib/plan/destination-kind";
import { walletKitSigner } from "@/lib/wallet-kit/client";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { PROGRESS_NOT_SAVED } from "@/lib/utils/user-error";
import { activeStepIndex, isStalled, progressLine, STILL_WAITING } from "@/lib/execution/progress";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";

/**
 * How long Retry waits for a wallet prompt that timed out to answer. The kit cannot close a
 * prompt, so retrying at once can open a second one on top of it; once it answers, or after this
 * long, Retry is offered again. An extension that never answers does not hold Retry back for good.
 */
export const STALE_PROMPT_HOLD_MS = 5_000;

interface ExecutionWizardProps {
  network: Network;
}

type SignMode = "wallet" | "secret-key";

const SIGNER_KIND_LABEL: Record<SignerKind, string> = {
  wallet: "wallet",
  "secret-key": "secret key",
  "hash-x": "hash(x) preimage for",
};

export const ALREADY_SIGNED = "This signer already signed. Connect or enter a different signer.";
export const NOT_STILL_NEEDED =
  "This signer is not one this transaction still needs. Connect or enter a different signer.";
export const NOT_A_SIGNER =
  "This key cannot sign for this account. Connect or enter a signer of this account.";

function shortKey(key: string): string {
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** A key as the loaded-key notice shows it: enough of both ends to compare with the account's. */
function keyEnds(key: string): string {
  return `${key.slice(0, 6)}…${key.slice(-6)}`;
}

const SIGN_MODES: readonly TabItem<SignMode>[] = [
  { value: "wallet", label: "Connect wallet" },
  { value: "secret-key", label: "Use secret key (advanced)" },
];

export default function ExecutionWizard({ network }: ExecutionWizardProps) {
  const router = useRouter();
  const secretKeyRef = useRef<string>("");

  const executionPlan = useDemolishStore((s) => s.executionPlan);
  const destinationAddress = useDemolishStore((s) => s.destinationAddress);
  const mediatorRequired = useDemolishStore((s) => s.mediatorRequired);
  const phase = useDemolishStore((s) => s.phase);
  const journey = useJourneyState();
  const lastError = useDemolishStore((s) => s.lastError);
  const lastErrorReference = useDemolishStore((s) => s.lastErrorReference);
  const accountState = useDemolishStore((s) => s.accountState);
  const unconfirmedSubmission = useDemolishStore((s) => s.unconfirmedSubmission);
  const progressNotSaved = useDemolishStore((s) => s.progressNotSaved);
  const signingRun = useDemolishStore((s) => s.signingRun);
  const estimatedTransactionCount = useDemolishStore((s) => s.estimatedTransactionCount);
  const planTransactions = useDemolishStore((s) => s.planTransactions);

  const {
    run,
    progress,
    signatureStatus,
    cosign,
    importCosignResponse,
    discardCosignRound,
    signingPrompt,
    submitPreAuthTransaction,
    checkUnconfirmed,
    retrySafe,
    stillUnconfirmed,
  } = useCloseExecution();
  const walletConnection = useWalletKitConnection(network, { recheckOnFocus: true });
  // Which input the picker shows. It never decides who signs: `activeSigner` does.
  const [mode, setMode] = useState<SignMode>("wallet");
  // The one signer `execute()` uses, and the one the screen names. A wallet, a secret key and a
  // hash(x) preimage each become it the same way, so what is shown can never differ from what
  // signs. State holds only its kind and key; the signer itself is held outside React state.
  const {
    active: activeSigner,
    select: selectSigner,
    clear: dropSigner,
    endTurn,
    clearKind,
    current: heldSigner,
  } = useActiveSigner();
  // The hash of a pre-authorized transaction confirmed on this screen, kept on screen with its
  // explorer link across the views that follow.
  const [preAuthHash, setPreAuthHash] = useState<string | null>(null);
  // The close was last continued with no signer, after a pre-authorized transaction: Retry may
  // continue it the same way until a signer is used.
  const [continueWithoutSigner, setContinueWithoutSigner] = useState(false);
  // A pre-authorized transaction is being sent. Like a run, it holds every way to start
  // another signature until it settles; unlike a run, its panel stays on screen to show the
  // outcome next to the transaction pasted.
  const [submittingPreAuth, setSubmittingPreAuth] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  // Lets the user step out of the "failed" view to reconnect a wallet or switch
  // to the secret-key path, without touching the store's `phase` - purely a
  // local UI override. Reset whenever a fresh attempt starts.
  const [changingSigner, setChangingSigner] = useState(false);

  // Who can sign, with what weight: the live round's signers once a round paused for weight, as
  // the run last read them from the network; before the first round, the account as reviewed. A
  // co-signer added after review, or a weight changed since, is judged by the live list.
  const standingSigners = useMemo<readonly AccountSigner[]>(
    () =>
      signatureStatus
        ? [...signatureStatus.remainingSigners, ...signatureStatus.contributed]
        : (accountState?.signers ?? []),
    [signatureStatus, accountState]
  );
  const canSign = useCallback(
    (key: string): boolean => signerStanding(key, standingSigners).kind === "signer",
    [standingSigners]
  );

  // Only ed25519 signers can ever be satisfied by a connected wallet - hash(x)/pre-auth-tx
  // signers use different strkey prefixes and could never equal a wallet's `G...` address.
  // Matches the criterion Task 2 already applies one layer down in useCloseExecution.ts
  // (membership in accountState.signers, not bare equality to sourceAddress) - for a
  // multisig account, a co-signer's public key is by definition never === sourceAddress,
  // so gating on that alone would leave a correctly-connected co-signer wallet permanently
  // unusable. For the common single-sig case, accountState.signers has just the one
  // master-key entry, so this degrades to exactly {sourceAddress} - unchanged behavior.
  const knownEd25519SignerKeys = new Set(
    (accountState?.signers ?? []).filter((s) => s.type === "ed25519_public_key").map((s) => s.key)
  );
  const walletAddressIsKnownSigner =
    walletConnection.address !== null && knownEd25519SignerKeys.has(walletConnection.address);
  const signerReady = activeSigner.kind !== "none";

  // Bumped whenever the screen drops its signer on purpose (Forget key, the wallet tab, leaving
  // the screen, a finished close). A run captures it when it starts and stops before its next
  // signature once it changed, so a run never outlives the signer it was started with. A wallet
  // that only flickers out of use is left to the wallet's own check before each signature.
  const signerGeneration = useRef(0);

  const clearSigner = useCallback(() => {
    secretKeyRef.current = "";
    signerGeneration.current += 1;
    dropSigner();
  }, [dropSigner]);

  /** The check a run makes before each signature: the signer it started with is still the one. */
  const stillHeldCheck = useCallback(() => {
    const generation = signerGeneration.current;
    return async (): Promise<void> => {
      if (signerGeneration.current !== generation) throw new SignerReleasedError();
    };
  }, []);

  // The connected wallet, when it can sign here: a checked session (never a restored address
  // alone), a known signer on the account being closed (the source account's own key for
  // single-sig, or any co-signer for multisig - see walletAddressIsKnownSigner above), on this
  // page's network or confirmed by the user to be. A mismatch on any axis is surfaced by
  // WalletConnectPanel instead of being silently accepted or ignored.
  const usableWallet =
    walletConnection.address && walletAddressIsKnownSigner && walletConnection.verified
      ? walletConnection.address
      : null;
  // A check of the wallet still running holds signing until it settles or times out.
  const walletHeld = activeSigner.kind === "wallet" && walletConnection.checking;
  const walletSigner = useMemo(
    () => (usableWallet ? walletKitSigner(network, usableWallet) : null),
    [usableWallet, network]
  );
  // The wallet signer the screen names, read for rendering: the held signer is only read in
  // handlers and effects. The effect below makes the held signer this one whenever they differ.
  const activeWalletSigner =
    activeSigner.kind === "wallet" && walletSigner?.publicKey === activeSigner.id
      ? walletSigner
      : null;

  // The wallet becomes the active signer whenever nothing else is: on an explicit "Connect wallet"
  // click, on a session already connected during account entry, and again after a round that
  // reset the signer to none. A secret key or a preimage the user chose is never replaced by it,
  // and a wallet that stops being usable (disconnected, switched, stale, wrong network) stops
  // being the signer at once, as does one whose network answer arrives after its address.
  useEffect(() => {
    if (activeSigner.kind === "secret-key" || activeSigner.kind === "hash-x") return;
    if (walletSigner) {
      // With no signer, the wallet is picked up only from the wallet tab: on the secret-key tab the
      // user is choosing a key, and the screen names no signer until one is entered.
      const adopt =
        activeSigner.kind === "wallet" ? heldSigner()?.signer !== walletSigner : mode === "wallet";
      if (adopt) selectSigner("wallet", walletSigner);
    } else if (activeSigner.kind === "wallet") {
      dropSigner();
    }
  }, [activeSigner, walletSigner, mode, heldSigner, selectSigner, dropSigner]);

  // A round that still needs weight ends this signer's turn: whoever signs next is chosen again,
  // so the screen never keeps offering a signer that has just been used. A secret key is wiped;
  // a still-connected wallet is picked up again by the effect above, from the wallet tab only.
  useEffect(() => {
    if (signatureStatus === null) return;
    secretKeyRef.current = "";
    // A fresh `none`, never the shared one: when the wallet was adopted in this same commit,
    // setting the very state this render started from would be skipped, and the wallet effect
    // above would not run again to pick the wallet back up.
    endTurn();
  }, [signatureStatus, endTurn]);

  // Wipe signing material when the wizard unmounts (navigation away).
  useEffect(() => () => clearSigner(), [clearSigner]);

  // On success, wipe signing material and advance to the completion screen.
  useEffect(() => {
    if (routeForPhase(phase) === "complete") {
      clearSigner();
      router.push(`/${network}/complete`);
    }
  }, [phase, network, router, clearSigner]);

  const forgetKey = clearSigner;

  // Entering a working secret key supersedes a connected wallet: exactly one signer is ever live,
  // so the tabs can never disagree about which one `execute()` uses. An incomplete key only
  // clears a secret-key signer, never a wallet the user did not touch. Once the signer holds the
  // key, the raw string is dropped: the field is replaced by the loaded-key notice in the same
  // render, so nothing reads it again.
  const onSecretKeyValidityChange = useCallback(
    (valid: boolean) => {
      if (valid) {
        selectSigner("secret-key", new SecretKeySigner(secretKeyRef.current));
        secretKeyRef.current = "";
      } else {
        clearKind("secret-key");
      }
    },
    [selectSigner, clearKind]
  );

  const runWith = useCallback(
    async (signer: TransactionSigner | null, options?: RunOptions) => {
      if (running || submittingPreAuth) return;
      setChangingSigner(false);
      setRunning(true);
      try {
        // The engine re-reads on-chain state each round, so a retry after a failure
        // resumes: already-confirmed steps are not rebuilt or re-submitted.
        await run(signer, options);
      } finally {
        setRunning(false);
      }
    },
    [run, running, submittingPreAuth]
  );

  const execute = useCallback(async () => {
    // The held signer is the one the screen names: both are set and dropped together.
    const held = heldSigner();
    if (!held || walletHeld) return;
    // The same standing the screen shows, read again here: a key that cannot sign is never run,
    // whatever state the buttons were left in.
    if (!canSign(held.signer.publicKey)) return;
    setContinueWithoutSigner(false);
    const stillHeld = stillHeldCheck();
    // A wallet is checked again before each of its signatures in the run, not only now. Its own
    // check runs first, so a wallet that left is named as such.
    const walletCheck =
      held.kind === "wallet" ? walletConnection.beforeSigning(held.signer.publicKey) : null;
    await runWith(held.signer, {
      beforeSign: async () => {
        await walletCheck?.();
        await stillHeld();
      },
    });
  }, [heldSigner, walletHeld, canSign, runWith, walletConnection, stillHeldCheck]);

  // A pre-authorized transaction the network confirmed moves the close on by itself: the close
  // continues with no signer, which re-reads the account and either completes or pauses for the
  // next signature. It never sends anything, and a Retry of it never sends the pre-authorized
  // transaction again: only `run` is called again, never the submission.
  const submitPreAuth = useCallback(
    async (signer: AccountSigner, xdr: string): Promise<PreAuthSubmission> => {
      setSubmittingPreAuth(true);
      let result: PreAuthSubmission;
      try {
        result = await submitPreAuthTransaction(signer, xdr);
      } finally {
        setSubmittingPreAuth(false);
      }
      setPreAuthHash(result.hash);
      if (!result.closedAccount) {
        setContinueWithoutSigner(true);
        void runWith(null);
      }
      return result;
    },
    [submitPreAuthTransaction, runWith]
  );

  const retry = useCallback(async () => {
    if (activeSigner.kind === "none" && continueWithoutSigner) {
      await runWith(null);
      return;
    }
    await execute();
  }, [activeSigner, continueWithoutSigner, runWith, execute]);

  // A hash(x) signer's preimage has already been validated (HashXPreimageInput only calls
  // this with a confirmed match) - it becomes the active signer exactly like a connected
  // wallet or secret key would, and signs this round through the same run.
  const applyHashXPreimage = useCallback(
    (signer: TransactionSigner) => {
      selectSigner("hash-x", signer);
      // Named on screen either way; run only when the live round counts its weight.
      if (!canSign(signer.publicKey)) return;
      void runWith(signer, { beforeSign: stillHeldCheck() });
    },
    [selectSigner, canSign, runWith, stillHeldCheck]
  );

  // A run this mount did not start, as after a remount mid-run, still holds the close.
  // The store's flag also covers a pre-authorized submission, whose panel stays on screen.
  const inRun = running || (signingRun && !submittingPreAuth);
  // Nothing may start another signature while a run or a pre-authorized submission is in flight.
  const locked = running || submittingPreAuth;
  const busy = inRun || progress !== null;
  const elapsedSeconds = useElapsedSeconds(progress?.since ?? null);
  const line = progress ? progressLine(progress) : "Working…";
  const stalled = progress !== null && isStalled(progress, progress.since + elapsedSeconds * 1000);
  const currentStep = activeStepIndex(executionPlan);
  const halted = inRun ? null : journey.halted;
  const pendingMoreSignatures = halted === "failed" && signatureStatus !== null;
  const failed = halted === "failed" && !changingSigner && !pendingMoreSignatures;
  const unconfirmed = journey.halted === "unconfirmed" && unconfirmedSubmission !== null;
  const view = busy
    ? "busy"
    : unconfirmed
      ? "unconfirmed"
      : pendingMoreSignatures
        ? "signatures"
        : failed
          ? "failed"
          : "setup";

  const headingRef = useRef<HTMLHeadingElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const previousView = useRef(view);

  // After a wallet prompt timed out, Retry (or Add signature, when the partly signed round was
  // kept) waits for that prompt to answer or for STALE_PROMPT_HOLD_MS, whichever comes first, so
  // it does not stack a second prompt. The hold is read from the prompt itself at each render, so
  // a signer dropped and picked up again (the same instance, see walletKitSigner) is held again at
  // once, and only that prompt's release ends it.
  const stalePrompt =
    (view === "failed" || view === "signatures") && activeWalletSigner
      ? activeWalletSigner.stalePrompt()
      : null;
  const [releasedPrompt, setReleasedPrompt] = useState<Promise<void> | null>(null);
  useEffect(() => {
    if (!stalePrompt) return;
    let live = true;
    const release = (): void => {
      if (live) setReleasedPrompt(stalePrompt);
    };
    const timer = setTimeout(release, STALE_PROMPT_HOLD_MS);
    void stalePrompt.then(release);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [stalePrompt]);
  const retryHeld = stalePrompt !== null && releasedPrompt !== stalePrompt;

  // Focus follows a view swap only: the control that was clicked is unmounted by it, and focus
  // would otherwise drop to <body>. It never moves on first render, and never out of a field
  // the user is typing in.
  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement
    ) {
      return;
    }
    if (view === "failed") {
      const retry = retryRef.current;
      (retry && !retry.disabled ? retry : alertRef.current)?.focus();
    } else {
      headingRef.current?.focus();
    }
  }, [view]);

  const statusMessage = busy
    ? stalled
      ? `${line} ${STILL_WAITING}`
      : line
    : pendingMoreSignatures && signatureStatus
      ? `More signatures needed. ${signatureStatus.accumulatedWeight} of ${signatureStatus.requiredWeight} signing weight collected.`
      : "";

  if (executionPlan.length === 0 || !destinationAddress) {
    return (
      <div className="text-center py-12 text-fg-subtle text-sm">
        No execution plan found. Please go back and analyze your account.
      </div>
    );
  }

  // Announced BEFORE the first signature, not discovered by failing after it. The
  // signing-progress panel only exists once a signature has fallen short, so a user who did
  // not know their account was multisig used to learn it the hard way: sign, then be told
  // more weight is needed. A close always carries a high-threshold operation (the merge, and
  // the signer cleanup when extra signers exist), so the account's high threshold is the
  // weight this close must gather.
  const signers = accountState?.signers ?? [];
  const multisigNotice =
    signers.length > 1 && signatureStatus === null
      ? {
          requiredWeight: accountState?.thresholds.high ?? 1,
          signers,
          transactionCount: estimatedTransactionCount,
          cosign:
            accountState &&
            cosignRequirement({
              account: accountState.address,
              signers,
              thresholds: accountState.thresholds,
              transactions: planTransactions,
              viaRelay: relayRoute(destinationAddress) === "relay",
            }),
        }
      : null;

  // A signer the account does not list, or lists with weight 0, can never add weight: signing is
  // held with the reason on screen before the user confirms, not refused after a prompt.
  // "Add signature" also only reaches a signer this transaction still needs. A signer that already
  // signed would only be asked to approve a prompt that adds nothing; the weight check after
  // signing stays the guard, this only keeps the screen from walking into it.
  const activeId = activeSigner.kind === "none" ? null : activeSigner.id;
  const standing = activeId ? signerStanding(activeId, standingSigners) : null;
  const signerBlockedReason =
    standing && standing.kind !== "signer"
      ? NOT_A_SIGNER
      : signatureStatus &&
          activeId &&
          !signatureStatus.remainingSigners.some((s) => s.key === activeId)
        ? signatureStatus.contributed.some((s) => s.key === activeId)
          ? ALREADY_SIGNED
          : NOT_STILL_NEEDED
        : null;
  const blockedReasonLine = signerBlockedReason && (
    <p id="signer-blocked-reason" className="text-xs text-warning">
      {signerBlockedReason}
    </p>
  );

  // The wallet reported signing with another account: offer the way out, not just Retry.
  const walletAccountMismatch =
    activeWalletSigner !== null && activeWalletSigner.mismatchedAccount() !== null;

  const activeSignerLine =
    activeSigner.kind === "none" ? null : (
      <p data-testid="active-signer" className="text-xs text-fg-muted">
        Signing with {SIGNER_KIND_LABEL[activeSigner.kind]}{" "}
        <span className="font-mono-address text-white/80">{shortKey(activeSigner.id)}</span>
      </p>
    );

  const walletMismatchWarning =
    walletConnection.address && !walletAddressIsKnownSigner
      ? `Connected to ${walletConnection.address.slice(0, 4)}…${walletConnection.address.slice(-4)}, but this isn't one of this account's known signers. Disconnect and reconnect a wallet that can sign for it.`
      : undefined;

  // Shared by both the "pending more signatures" branch and the normal, first-attempt
  // branch below - a second signer picks up mid-close via the exact same mode tabs and
  // WalletConnectPanel/SecretKeyInput UI as the first, so the two call sites must never
  // drift apart into two implementations of the same picker.
  const renderSignerPicker = () => (
    <Tabs
      label="How to sign"
      items={locked ? SIGN_MODES.map((item) => ({ ...item, disabled: true })) : SIGN_MODES}
      value={mode}
      onValueChange={(next) => {
        setMode(next);
        // Going back to the wallet tab drops an entered key, so an already-connected,
        // matching wallet is picked back up without another "Connect" click.
        if (next === "wallet" && activeSigner.kind === "secret-key") clearSigner();
      }}
    >
      {mode === "wallet" ? (
        <WalletConnectPanel
          connection={walletConnection}
          disabled={locked}
          mismatchWarning={walletMismatchWarning}
          signerKeys={walletMismatchWarning ? [...knownEd25519SignerKeys] : undefined}
          signingNetwork={network}
        />
      ) : activeSigner.kind === "secret-key" ? (
        <Callout
          tone={standing?.kind === "signer" ? "success" : "warning"}
          announce={false}
          icon={
            standing?.kind === "signer" ? (
              <CheckCircle className="h-4 w-4" />
            ) : (
              <AlertCircle className="h-4 w-4" />
            )
          }
          className="items-center py-2"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p>Secret key loaded for this session</p>
              {standing && (
                <p data-testid="key-standing" className="text-xs">
                  Key <span className="font-mono-address">{keyEnds(activeSigner.id)}</span>:{" "}
                  {signerStandingText(standing)}
                </p>
              )}
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={forgetKey} disabled={locked}>
              Forget key
            </Button>
          </div>
        </Callout>
      ) : (
        <SecretKeyInput
          secretKeyRef={secretKeyRef}
          onValidityChange={onSecretKeyValidityChange}
          disabled={locked}
        />
      )}
    </Tabs>
  );

  return (
    <div className="flex gap-5">
      {/* Sidebar */}
      <div className="w-52 shrink-0 hidden md:block">
        <div className="sticky top-20">
          <p className="mkt-eyebrow text-fg-subtle mb-3">Steps</p>
          <PlanSidebar
            steps={executionPlan}
            currentIndex={currentStep}
            running={inRun}
            network={network}
          />
        </div>
      </div>

      {/* Main panel */}
      <div className="flex-1 min-w-0">
        <Card className="flex flex-col gap-5 p-6">
          <div>
            <h2
              ref={headingRef}
              tabIndex={-1}
              className="text-lg font-semibold text-white outline-none"
            >
              Sign &amp; execute the close
            </h2>
            <p className="mt-1 text-sm text-fg-muted">
              LumenWipe signs each transaction in your browser and submits it through the API. Your
              key never leaves this device.
            </p>
          </div>

          <Callout tone="info" icon={<ShieldCheck className="h-4 w-4" />}>
            Before you sign each transaction, your browser checks its destination, memo and what it
            does with each asset against what you chose, and does not sign it if anything does not
            match.
          </Callout>

          {/* Irreversible warning */}
          <Callout
            tone="danger"
            announce={false}
            title="This action is permanent and irreversible."
            className="p-4"
          >
            <p>
              The account will be removed from the Stellar ledger and its balance sent to{" "}
              <span className="font-mono text-white/80 break-all">{destinationAddress}</span>
              {mediatorRequired ? " through the exchange relay account." : "."} Verify it carefully.{" "}
              <a
                href={explorerAccountUrl(network, destinationAddress)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-accent hover:underline"
              >
                View the destination on Stellar Expert
                <ExternalLink aria-hidden="true" className="h-3 w-3" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </p>
          </Callout>

          {progressNotSaved && (
            <Callout tone="warning" icon={<AlertCircle className="h-4 w-4" />}>
              {PROGRESS_NOT_SAVED}
            </Callout>
          )}

          <StatusMessage message={statusMessage} />

          {!unconfirmed && activeSignerLine}

          {preAuthHash && (
            <Callout tone="success" announce={false} icon={<CheckCircle className="h-4 w-4" />}>
              Your pre-authorized transaction is confirmed on the network:{" "}
              <span className="font-mono-address break-all">{preAuthHash}</span>{" "}
              <a
                href={explorerTxUrl(network, preAuthHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-accent hover:underline"
              >
                View it on Stellar Expert
                <ExternalLink aria-hidden="true" className="h-3 w-3" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </Callout>
          )}

          {busy ? (
            <>
              <ProgressIndicator
                line={line}
                stalled={stalled}
                elapsedSeconds={elapsedSeconds}
                // A wallet on another device gives no sign here that its prompt arrived.
                showTimer={progress?.wait === "wallet-app"}
              />
              {signingPrompt && <PreSignPanel prompt={signingPrompt} />}
            </>
          ) : unconfirmed ? (
            <UnconfirmedPanel
              hash={unconfirmedSubmission.hash}
              stillUnconfirmed={stillUnconfirmed}
              onCheck={() => void checkUnconfirmed()}
            />
          ) : pendingMoreSignatures ? (
            <div className="flex flex-col gap-4">
              {signatureStatus.notice && (
                <Callout tone="warning" icon={<AlertCircle className="h-4 w-4" />}>
                  {signatureStatus.notice}
                </Callout>
              )}
              <SigningProgress
                status={signatureStatus}
                onApplyHashX={applyHashXPreimage}
                onSubmitPreAuthTx={submitPreAuth}
                network={network}
                disabled={locked}
              />
              {cosign && (
                <CosignExchange
                  status={cosign}
                  requiredWeight={signatureStatus.requiredWeight}
                  onImport={importCosignResponse}
                  onContinue={() => void runWith(null, { cosignedResume: true })}
                  onRebuild={() => {
                    discardCosignRound();
                    void execute();
                  }}
                  canRebuild={signerReady}
                  disabled={locked}
                />
              )}
              {renderSignerPicker()}
              {blockedReasonLine}
              <Button
                onClick={execute}
                disabled={
                  !signerReady || locked || walletHeld || retryHeld || signerBlockedReason !== null
                }
                aria-describedby={signerBlockedReason ? "signer-blocked-reason" : undefined}
                className="w-full"
              >
                Add signature
              </Button>
            </div>
          ) : failed ? (
            <div className="flex flex-col gap-3">
              <Callout
                ref={alertRef}
                tabIndex={-1}
                tone="danger"
                className="outline-none"
                icon={<AlertCircle className="h-4 w-4" />}
              >
                {lastError ?? "The close could not be completed."}
                {lastErrorReference && (
                  <span className="mt-1 block text-xs text-fg-subtle">
                    Reference: {lastErrorReference}
                  </span>
                )}
              </Callout>
              {walletAccountMismatch && (
                <OtherWalletChoice
                  connection={walletConnection}
                  signerKeys={[...knownEd25519SignerKeys]}
                />
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setChangingSigner(true)}
                className="self-start"
              >
                Change wallet or key
              </Button>
              {blockedReasonLine}
              <Button
                ref={retryRef}
                onClick={retry}
                disabled={
                  !(signerReady || continueWithoutSigner) ||
                  locked ||
                  walletHeld ||
                  retryHeld ||
                  signerBlockedReason !== null
                }
                aria-describedby={signerBlockedReason ? "signer-blocked-reason" : undefined}
                className="w-full"
              >
                Retry
              </Button>
              {retrySafe === true && allows(journey, "safe-to-retry") && (
                <p className="text-xs text-fg-subtle">
                  Safe to retry. LumenWipe re-reads your account first, so a confirmed transaction
                  is never sent twice.
                </p>
              )}
            </div>
          ) : (
            <>
              {multisigNotice && (
                <Card data-testid="multisig-notice" className="flex flex-col gap-2 p-4">
                  {multisigNotice.cosign ? (
                    <>
                      <p data-testid="multisig-statement" className="text-sm text-white/70">
                        {cosignStatement(multisigNotice.cosign).join(" ")}
                      </p>
                      <p className="text-sm text-white/70">
                        This is a multisig account: completing the close needs a total signing
                        weight of {multisigNotice.requiredWeight}. Sign with one signer, then the
                        next.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-white/70">
                        This is a multisig account: completing the close needs a total signing
                        weight of {multisigNotice.requiredWeight}. Sign with one signer, then the
                        next. A step that removes signers before the merge must include the
                        account&apos;s master key, and a preimage is only used on a step that
                        removes its own signer.
                      </p>
                      <p className="text-sm text-white/70">
                        Each transaction needs that full weight on its own
                        {multisigNotice.transactionCount !== null
                          ? `, so expect to sign up to ${multisigNotice.transactionCount} time${multisigNotice.transactionCount === 1 ? "" : "s"} with each signer.`
                          : ", so expect to sign once per transaction with each signer."}
                      </p>
                    </>
                  )}
                  <ul className="space-y-1">
                    {multisigNotice.signers.map((s) => (
                      <li key={s.key} className="font-mono-address text-xs text-fg-muted">
                        {s.key.slice(0, 8)}…{s.key.slice(-8)}{" "}
                        <span className="text-fg-subtle">· weight {s.weight}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {renderSignerPicker()}

              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  className="mt-0.5 accent-accent"
                />
                <span className="text-sm text-white/60">
                  I understand this permanently closes the account and sends its balance to the
                  destination above.
                </span>
              </label>

              {blockedReasonLine}
              <Button
                variant="danger"
                onClick={execute}
                disabled={!signerReady || walletHeld || !confirmed || signerBlockedReason !== null}
                aria-describedby={signerBlockedReason ? "signer-blocked-reason" : undefined}
                className="w-full"
              >
                Sign &amp; execute close
              </Button>
            </>
          )}
        </Card>

        {/* Mobile step list */}
        <div className="md:hidden mt-5">
          <p className="mkt-eyebrow text-fg-subtle mb-2">All steps</p>
          <PlanSidebar
            steps={executionPlan}
            currentIndex={currentStep}
            running={inRun}
            network={network}
          />
        </div>
      </div>
    </div>
  );
}
