"use client";

import { stroopsToXlm } from "@/lib/utils/amounts";
import { useStats } from "@/hooks/useStats";

const STALE_HINT = "Stats service unreachable - showing last known values";

function formatXlmCompact(stroops: string): string {
  const xlm = parseFloat(stroopsToXlm(stroops));
  if (isNaN(xlm) || xlm === 0) return "0";
  return xlm.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export default function NetworkStats() {
  const { stats, stale } = useStats();

  if (!stats) return null;

  const dotClass = stale ? "bg-warning" : "bg-value mkt-pulse";
  const xlmRecovered = formatXlmCompact(stats.mainnetXlmStroops);

  return (
    <>
      {/* Floating card (large screens) */}
      <div className="fixed bottom-4 right-4 z-40 hidden xl:block select-none">
        <div
          title={stale ? STALE_HINT : undefined}
          className="rounded-2xl border border-white/10 bg-[#0b0b12]/85 backdrop-blur-md px-4 py-3 shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
        >
          <div className="flex items-center gap-1.5 mb-2">
            <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
            <span className="mkt-eyebrow text-[0.6rem] text-white/40">
              {stale ? "Stats · stale" : "Live stats"}
            </span>
          </div>
          <div className="space-y-1 text-xs">
            <div className="flex items-baseline justify-between gap-6">
              <span className="text-white/45">Testnet closed</span>
              <span className="tabular-nums font-semibold text-stellar">
                {stats.testnet.toLocaleString()}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-6">
              <span className="text-white/45">Mainnet closed</span>
              <span className="tabular-nums font-semibold text-stellar">
                {stats.mainnet.toLocaleString()}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-6 border-t border-white/10 pt-1 mt-1">
              <span className="text-white/45">Recovered on mainnet</span>
              <span className="tabular-nums font-semibold text-value">{xlmRecovered} XLM</span>
            </div>
          </div>
        </div>
      </div>

      {/* Floating pill (small screens) */}
      <div className="fixed bottom-3 inset-x-0 z-40 flex justify-center px-4 xl:hidden select-none pointer-events-none">
        <div
          title={stale ? STALE_HINT : undefined}
          className="inline-flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 rounded-full border border-white/10 bg-[#0b0b12]/85 backdrop-blur-md px-4 py-1.5 text-[0.7rem] shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
          <span className="tabular-nums font-semibold text-stellar">
            {stats.testnet.toLocaleString()}
          </span>
          <span className="text-white/45">testnet</span>
          <span className="text-white/25">·</span>
          <span className="tabular-nums font-semibold text-stellar">
            {stats.mainnet.toLocaleString()}
          </span>
          <span className="text-white/45">mainnet</span>
          <span className="text-white/25">·</span>
          <span className="tabular-nums font-semibold text-value">{xlmRecovered} XLM</span>
          <span className="text-white/45">recovered on mainnet</span>
        </div>
      </div>
    </>
  );
}
