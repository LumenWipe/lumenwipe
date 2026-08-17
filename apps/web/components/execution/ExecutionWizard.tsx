"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle, ShieldCheck } from "lucide-react";
import type { Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { useCloseExecution } from "@/hooks/useCloseExecution";
import { useWalletKitConnection } from "@/hooks/useWalletKitConnection";
import { cn } from "@/lib/utils/cn";
import SecretKeyInput from "@/components/account-entry/SecretKeyInput";
import WalletConnectPanel from "@/components/wallet/WalletConnectPanel";
import PlanSidebar from "./PlanSidebar";
import ProgressIndicator from "./ProgressIndicator";
import SigningProgress from "./SigningProgress";
import { SecretKeySigner, WalletKitSigner, type TransactionSigner } from "@/lib/stellar/signer";
import { ensureWalletKitInitialized } from "@/lib/wallet-kit/client";

interface ExecutionWizardProps {
  network: Network;
}

type SignMode = "wallet" | "secret-key";

export default function ExecutionWizard({ network }: ExecutionWizardProps) {
  const router = useRouter();
  const secretKeyRef = useRef<string>("");
  const signerRef = useRef<TransactionSigner | null>(null);

  const executionPlan = useDemolishStore((s) => s.executionPlan);
  const destinationAddress = useDemolishStore((s) => s.destinationAddress);
  const mediatorRequired = useDemolishStore((s) => s.mediatorRequired);
  const phase = useDemolishStore((s) => s.phase);
  const lastError = useDemolishStore((s) => s.lastError);
  const accountState = useDemolishStore((s) => s.accountState);

  const { run, progressStatus, signatureStatus } = useCloseExecution();
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
    if (phase === "COMPLETE") {
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

  if (executionPlan.length === 0 || !destinationAddress) {
    return (
      <div className="text-center py-12 text-white/45 text-sm">
        No execution plan found. Please go back and analyze your account.
      </div>
    );
  }

  const busy = running || progressStatus !== null;
  const pendingMoreSignatures = phase === "STEP_FAILED" && !running && signatureStatus !== null;
  const failed = phase === "STEP_FAILED" && !running && !changingSigner && !pendingMoreSignatures;
  const walletMismatchWarning =
    walletConnection.address && !walletAddressIsKnownSigner
      ? `Connected to ${walletConnection.address.slice(0, 4)}…${walletConnection.address.slice(-4)}, but this isn't one of this account's known signers. Disconnect and reconnect a wallet that can sign for it.`
      : undefined;

  // Shared by both the "pending more signatures" branch and the normal, first-attempt
  // branch below - a second signer picks up mid-close via the exact same mode tabs and
  // WalletConnectPanel/SecretKeyInput UI as the first, so the two call sites must never
  // drift apart into two implementations of the same picker.
  const renderSignerPicker = () => (
    <>
      <div className="flex gap-2 rounded-lg bg-white/[0.03] p-1">
        <button
          type="button"
          onClick={() => {
            setMode("wallet");
            // Explicitly re-engaging the wallet tab re-arms the reactive
            // sync effect above, so an already-connected, matching wallet
            // is picked back up without requiring another "Connect" click.
            setWalletDismissed(false);
          }}
          className={cn(
            "flex-1 py-2 rounded-md text-sm font-medium transition-colors",
            mode === "wallet" ? "bg-white/10 text-white" : "text-white/50 hover:text-white/80"
          )}
        >
          Connect wallet
        </button>
        <button
          type="button"
          onClick={() => setMode("secret-key")}
          className={cn(
            "flex-1 py-2 rounded-md text-sm font-medium transition-colors",
            mode === "secret-key" ? "bg-white/10 text-white" : "text-white/50 hover:text-white/80"
          )}
        >
          Use secret key (advanced)
        </button>
      </div>

      {mode === "wallet" ? (
        <WalletConnectPanel
          connection={walletConnection}
          disabled={running}
          mismatchWarning={walletMismatchWarning}
        />
      ) : keyEntered ? (
        <div className="flex items-center justify-between gap-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2.5">
          <span className="flex items-center gap-2 text-sm text-emerald-400">
            <CheckCircle className="h-4 w-4 shrink-0" />
            Secret key loaded for this session
          </span>
          <button
            type="button"
            onClick={forgetKey}
            className="text-xs text-white/60 hover:text-white underline-offset-2 hover:underline transition-colors"
          >
            Forget key
          </button>
        </div>
      ) : (
        <SecretKeyInput
          secretKeyRef={secretKeyRef}
          onValidityChange={onSecretKeyValidityChange}
          disabled={running}
        />
      )}
    </>
  );

  return (
    <div className="flex gap-5">
      {/* Sidebar */}
      <div className="w-52 shrink-0 hidden md:block">
        <div className="sticky top-20">
          <p className="mkt-eyebrow text-white/45 mb-3">Steps</p>
          <PlanSidebar steps={executionPlan} currentIndex={0} />
        </div>
      </div>

      {/* Main panel */}
      <div className="flex-1 min-w-0">
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 flex flex-col gap-5">
          <div>
            <h2 className="text-lg font-semibold text-white">Sign &amp; execute the close</h2>
            <p className="mt-1 text-sm text-white/55">
              LumenWipe signs each transaction in your browser and submits it through the API. Your
              key never leaves this device.
            </p>
          </div>

          {/* Trust note */}
          <div className="flex items-start gap-2.5 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-sm text-white/60">
            <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5 text-stellar" />
            <span>
              Every transaction is verified against your own choices - destination, asset decisions,
              and memo - before it is signed. Anything unexpected is rejected.
            </span>
          </div>

          {/* Irreversible warning */}
          <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 text-sm">
            <p className="font-semibold text-destructive mb-1">
              This action is permanent and irreversible.
            </p>
            <p className="text-white/60">
              The account will be removed from the Stellar ledger and its balance sent to{" "}
              <span className="font-mono text-white/80 break-all">{destinationAddress}</span>
              {mediatorRequired ? " through the exchange mediator." : "."} Verify it carefully.
            </p>
          </div>

          {busy ? (
            <ProgressIndicator status={progressStatus ?? "Working…"} />
          ) : pendingMoreSignatures ? (
            <div className="flex flex-col gap-4">
              <SigningProgress
                status={signatureStatus}
                onApplyHashX={applyHashXPreimage}
                disabled={running}
              />
              {renderSignerPicker()}
              <button
                onClick={execute}
                disabled={!signerReady}
                className="w-full py-3 px-4 rounded-xl font-semibold text-sm bg-stellar text-black hover:bg-stellar/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                Add signature
              </button>
            </div>
          ) : failed ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-white/70">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-destructive" />
                <span>{lastError ?? "The close could not be completed."}</span>
              </div>
              <button
                type="button"
                onClick={() => setChangingSigner(true)}
                className="self-start text-xs text-white/60 hover:text-white underline-offset-2 hover:underline transition-colors"
              >
                Change wallet or key
              </button>
              <button
                onClick={execute}
                disabled={!signerReady}
                className="w-full py-3 px-4 rounded-xl font-semibold text-sm bg-stellar text-black hover:bg-stellar/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                Retry
              </button>
            </div>
          ) : (
            <>
              {renderSignerPicker()}

              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  className="mt-0.5 accent-stellar"
                />
                <span className="text-sm text-white/60">
                  I understand this permanently closes the account and sends its balance to the
                  destination above.
                </span>
              </label>

              <button
                onClick={execute}
                disabled={!signerReady || !confirmed}
                className={cn(
                  "w-full py-3 px-4 rounded-xl font-semibold text-sm transition-all",
                  "flex items-center justify-center gap-2",
                  "bg-destructive text-destructive-foreground hover:bg-destructive/90",
                  "disabled:opacity-40 disabled:cursor-not-allowed"
                )}
              >
                Sign &amp; execute close
              </button>
            </>
          )}
        </div>

        {/* Mobile step list */}
        <div className="md:hidden mt-5">
          <p className="mkt-eyebrow text-white/45 mb-2">All steps</p>
          <PlanSidebar steps={executionPlan} currentIndex={0} />
        </div>
      </div>
    </div>
  );
}
