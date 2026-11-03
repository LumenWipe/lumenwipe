"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle, ShieldCheck } from "lucide-react";
import type { Network } from "@/config/networks";
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
import { ensureWalletKitInitialized } from "@/lib/wallet-kit/client";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { PROGRESS_NOT_SAVED } from "@/lib/utils/user-error";

interface ExecutionWizardProps {
  network: Network;
}

type SignMode = "wallet" | "secret-key";

const SIGN_MODES: readonly TabItem<SignMode>[] = [
  { value: "wallet", label: "Connect wallet" },
  { value: "secret-key", label: "Use secret key (advanced)" },
];

export default function ExecutionWizard({ network }: ExecutionWizardProps) {
  const router = useRouter();
  const secretKeyRef = useRef<string>("");
  const signerRef = useRef<TransactionSigner | null>(null);

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

  const {
    run,
    progressStatus,
    signatureStatus,
    submitPreAuthTransaction,
    checkUnconfirmed,
    retrySafe,
    stillUnconfirmed,
  } = useCloseExecution();
  const walletConnection = useWalletKitConnection(network);
  const [mode, setMode] = useState<SignMode>("wallet");
  const [keyEntered, setKeyEntered] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  // True once the user has explicitly chosen the secret-key path over an available,
  // matching wallet. Without this, the reactive sync effect below would immediately
  // re-populate the wallet signer on the very next render - it's still connected
  // and still matching in the background - undoing the user's choice. Reset when
  // the user explicitly switches back to the wallet tab.
  const [walletDismissed, setWalletDismissed] = useState(false);
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
  const signerReady = mode === "wallet" ? walletAddress !== null : keyEntered;

  const clearSigner = useCallback(() => {
    secretKeyRef.current = "";
    signerRef.current = null;
    setKeyEntered(false);
    setWalletAddress(null);
  }, []);

  // Sync the active signer from the shared wallet-connection hook - this covers
  // both an explicit "Connect wallet" click AND a session already connected during
  // account entry, which the hook detects on mount without any click at all. Only
  // treat the connected wallet as the active signer when it's a known signer on the
  // account actually being closed (the source account's own key for single-sig, or
  // any co-signer for multisig - see walletAddressIsKnownSigner above), its network
  // matches the app's, and the user hasn't explicitly dismissed it in favor of the
  // secret-key path; a mismatch on any axis is surfaced by WalletConnectPanel's
  // `mismatchWarning`/`networkMismatch` instead of being silently accepted or
  // silently ignored.
  //
  // The `else if (walletAddress !== null)` branch matters beyond the obvious
  // "wallet disconnected" case: `useWalletKitConnection` commits `address` and
  // `networkMismatch` in two separate state updates (there's a real `await`
  // between them), so this effect can fire once with a matching address and no
  // known mismatch yet, populate the signer, and then fire again a moment later
  // once the mismatch becomes known. Without this branch, that second run would
  // hit neither condition and leave the already-populated (but now known-bad)
  // signer in place - this branch is what actually retracts it. It only ever
  // clears the *wallet* side (checked via `walletAddress`, not `keyEntered`), so
  // it can never stomp a live `SecretKeySigner`.
  useEffect(() => {
    if (
      !walletDismissed &&
      walletConnection.address &&
      walletAddressIsKnownSigner &&
      !walletConnection.networkMismatch
    ) {
      signerRef.current = new WalletKitSigner(walletConnection.address, (xdr, opts) =>
        ensureWalletKitInitialized(network).signTransaction(xdr, opts)
      );
      setWalletAddress(walletConnection.address);
      // A connected wallet supersedes any previously entered secret key, for the
      // same reason the secret-key handler supersedes a connected wallet below:
      // the secret-key tab must not keep showing "loaded" once a different signer
      // is what `execute()` will actually use.
      secretKeyRef.current = "";
      setKeyEntered(false);
    } else if (walletAddress !== null) {
      signerRef.current = null;
      setWalletAddress(null);
    }
  }, [
    walletConnection.address,
    walletConnection.networkMismatch,
    walletAddressIsKnownSigner,
    walletDismissed,
    walletAddress,
    network,
  ]);

  // Wipe signing material when the wizard unmounts (navigation away).
  useEffect(() => () => clearSigner(), [clearSigner]);

  // On success, wipe signing material and advance to the completion screen.
  useEffect(() => {
    if (routeForPhase(phase) === "complete") {
      clearSigner();
      router.push(`/${network}/complete`);
    }
  }, [phase, network, router, clearSigner]);

  const forgetKey = useCallback(() => {
    secretKeyRef.current = "";
    signerRef.current = null;
    setKeyEntered(false);
  }, []);

  const onSecretKeyValidityChange = useCallback(
    (valid: boolean) => {
      setKeyEntered(valid);
      if (valid) {
        signerRef.current = new SecretKeySigner(secretKeyRef.current);
        // Entering a working secret key supersedes any previously connected wallet -
        // exactly one signer is ever live, so the two tabs can never disagree about
        // which one `execute()` will actually use. Marking the wallet dismissed also
        // stops the reactive sync effect above from immediately re-populating it
        // just because it's still connected in the background.
        setWalletAddress(null);
        setWalletDismissed(true);
      } else if (!walletAddress) {
        // Only clear the shared signer if a wallet isn't the one currently holding
        // it - otherwise typing an incomplete key while a wallet is connected would
        // silently discard the wallet's signer without any visible feedback.
        signerRef.current = null;
      }
    },
    [walletAddress]
  );

  const execute = useCallback(async () => {
    if (!signerRef.current || running) return;
    setChangingSigner(false);
    setRunning(true);
    try {
      // The engine re-reads on-chain state each round, so a retry after a failure
      // resumes: already-confirmed steps are not rebuilt or re-submitted.
      await run(signerRef.current);
    } finally {
      setRunning(false);
    }
  }, [run, running]);

  // A hash(x) signer's preimage has already been validated (HashXPreimageInput only calls
  // this with a confirmed match) - apply it as this round's signer exactly like a connected
  // wallet or secret key would be, through the same execute() path.
  const applyHashXPreimage = useCallback(
    (signer: TransactionSigner) => {
      signerRef.current = signer;
      void execute();
    },
    [execute]
  );

  // A run this mount did not start, as after a remount mid-run, still holds the close.
  const inRun = running || signingRun;
  const busy = inRun || progressStatus !== null;
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
    ? (progressStatus ?? "Working…")
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
      ? { requiredWeight: accountState?.thresholds.high ?? 1, signers }
      : null;

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
        // Explicitly re-engaging the wallet tab re-arms the reactive
        // sync effect above, so an already-connected, matching wallet
        // is picked back up without requiring another "Connect" click.
        if (next === "wallet") setWalletDismissed(false);
      }}
    >
      {mode === "wallet" ? (
        <WalletConnectPanel
          connection={walletConnection}
          disabled={running}
          mismatchWarning={walletMismatchWarning}
        />
      ) : keyEntered ? (
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
          <PlanSidebar steps={executionPlan} currentIndex={0} />
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
              {mediatorRequired ? " through the exchange relay account." : "."} Verify it carefully.
            </p>
          </Callout>

          {progressNotSaved && (
            <Callout tone="warning" icon={<AlertCircle className="h-4 w-4" />}>
              {PROGRESS_NOT_SAVED}
            </Callout>
          )}

          <StatusMessage message={statusMessage} />

          {busy ? (
            <ProgressIndicator status={progressStatus ?? "Working…"} />
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
              <Button onClick={execute} disabled={!signerReady} className="w-full">
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
              <Button ref={retryRef} onClick={execute} disabled={!signerReady} className="w-full">
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
          <PlanSidebar steps={executionPlan} currentIndex={0} />
        </div>
      </div>
    </div>
  );
}
