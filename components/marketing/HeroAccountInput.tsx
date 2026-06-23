"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Search, AlertCircle } from "lucide-react";

function isValidStellarAddress(addr: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(addr);
}

export default function HeroAccountInput() {
  const router = useRouter();
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = address.trim();
    if (!trimmed) {
      setError("Enter a Stellar account address.");
      return;
    }
    if (!isValidStellarAddress(trimmed)) {
      setError("Not a valid Stellar address — must start with G and be 56 characters.");
      return;
    }
    setError(null);
    router.push(`/mainnet/analyze?source=${encodeURIComponent(trimmed)}`);
  }

  return (
    <div className="w-full max-w-2xl mx-auto">
      <form onSubmit={handleSubmit}>
        <div
          className={`flex items-center gap-2 rounded-2xl border bg-white/[0.04] p-2 transition-colors focus-within:border-stellar/50 ${
            error ? "border-red-500/40" : "border-white/12"
          }`}
        >
          <Search className="ml-2 h-4 w-4 shrink-0 text-white/30" />
          <input
            type="text"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Paste a Stellar account address — G…"
            className="flex-1 bg-transparent py-2 pr-2 mkt-mono text-[0.8rem] text-white placeholder:text-white/25 outline-none min-w-0"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
          />
          <button
            type="submit"
            className="shrink-0 rounded-xl bg-value px-5 py-2.5 text-sm font-semibold text-[hsl(var(--value-foreground))] transition-all hover:bg-value/90 hover:shadow-[0_8px_24px_-8px_hsl(var(--value)/0.6)]"
          >
            Analyze account
          </button>
        </div>
      </form>

      {error ? (
        <p className="mt-2.5 flex items-center gap-1.5 text-xs text-red-400">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      ) : (
        <p className="mt-2.5 text-center text-xs text-white/35">
          Analyzes on mainnet · read-only until you sign · no account needed
        </p>
      )}
    </div>
  );
}
