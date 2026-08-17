import type { SignatureStatus } from "@/hooks/useCloseExecution";

function shortAddr(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-8)}`;
}

export default function SigningProgress({ status }: { status: SignatureStatus }) {
  const { requiredWeight, accumulatedWeight, remainingSigners } = status;
  const remaining = Math.max(0, requiredWeight - accumulatedWeight);
  const pct = Math.min(100, Math.round((accumulatedWeight / requiredWeight) * 100));
  const satisfiable = remainingSigners.filter((s) => s.type === "ed25519_public_key");
  const unsatisfiable = remainingSigners.filter((s) => s.type !== "ed25519_public_key");
  // The unsatisfiable signers only actually block completion when the satisfiable ones
  // alone can't clear the remaining weight - e.g. a 2-of-3 account short by 1 with two
  // ed25519 co-signers still un-contributed and one pre-auth-tx signer un-contributed
  // is NOT blocked, since either ed25519 signer closes it out.
  const satisfiableWeight = satisfiable.reduce((sum, s) => sum + s.weight, 0);
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
