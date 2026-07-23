"use client";

import { stroopsToXlm } from "@/lib/utils/amounts";
import { useStats } from "@/hooks/useStats";

function fmtXlm(stroops: string): string {
  const xlm = parseFloat(stroopsToXlm(stroops));
  if (isNaN(xlm) || xlm === 0) return "0";
  return xlm.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/**
 * Live traction band. Always renders the full structure so layout space is
 * reserved from the first paint - visibility:hidden avoids the CLS that
 * return null would cause when the stats fetch resolves.
 */
export default function LiveStats() {
  const { stats } = useStats();

  const closed = stats ? stats.mainnet + stats.testnet : 0;
  const xlmStr = stats ? fmtXlm(stats.mainnetXlmStroops) : "0";
  const hasData = !!stats && (closed > 0 || xlmStr !== "0");

  return (
    <div
      className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 mkt-mono text-[0.72rem] text-white/65"
      style={{ visibility: hasData ? "visible" : "hidden" }}
      aria-hidden={!hasData}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-value mkt-pulse" />
      <span className="tabular-nums text-white">{closed.toLocaleString()}</span>
      <span className="text-white/65">accounts closed</span>
      <span className="text-white/25">·</span>
      <span className="tabular-nums text-value">{xlmStr} XLM</span>
      <span className="text-white/65">recovered on mainnet</span>
    </div>
  );
}
