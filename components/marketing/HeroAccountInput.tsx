"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ScanLine } from "lucide-react";
import type { Network } from "@/config/networks";
import { isValidGAddress } from "@/lib/utils/validation";
import { buildAnalyzeHref } from "@/lib/utils/analyze-link";
import { cn } from "@/lib/utils/cn";

const NETWORKS: Network[] = ["mainnet", "testnet"];

export default function HeroAccountInput(): React.JSX.Element {
  const router = useRouter();
  const [network, setNetwork] = useState<Network>("mainnet");
  const [source, setSource] = useState("");

  const trimmed = source.trim();
  const showError = trimmed.length > 0 && !isValidGAddress(trimmed);
  const href = buildAnalyzeHref(network, source);

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (href) router.push(href);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mkt-panel mx-auto max-w-xl rounded-2xl p-4 text-left sm:p-5"
    >
      {/* Header: label + network toggle, grouped inside the panel */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="mkt-eyebrow text-white/45">Account to analyze</span>
        <div className="flex gap-1 rounded-lg border border-white/10 bg-white/[0.03] p-1">
          {NETWORKS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setNetwork(n)}
              className={cn(
                "rounded-md px-2.5 py-1 mkt-mono text-[0.62rem] uppercase tracking-wider transition-colors",
                network === n ? "bg-stellar/15 text-stellar" : "text-white/50 hover:text-white/80"
              )}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="G... (the account to close)"
          spellCheck={false}
          autoComplete="off"
          aria-label="Stellar account to analyze"
          className={cn(
            "min-w-0 flex-1 rounded-xl border bg-black/30 px-4 py-3 font-mono-address text-sm text-white",
            "placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-stellar/40",
            "transition-colors",
            showError ? "border-destructive focus:ring-destructive/50" : "border-white/10"
          )}
        />
        <button
          type="submit"
          disabled={!href}
          className={cn(
            "group inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-value px-5 py-3 text-sm font-semibold text-[hsl(var(--value-foreground))]",
            "transition-all hover:bg-value/90 hover:shadow-[0_12px_30px_-14px_hsl(var(--value)/0.7)]",
            "disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          )}
        >
          <ScanLine className="h-4 w-4" />
          Analyze account
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </button>
      </div>

      {showError && (
        <p className="mt-2 text-xs text-destructive">
          Not a valid Stellar address (must start with G).
        </p>
      )}
    </form>
  );
}
