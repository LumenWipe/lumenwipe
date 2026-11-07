"use client";

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle, ExternalLink, ShieldCheck } from "lucide-react";
import { explorerAccountUrl, type Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { useCloseExecution } from "@/hooks/useCloseExecution";
import { useWalletKitConnection } from "@/hooks/useWalletKitConnection";
import { allows } from "@/lib/journey/claims";
import { routeForPhase } from "@/lib/journey/route-for-phase";
import { useJourneyState } from "@/lib/journey/use-journey-state";
import SecretKeyInput from "@/components/account-entry/SecretKeyInput";
import WalletConnectPanel from "@/components/wallet/WalletConnectPanel";
import PlanSidebar from "./PlanSidebar";
import UnconfirmedPanel from "./UnconfirmedPanel";
import ProgressIndicator from "./ProgressIndicator";
import SigningProgress from "./SigningProgress";
import StatusMessage from "@/components/a11y/StatusMessage";
import { SecretKeySigner, WalletKitSigner, type TransactionSigner } from "@/lib/stellar/signer";
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

/**
 * The one signer `execute()` uses, and the one the screen names. A wallet, a secret key and a
 * hash(x) preimage each become it the same way, so what is shown can never differ from what
 * signs. `id` is the signer's key as the account lists it.
 */
export type ActiveSigner =
  | { kind: "none" }
  | { kind: "wallet" | "secret-key" | "hash-x"; id: string; signer: TransactionSigner };

const NO_SIGNER: ActiveSigner = { kind: "none" };

const SIGNER_KIND_LABEL: Record<Exclude<ActiveSigner["kind"], "none">, string> = {
  wallet: "wallet",
  "secret-key": "secret key",
  "hash-x": "hash(x) preimage for",
};

export const ALREADY_SIGNED = "This signer already signed. Connect or enter a different signer.";
export const NOT_STILL_NEEDED =
  "This signer is not one this transaction still needs. Connect or enter a different signer.";

function shortKey(key: string): string {
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
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

  const {
    run,
    progress,
    signatureStatus,
    submitPreAuthTransaction,
    checkUnconfirmed,
    retrySafe,
    stillUnconfirmed,
  } = useCloseExecution();
  const walletConnection = useWalletKitConnection(network);
  // Which input the picker shows. It never decides who signs: `activeSigner` does.
  const [mode, setMode] = useState<SignMode>("wallet");
  const [activeSigner, setActiveSigner] = useState<ActiveSigner>(NO_SIGNER);
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  // Lets the user step out of the "failed" view to reconnect a wallet or switch
  // to the secret-key path, without touching the store's `phase` - purely a
  // local UI override. Reset whenever a fresh attempt starts.
  const [changingSigner, setChangingSigner] = useState(false);

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

  const clearSigner = useCallback(() => {
    secretKeyRef.current = "";
    setActiveSigner(NO_SIGNER);
  }, []);

  // The connected wallet, when it can sign here: a known signer on the account being closed (the
  // source account's own key for single-sig, or any co-signer for multisig - see
  // walletAddressIsKnownSigner above) on this page's network. A mismatch on either axis is
  // surfaced by WalletConnectPanel instead of being silently accepted or ignored.
  const usableWallet =
    walletConnection.address && walletAddressIsKnownSigner && !walletConnection.networkMismatch
      ? walletConnection.address
      : null;
  const walletSigner = useMemo(
    () => (usableWallet ? walletKitSigner(network, usableWallet) : null),
    [usableWallet, network]
  );

  // The wallet becomes the active signer whenever nothing else is: on an explicit "Connect wallet"
  // click, on a session already connected during account entry, and again after a round that
  // reset the signer to none. A secret key or a preimage the user chose is never replaced by it,
  // and a wallet that stops being usable (disconnected, switched, wrong network) stops being the
  // signer at once. `useWalletKitConnection` commits `address` and `networkMismatch` in separate
  // updates, so this also retracts a wallet adopted a moment before its mismatch became known.
  useEffect(() => {
    if (activeSigner.kind === "secret-key" || activeSigner.kind === "hash-x") return;
    if (walletSigner) {
      // With no signer, the wallet is picked up only from the wallet tab: on the secret-key tab the
      // user is choosing a key, and the screen names no signer until one is entered.
      const adopt =
        activeSigner.kind === "wallet" ? activeSigner.signer !== walletSigner : mode === "wallet";
      if (adopt) {
        setActiveSigner({ kind: "wallet", id: walletSigner.publicKey, signer: walletSigner });
      }
    } else if (activeSigner.kind === "wallet") {
      setActiveSigner(NO_SIGNER);
    }
  }, [activeSigner, walletSigner, mode]);

  // A round that still needs weight ends this signer's turn: whoever signs next is chosen again,
  // so the screen never keeps offering a signer that has just been used. A secret key is wiped;
  // a still-connected wallet is picked up again by the effect above, from the wallet tab only.
  useEffect(() => {
    if (signatureStatus === null) return;
    secretKeyRef.current = "";
    // A fresh object, never NO_SIGNER itself: when the wallet was adopted in this same commit,
    // setting the very state this render started from would be skipped, and the wallet effect
    // above would not run again to pick the wallet back up.
    setActiveSigner({ kind: "none" });
  }, [signatureStatus]);

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
  // clears a secret-key signer, never a wallet the user did not touch.
  const onSecretKeyValidityChange = useCallback((valid: boolean) => {
    if (valid) {
      const signer = new SecretKeySigner(secretKeyRef.current);
      setActiveSigner({ kind: "secret-key", id: signer.publicKey, signer });
    } else {
      setActiveSigner((current) => (current.kind === "secret-key" ? NO_SIGNER : current));
    }
  }, []);

  const runWith = useCallback(
    async (signer: TransactionSigner) => {
      if (running) return;
      setChangingSigner(false);
      setRunning(true);
      try {
        // The engine re-reads on-chain state each round, so a retry after a failure
        // resumes: already-confirmed steps are not rebuilt or re-submitted.
        await run(signer);
      } finally {
        setRunning(false);
      }
    },
    [run, running]
  );

  const execute = useCallback(async () => {
    if (activeSigner.kind === "none") return;
    await runWith(activeSigner.signer);
  }, [activeSigner, runWith]);

  // A hash(x) signer's preimage has already been validated (HashXPreimageInput only calls
  // this with a confirmed match) - it becomes the active signer exactly like a connected
  // wallet or secret key would, and signs this round through the same run.
  const applyHashXPreimage = useCallback(
    (signer: TransactionSigner) => {
      setActiveSigner({ kind: "hash-x", id: signer.publicKey, signer });
      void runWith(signer);
    },
    [runWith]
  );

  // A run this mount did not start, as after a remount mid-run, still holds the close.
  const inRun = running || signingRun;
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

  // After a wallet prompt timed out, Retry waits for that prompt to answer or for
  // STALE_PROMPT_HOLD_MS, whichever comes first, so it does not stack a second prompt.
  const [retryHeld, setRetryHeld] = useState(false);
  useEffect(() => {
    if (view !== "failed") return;
    const signer = activeSigner.kind === "none" ? null : activeSigner.signer;
    const stale = signer instanceof WalletKitSigner ? signer.stalePrompt() : null;
    if (!stale) return;
    let live = true;
    const release = (): void => {
      if (live) setRetryHeld(false);
    };
    setRetryHeld(true);
    const timer = setTimeout(release, STALE_PROMPT_HOLD_MS);
    void stale.then(release);
    return () => {
      live = false;
      clearTimeout(timer);
      setRetryHeld(false);
    };
  }, [view, activeSigner]);
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
        }
      : null;

  // "Add signature" only reaches a signer this transaction still needs. A signer that already
  // signed would only be asked to approve a prompt that adds nothing; the weight check after
  // signing stays the guard, this only keeps the screen from walking into it.
  const activeId = activeSigner.kind === "none" ? null : activeSigner.id;
  const signerBlockedReason =
    signatureStatus && activeId && !signatureStatus.remainingSigners.some((s) => s.key === activeId)
      ? signatureStatus.contributed.some((s) => s.key === activeId)
        ? ALREADY_SIGNED
        : NOT_STILL_NEEDED
      : null;

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
      items={SIGN_MODES}
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
          disabled={running}
          mismatchWarning={walletMismatchWarning}
        />
      ) : activeSigner.kind === "secret-key" ? (
        <Callout
          tone="success"
          announce={false}
          icon={<CheckCircle className="h-4 w-4" />}
          className="items-center py-2"
        >
          <div className="flex items-center justify-between gap-3">
            Secret key loaded for this session
            <Button type="button" variant="ghost" size="sm" onClick={forgetKey}>
              Forget key
            </Button>
          </div>
        </Callout>
      ) : (
        <SecretKeyInput
          secretKeyRef={secretKeyRef}
          onValidityChange={onSecretKeyValidityChange}
          disabled={running}
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

          {busy ? (
            <ProgressIndicator
              line={line}
              stalled={stalled}
              elapsedSeconds={elapsedSeconds}
              // A wallet on another device gives no sign here that its prompt arrived.
              showTimer={progress?.wait === "wallet-app"}
            />
          ) : unconfirmed ? (
            <UnconfirmedPanel
              hash={unconfirmedSubmission.hash}
              stillUnconfirmed={stillUnconfirmed}
              onCheck={() => void checkUnconfirmed()}
            />
          ) : pendingMoreSignatures ? (
            <div className="flex flex-col gap-4">
              <SigningProgress
                status={signatureStatus}
                onApplyHashX={applyHashXPreimage}
                onSubmitPreAuthTx={submitPreAuthTransaction}
                disabled={running}
              />
              {renderSignerPicker()}
              {signerBlockedReason && (
                <p id="signer-blocked-reason" className="text-xs text-warning">
                  {signerBlockedReason}
                </p>
              )}
              <Button
                onClick={execute}
                disabled={!signerReady || signerBlockedReason !== null}
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setChangingSigner(true)}
                className="self-start"
              >
                Change wallet or key
              </Button>
              <Button
                ref={retryRef}
                onClick={execute}
                disabled={!signerReady || retryHeld}
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
                  <p className="text-sm text-white/70">
                    This is a multisig account: completing the close needs a total signing weight of{" "}
                    {multisigNotice.requiredWeight}. Sign with one signer, then the next. A step
                    that removes signers before the merge must include the account&apos;s master
                    key, and a preimage is only used on a step that removes its own signer.
                  </p>
                  <p className="text-sm text-white/70">
                    Each transaction needs that full weight on its own
                    {multisigNotice.transactionCount !== null
                      ? `, so expect to sign up to ${multisigNotice.transactionCount} time${multisigNotice.transactionCount === 1 ? "" : "s"} with each signer.`
                      : ", so expect to sign once per transaction with each signer."}
                  </p>
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

              <Button
                variant="danger"
                onClick={execute}
                disabled={!signerReady || !confirmed}
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
