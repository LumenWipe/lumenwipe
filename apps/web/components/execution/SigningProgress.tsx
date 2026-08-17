import type { SignatureStatus } from "@/hooks/useCloseExecution";
import type { TransactionSigner } from "@/lib/stellar/signer";
import type { AccountSigner } from "@/types/account";
import HashXPreimageInput from "./HashXPreimageInput";
import PreAuthTxInput from "./PreAuthTxInput";

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
  onSubmitPreAuthTx?: (signer: AccountSigner, xdr: string) => Promise<void>;
  disabled?: boolean;
}

export default function SigningProgress({
  status,
  onApplyHashX,
  onSubmitPreAuthTx,
  disabled,
}: Props) {
  const { requiredWeight, accumulatedWeight, remainingSigners } = status;
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

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div>
        <p className="text-sm text-white/70">
          This account needs {remaining} more signing weight before it can be submitted (
          {accumulatedWeight} of {requiredWeight} collected).
        </p>
        <div className="mt-2 h-1.5 w-full rounded-full bg-white/10">
          <div className="h-1.5 rounded-full bg-stellar" style={{ width: `${pct}%` }} />
        </div>
      </div>
      {satisfiable.length > 0 && (
        <ul className="space-y-1">
          {satisfiable.map((s) => (
            <li key={s.key} className="font-mono-address text-xs text-white/55">
              {shortAddr(s.key)} <span className="text-white/35">· weight {s.weight}</span>
              <span className="text-white/35"> · hasn&apos;t signed yet</span>
            </li>
          ))}
        </ul>
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
              disabled={disabled}
              onSubmit={async (signer, xdr) => {
                if (!onSubmitPreAuthTx) throw new Error("Not available.");
                await onSubmitPreAuthTx(signer, xdr);
              }}
            />
          ))}
        </div>
      )}
      {unsatisfiable.length > 0 && (
        <p className="text-xs text-white/45">
          {unsatisfiable.length} signer{unsatisfiable.length === 1 ? "" : "s"} on this account use a
          signature method LumenWipe can&apos;t yet contribute automatically
          {blockedByUnsatisfiable
            ? " - this close cannot complete until manual support for them ships."
            : "."}
        </p>
      )}
    </div>
  );
}
