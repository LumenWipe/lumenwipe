"use client";

import { ArrowRightLeft, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { AssetConvertibility } from "@/lib/stellar/fast-path";
import { cn } from "@/lib/utils/cn";

interface AssetDispositionCardProps {
  item: AssetConvertibility;
  /** Whether the user has confirmed returning this non-convertible asset to its issuer. */
  returnConfirmed: boolean;
  onToggleReturn: (asset: string, confirmed: boolean) => void;
}

/**
 * One balance-bearing asset's disposition. Convertible assets are shown as a positive
 * swap label (the parent auto-sets their store disposition to "convert"). Non-convertible
 * assets stay unresolved (amber) until the user explicitly confirms returning them to the
 * issuer, which blocks proceeding in the meantime.
 */
export default function AssetDispositionCard({
  item,
  returnConfirmed,
  onToggleReturn,
}: AssetDispositionCardProps) {
  if (item.convertible) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
        <ArrowRightLeft className="h-4 w-4 shrink-0 text-emerald-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white">
            {item.code} <span className="text-white/40">→</span> XLM
          </p>
          <p className="text-xs text-white/50">
            {item.balance} {item.code} will be swapped to XLM on the DEX.
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-emerald-300">
          Swap
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-lg border p-3 transition-colors",
        returnConfirmed
          ? "border-white/15 bg-white/[0.03]"
          : "border-amber-500/30 bg-amber-500/[0.06]"
      )}
    >
      <div className="flex items-start gap-3">
        {returnConfirmed ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-white/50" />
        ) : (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white">
            {item.code} <span className="text-white/40">·</span>{" "}
            <span className="text-amber-300/90">no swap route on the DEX</span>
          </p>
          <p className="mt-1 text-xs leading-relaxed text-white/55">
            There is no way to swap your {item.balance} {item.code} to XLM. A trustline with a
            balance cannot be removed, so the account cannot be closed while this balance remains.
            To continue, you can return these tokens to the issuer, giving up the tokens.
          </p>
        </div>
      </div>

      <div className="mt-3 pl-7">
        <label className="flex cursor-pointer items-start gap-2 text-xs text-white/70">
          <input
            type="checkbox"
            checked={returnConfirmed}
            onChange={(e) => onToggleReturn(item.asset, e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-stellar"
          />
          <span>
            Return my {item.balance} {item.code} to the issuer.{" "}
            <span className="text-white/40">You give up these tokens.</span>
          </span>
        </label>
      </div>
    </div>
  );
}
