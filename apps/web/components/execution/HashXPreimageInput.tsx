"use client";

import { useState } from "react";
import { CheckCircle, Info, XCircle } from "lucide-react";
import { HashXPreimageSigner, type TransactionSigner } from "@/lib/stellar/signer";
import { verifyHashXPreimage, InvalidPreimageError } from "@/lib/stellar/hash-x";
import { cn } from "@/lib/utils/cn";
import type { AccountSigner } from "@/types/account";

function shortAddr(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-8)}`;
}

interface Props {
  signer: AccountSigner;
  disabled?: boolean;
  onApply: (signer: TransactionSigner) => void;
}

/**
 * Lets the user satisfy one hash(x) signer by pasting its preimage. A hash(x) signer's key IS
 * sha256(preimage) - there's no keypair a wallet could sign with, so this is the only way to
 * contribute its weight. Validates locally before ever constructing a signer; a mismatch is
 * shown inline and nothing is applied.
 */
export default function HashXPreimageInput({ signer, disabled, onApply }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  const submit = () => {
    setError(null);
    try {
      const preimage = verifyHashXPreimage(value, signer.key);
      setApplied(true);
      onApply(new HashXPreimageSigner(signer.key, preimage));
    } catch (err) {
      setError(
        err instanceof InvalidPreimageError ? err.message : "Could not apply this preimage."
      );
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <p className="font-mono-address text-xs text-white/55">
        {shortAddr(signer.key)} <span className="text-white/35">· weight {signer.weight}</span>
      </p>
      <p className="flex items-start gap-1.5 text-xs text-white/50">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-white/40" />
        This is a hash(x) signer - its key is the hash of a secret value (a &quot;preimage&quot;),
        not a wallet address, so no connected wallet or secret key can sign for it. If you know the
        preimage, enter it below to contribute this signer&apos;s weight.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
            setApplied(false);
          }}
          placeholder="hex-encoded preimage"
          disabled={disabled || applied}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          className={cn(
            "flex-1 font-mono-address bg-black/30 border rounded-lg px-3 py-2 text-sm",
            "placeholder:text-white/30",
            "focus:outline-none focus:ring-2 focus:ring-stellar/40",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            error ? "border-destructive" : "border-white/10"
          )}
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || applied || value.trim().length === 0}
          className="shrink-0 rounded-lg bg-stellar text-black text-xs font-semibold px-3 py-2 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-stellar/90 transition-colors"
        >
          Apply preimage
        </button>
      </div>
      {error && (
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <XCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}
      {applied && !error && (
        <p className="flex items-center gap-1.5 text-xs text-emerald-400">
          <CheckCircle className="h-3.5 w-3.5 shrink-0" />
          Preimage matches - contributing this signer&apos;s weight.
        </p>
      )}
    </div>
  );
}
