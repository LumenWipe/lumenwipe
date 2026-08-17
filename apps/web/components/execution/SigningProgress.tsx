import type { SignatureStatus } from "@/hooks/useCloseExecution";
import type { TransactionSigner } from "@/lib/stellar/signer";
import HashXPreimageInput from "./HashXPreimageInput";

function shortAddr(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-8)}`;
}

interface Props {
  status: SignatureStatus;
  /** Applies a hash(x) signer's validated preimage as this round's signer and re-attempts.
   *  Omitted in contexts that don't drive the close loop (e.g. this component's own tests). */
  onApplyHashX?: (signer: TransactionSigner) => void;
  disabled?: boolean;
}

export default function SigningProgress({ status, onApplyHashX, disabled }: Props) {
  const { requiredWeight, accumulatedWeight, remainingSigners } = status;
  const remaining = Math.max(0, requiredWeight - accumulatedWeight);
  const pct = Math.min(100, Math.round((accumulatedWeight / requiredWeight) * 100));
  const satisfiable = remainingSigners.filter((s) => s.type === "ed25519_public_key");
  const hashXSigners = remainingSigners.filter((s) => s.type === "hash_x");
  const unsatisfiable = remainingSigners.filter(
    (s) => s.type !== "ed25519_public_key" && s.type !== "hash_x"
  );
  // Only the fully-unsatisfiable signers (pre-auth-tx, ed25519-signed-payload - #102's scope)
  // block completion purely by existing; hash(x) signers have a path (below), so they're
  // excluded from this "nothing can be done" gate even before one is actually resolved.
  const satisfiableWeight = [...satisfiable, ...hashXSigners].reduce(
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
