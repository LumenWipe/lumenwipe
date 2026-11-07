import { CheckCircle } from "lucide-react";
import type { PreAuthSubmission, SignatureStatus } from "@/hooks/useCloseExecution";
import type { Network } from "@/config/networks";
import type { TransactionSigner } from "@/lib/stellar/signer";
import type { AccountSigner } from "@/types/account";
import HashXPreimageInput from "./HashXPreimageInput";
import PreAuthTxInput from "./PreAuthTxInput";
import { Card } from "@/components/ui/card";

function shortAddr(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-8)}`;
}

interface Props {
  status: SignatureStatus;
  /** Applies a hash(x) signer's validated preimage as this round's signer and re-attempts.
   *  Omitted in contexts that don't drive the close loop (e.g. this component's own tests). */
  onApplyHashX?: (signer: TransactionSigner) => void;
  /** Validates and submits a pre-auth-tx signer's pasted transaction directly, bypassing the
   *  round loop entirely (see useCloseExecution's submitPreAuthTransaction). Omitted in
   *  contexts that don't drive the close loop. */
  onSubmitPreAuthTx?: (signer: AccountSigner, xdr: string) => Promise<PreAuthSubmission>;
  /** The page's network, to decode a pasted pre-authorized transaction for review. */
  network: Network;
  disabled?: boolean;
}

export default function SigningProgress({
  status,
  onApplyHashX,
  onSubmitPreAuthTx,
  network,
  disabled,
}: Props) {
  const { requiredWeight, accumulatedWeight, contributed, remainingSigners } = status;
  const remaining = Math.max(0, requiredWeight - accumulatedWeight);
  const pct = Math.min(100, Math.round((accumulatedWeight / requiredWeight) * 100));
  const satisfiable = remainingSigners.filter((s) => s.type === "ed25519_public_key");
  const hashXSigners = remainingSigners.filter((s) => s.type === "hash_x");
  const preAuthTxSigners = remainingSigners.filter((s) => s.type === "preauth_tx");
  const unsatisfiable = remainingSigners.filter(
    (s) => s.type !== "ed25519_public_key" && s.type !== "hash_x" && s.type !== "preauth_tx"
  );
  // Only the fully-unsatisfiable signers (ed25519-signed-payload, which #98/#1 already confirmed
  // is fully removed before signing is ever needed, so it should never actually appear here)
  // block completion purely by existing; hash(x) and pre-auth-tx signers each have a path
  // (below), so they're excluded from this "nothing can be done" gate even before one is
  // actually resolved.
  const satisfiableWeight = [...satisfiable, ...hashXSigners, ...preAuthTxSigners].reduce(
    (sum, s) => sum + s.weight,
    0
  );
  const blockedByUnsatisfiable = satisfiableWeight < remaining;
  const stillNeeded = [...satisfiable, ...hashXSigners, ...preAuthTxSigners];
  const collected = `${accumulatedWeight} of ${requiredWeight} signature weight collected`;

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div>
        <p className="text-sm text-white/70">
          This account needs {remaining} more signing weight before it can be submitted (
          {accumulatedWeight} of {requiredWeight} collected).
        </p>
        <div
          role="progressbar"
          aria-label="Signature weight"
          aria-valuemin={0}
          aria-valuemax={requiredWeight}
          aria-valuenow={Math.min(accumulatedWeight, requiredWeight)}
          aria-valuetext={collected}
          className="mt-2 h-1.5 w-full rounded-full bg-white/10"
        >
          <div className="h-1.5 rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
      </div>
      {contributed.length > 0 && (
        <ul aria-label="Signed" className="space-y-1">
          {contributed.map((s) => (
            <li
              key={s.key}
              className="flex items-center gap-1.5 font-mono-address text-xs text-fg-muted"
            >
              <CheckCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-success" />
              {shortAddr(s.key)} <span className="text-fg-subtle">· signed, weight {s.weight}</span>
            </li>
          ))}
        </ul>
      )}
      {stillNeeded.length > 0 && (
        <p className="text-xs text-fg-muted">
          Need {remaining} more of:{" "}
          <span className="font-mono-address">
            {stillNeeded.map((s) => `${shortAddr(s.key)} (weight ${s.weight})`).join(", ")}
          </span>
        </p>
      )}
      {hashXSigners.length > 0 && (
        <div className="flex flex-col gap-2">
          {hashXSigners.map((s) => (
            <HashXPreimageInput
              key={s.key}
              signer={s}
              disabled={disabled}
              onApply={(signer) => onApplyHashX?.(signer)}
            />
          ))}
        </div>
      )}
      {preAuthTxSigners.length > 0 && (
        <div className="flex flex-col gap-2">
          {preAuthTxSigners.map((s) => (
            <PreAuthTxInput
              key={s.key}
              signer={s}
              network={network}
              disabled={disabled}
              onSubmit={async (signer, xdr) => {
                if (!onSubmitPreAuthTx) throw new Error("Not available.");
                return onSubmitPreAuthTx(signer, xdr);
              }}
            />
          ))}
        </div>
      )}
      {unsatisfiable.length > 0 && (
        <p className="text-xs text-fg-subtle">
          {unsatisfiable.length} signer{unsatisfiable.length === 1 ? "" : "s"} on this account use a
          signature method LumenWipe can&apos;t yet contribute automatically
          {blockedByUnsatisfiable
            ? " - this close cannot complete until manual support for them ships."
            : "."}
        </p>
      )}
    </Card>
  );
}
