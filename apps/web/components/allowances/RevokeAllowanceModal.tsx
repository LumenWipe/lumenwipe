"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, KeyRound, ShieldOff, Wallet, X } from "lucide-react";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import type { Allowance } from "@/types/allowance";
import { PROTOCOL_LABELS } from "@/lib/plan/describe-position";
import { formatTokenAmount } from "@/lib/utils/token-amounts";
import { OUTCOME_HELD, readApiError, toUserMessage, UserFacingError } from "@/lib/utils/user-error";
import { useWalletKitConnection } from "@/hooks/useWalletKitConnection";
import { walletKitSigner } from "@/lib/wallet-kit/client";
import { SecretKeySigner, type TransactionSigner } from "@/lib/stellar/signer";
import { verifyRevokeAllowanceTransaction } from "@/lib/stellar/verify-revoke-allowance";
import { findUnresolved } from "@/lib/session/recovery";
import { submitViaApi } from "@/lib/stellar/submit-via-api";
import WalletConnectPanel from "@/components/wallet/WalletConnectPanel";
import SecretKeyInput from "@/components/account-entry/SecretKeyInput";
import { cn } from "@/lib/utils/cn";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";

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
  const pickerShown = step === "confirm" || step === "signing" || step === "failed";
  const keyFieldShown = pickerShown && mode === "secret-key";

  // The field mounts empty, so the key and its validity go with it whenever it leaves.
  useEffect(() => {
    if (!keyFieldShown) return;
    return () => {
      secretKeyRef.current = "";
      setKeyValid(false);
    };
  }, [keyFieldShown]);

  async function handleConfirm() {
    setError(null);
    setStep("signing");
    try {
      if (await findUnresolved(network, owner)) throw new UserFacingError(OUTCOME_HELD);

      let signer: TransactionSigner;
      if (mode === "wallet") {
        if (!walletConnection.address || !walletMatches) {
          throw new UserFacingError("Connect the wallet that owns this account first.");
        }
        signer = walletKitSigner(network, walletConnection.address);
      } else {
        signer = new SecretKeySigner(secretKeyRef.current);
        if (signer.publicKey !== owner) {
          throw new UserFacingError(
            "That secret key does not match the account this allowance belongs to."
          );
        }
      }

      const res = await fetch(`/api/${network}/allowances/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, token: allowance.token, spender: allowance.spender }),
      });
      if (!res.ok) throw await readApiError(res);
      const data = (await res.json().catch(() => ({}))) as { transaction?: string };
      if (!data.transaction)
        throw new UserFacingError("The server returned no transaction to sign.");

      const passphrase = NETWORK_PASSPHRASES[network];
      // The trust anchor for this action - see verify-revoke-allowance.ts. Every expected value
      // is what this modal already shows the user, never anything from the response above.
      verifyRevokeAllowanceTransaction(data.transaction, passphrase, {
        owner,
        token: allowance.token,
        spender: allowance.spender,
      });

      const signedXdr = await signer.sign(data.transaction, passphrase);
      const signedTx = TransactionBuilder.fromXdr(signedXdr, passphrase);
      if (signedTx.signatures.length === 0) {
        throw new UserFacingError("The signer did not add a signature.");
      }

      await submitViaApi(signedXdr, network);
      setStep("done");
      onRevoked(allowance);
    } catch (err) {
      setError(toUserMessage(err, "execute"));
      setStep("failed");
    }
  }

  const busy = step === "signing";

  return (
    <Dialog dismissible={!busy} suspended={walletConnection.connecting} onClose={onClose}>
      <div className="flex items-start gap-3 border-b border-white/10 px-5 py-4">
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
            step === "done" ? "bg-success/15 text-success" : "bg-warning/15 text-warning"
          )}
        >
          {step === "done" ? (
            <CheckCircle2 className="h-5 w-5" />
          ) : (
            <ShieldOff className="h-5 w-5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <DialogTitle className="text-base font-semibold text-white">
            {step === "done" ? "Allowance revoked" : "Revoke this allowance"}
          </DialogTitle>
          <DialogDescription className="mt-0.5 text-xs text-fg-subtle">
            {tokenLabel} · {amountLabel}
          </DialogDescription>
        </div>
        {!busy && (
          <button
            onClick={onClose}
            className="text-fg-subtle hover:text-white transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <DialogBody className="px-5 py-4 space-y-4 text-sm">
        {step !== "done" && (
          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-1.5 text-xs">
            <div className="flex justify-between gap-3">
              <span className="text-fg-subtle">Token</span>
              <span className="font-mono-address text-white/80">{tokenLabel}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-fg-subtle">Spender</span>
              <span className="font-mono-address text-white/80">
                {shortAddress(allowance.spender)}
                {spenderLabel && <span className="ml-1 text-fg-muted">({spenderLabel})</span>}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-fg-subtle">Amount</span>
              <span className="text-white/80">{amountLabel}</span>
            </div>
          </div>
        )}

        {pickerShown ? (
          <>
            <p className="leading-relaxed text-white/65">
              This sets the allowance to zero. The spender will no longer be able to move any of
              your {tokenLabel} - this does not affect your balance.
            </p>

            <Tabs
              label="How to sign"
              size="sm"
              items={[
                {
                  value: "wallet",
                  label: "Wallet",
                  icon: <Wallet className="h-3.5 w-3.5" />,
                  disabled: busy,
                },
                {
                  value: "secret-key",
                  label: "Secret key",
                  icon: <KeyRound className="h-3.5 w-3.5" />,
                  disabled: busy,
                },
              ]}
              value={mode}
              onValueChange={setMode}
            >
              {keyFieldShown ? (
                <SecretKeyInput
                  secretKeyRef={secretKeyRef}
                  onValidityChange={setKeyValid}
                  disabled={busy}
                />
              ) : (
                <WalletConnectPanel
                  connection={walletConnection}
                  disabled={busy}
                  mismatchWarning={
                    walletConnection.address && !walletMatches
                      ? `Connected wallet doesn't match this account (${shortAddress(owner)}).`
                      : undefined
                  }
                />
              )}
            </Tabs>

            {error && (
              <p className="flex items-start gap-1.5 text-xs text-danger-fg">
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
      </DialogBody>

      <DialogFooter className="border-t border-white/10 px-5 py-4">
        {step === "done" ? (
          <Button onClick={onClose} className="w-full">
            Done
          </Button>
        ) : (
          <Button
            variant="warning"
            onClick={handleConfirm}
            disabled={!signerReady || busy}
            loading={busy}
            className="w-full"
          >
            {busy ? "Revoking…" : "Revoke allowance"}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
