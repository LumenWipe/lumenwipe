"use client";

import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, KeyRound, ShieldOff, Wallet, X } from "lucide-react";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import type { Allowance } from "@/types/allowance";
import { PROTOCOL_LABELS } from "@/lib/plan/describe-position";
import { formatTokenAmount } from "@/lib/utils/token-amounts";
import { useWalletKitConnection } from "@/hooks/useWalletKitConnection";
import { ensureWalletKitInitialized } from "@/lib/wallet-kit/client";
import { SecretKeySigner, WalletKitSigner, type TransactionSigner } from "@/lib/stellar/signer";
import { verifyRevokeAllowanceTransaction } from "@/lib/stellar/verify-revoke-allowance";
import { submitViaApi } from "@/lib/stellar/submit-via-api";
import WalletConnectPanel from "@/components/wallet/WalletConnectPanel";
import SecretKeyInput from "@/components/account-entry/SecretKeyInput";
import { cn } from "@/lib/utils/cn";

interface RevokeAllowanceModalProps {
  network: Network;
  owner: string;
  allowance: Allowance;
  onClose: () => void;
  /** Fires once the revocation is confirmed on-chain, so the list can drop this row. */
  onRevoked: (allowance: Allowance) => void;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

type SignMode = "wallet" | "secret-key";
type Step = "confirm" | "signing" | "done" | "failed";

/**
 * Builds, verifies, signs, and submits one revocation - a standalone signed action, not a step
 * in the close wizard, so it owns its own minimal sign-mode state rather than reusing
 * ExecutionWizard's multisig-aware machinery. Only a signer matching the account itself (the
 * common case for a spend allowance) can complete this; a multisig owner needs another path.
 */
export default function RevokeAllowanceModal({
  network,
  owner,
  allowance,
  onClose,
  onRevoked,
}: RevokeAllowanceModalProps) {
  const [mode, setMode] = useState<SignMode>("wallet");
  const secretKeyRef = useRef<string>("");
  const [keyValid, setKeyValid] = useState(false);
  const [step, setStep] = useState<Step>("confirm");
  const [error, setError] = useState<string | null>(null);
  const walletConnection = useWalletKitConnection(network);

  const tokenLabel = allowance.tokenSymbol ?? shortAddress(allowance.token);
  const amountLabel = formatTokenAmount(allowance.amount, allowance.tokenDecimals);
  const spenderLabel = allowance.spenderProtocol
    ? PROTOCOL_LABELS[allowance.spenderProtocol]
    : null;

  const walletMatches = walletConnection.address === owner;
  const signerReady = mode === "wallet" ? walletMatches : keyValid;

  async function handleConfirm() {
    setError(null);
    setStep("signing");
    try {
      let signer: TransactionSigner;
      if (mode === "wallet") {
        if (!walletConnection.address || !walletMatches) {
          throw new Error("Connect the wallet that owns this account first.");
        }
        signer = new WalletKitSigner(walletConnection.address, (xdr, opts) =>
          ensureWalletKitInitialized(network).signTransaction(xdr, opts)
        );
      } else {
        signer = new SecretKeySigner(secretKeyRef.current);
        if (signer.publicKey !== owner) {
          throw new Error("That secret key does not match the account this allowance belongs to.");
        }
      }

      const res = await fetch(`/api/${network}/allowances/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, token: allowance.token, spender: allowance.spender }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        transaction?: string;
        error?: { message?: string } | string;
      };
      if (!res.ok) {
        const message =
          typeof data.error === "object" && data.error?.message
            ? data.error.message
            : typeof data.error === "string"
              ? data.error
              : "Failed to build the revocation.";
        throw new Error(message);
      }
      if (!data.transaction) throw new Error("The server returned no transaction to sign.");

      const passphrase = NETWORK_PASSPHRASES[network];
      // The trust anchor for this action - see verify-revoke-allowance.ts. Every expected value
      // is what this modal already shows the user, never anything from the response above.
      verifyRevokeAllowanceTransaction(data.transaction, passphrase, {
        owner,
        token: allowance.token,
        spender: allowance.spender,
      });

      const signedXdr = await signer.sign(data.transaction, passphrase);
      const signedTx = TransactionBuilder.fromXDR(signedXdr, passphrase);
      if (signedTx.signatures.length === 0) {
        throw new Error("The signer did not add a signature.");
      }

      await submitViaApi(signedXdr, network);
      setStep("done");
      onRevoked(allowance);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke this allowance.");
      setStep("failed");
    }
  }

  const busy = step === "signing";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={busy ? undefined : onClose}
      />

      <div className="relative w-full max-w-md rounded-2xl border border-white/15 bg-card shadow-2xl">
        <div className="flex items-start gap-3 border-b border-white/10 px-5 py-4">
          <div
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
              step === "done" ? "bg-emerald-500/15 text-emerald-400" : "bg-warning/15 text-warning"
            )}
          >
            {step === "done" ? (
              <CheckCircle2 className="h-5 w-5" />
            ) : (
              <ShieldOff className="h-5 w-5" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-white">
              {step === "done" ? "Allowance revoked" : "Revoke this allowance"}
            </h2>
            <p className="mt-0.5 text-xs text-white/45">
              {tokenLabel} · {amountLabel}
            </p>
          </div>
          {!busy && (
            <button
              onClick={onClose}
              className="text-white/40 hover:text-white transition-colors"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="px-5 py-4 space-y-4 text-sm">
          {step !== "done" && (
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-1.5 text-xs">
              <div className="flex justify-between gap-3">
                <span className="text-white/45">Token</span>
                <span className="font-mono-address text-white/80">{tokenLabel}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-white/45">Spender</span>
                <span className="font-mono-address text-white/80">
                  {shortAddress(allowance.spender)}
                  {spenderLabel && <span className="ml-1 text-white/50">({spenderLabel})</span>}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-white/45">Amount</span>
                <span className="text-white/80">{amountLabel}</span>
              </div>
            </div>
          )}

          {step === "confirm" || step === "signing" || step === "failed" ? (
            <>
              <p className="leading-relaxed text-white/65">
                This sets the allowance to zero. The spender will no longer be able to move any of
                your {tokenLabel} - this does not affect your balance.
              </p>

              <div className="flex gap-2 rounded-lg border border-white/10 bg-black/20 p-1 text-xs">
                <button
                  type="button"
                  onClick={() => setMode("wallet")}
                  disabled={busy}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 transition-colors",
                    mode === "wallet"
                      ? "bg-white/10 text-white"
                      : "text-white/50 hover:text-white/80"
                  )}
                >
                  <Wallet className="h-3.5 w-3.5" /> Wallet
                </button>
                <button
                  type="button"
                  onClick={() => setMode("secret-key")}
                  disabled={busy}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 transition-colors",
                    mode === "secret-key"
                      ? "bg-white/10 text-white"
                      : "text-white/50 hover:text-white/80"
                  )}
                >
                  <KeyRound className="h-3.5 w-3.5" /> Secret key
                </button>
              </div>

              {mode === "wallet" ? (
                <WalletConnectPanel
                  connection={walletConnection}
                  disabled={busy}
                  mismatchWarning={
                    walletConnection.address && !walletMatches
                      ? `Connected wallet doesn't match this account (${shortAddress(owner)}).`
                      : undefined
                  }
                />
              ) : (
                <SecretKeyInput
                  secretKeyRef={secretKeyRef}
                  onValidityChange={setKeyValid}
                  disabled={busy}
                />
              )}

              {error && (
                <p className="flex items-start gap-1.5 text-xs text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  {error}
                </p>
              )}
            </>
          ) : (
            <p className="text-white/65">
              The allowance for {shortAddress(allowance.spender)} on {tokenLabel} is gone.
            </p>
          )}
        </div>

        <div className="border-t border-white/10 px-5 py-4">
          {step === "done" ? (
            <button
              onClick={onClose}
              className="w-full rounded-xl bg-stellar py-2.5 text-sm font-semibold text-black transition-all hover:bg-stellar/90"
            >
              Done
            </button>
          ) : (
            <button
              onClick={handleConfirm}
              disabled={!signerReady || busy}
              className="w-full rounded-xl bg-warning py-2.5 text-sm font-semibold text-black transition-all hover:bg-warning/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? "Revoking…" : "Revoke allowance"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
