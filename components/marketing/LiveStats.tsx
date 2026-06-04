"use client";

import { useEffect, useState } from "react";
import { stroopsToXlm } from "@/lib/utils/amounts";

interface Stats {
  testnet: number;
  mainnet: number;
  testnetXlmStroops: string;
  mainnetXlmStroops: string;
}

function fmtXlm(stroops: string): string {
  const xlm = parseFloat(stroopsToXlm(stroops));
  if (isNaN(xlm) || xlm === 0) return "0";
  return xlm.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/**
 * Live traction band. Renders nothing until the stats endpoint returns
 * meaningful numbers, so the page never shows empty/zero counters.
 */
export default function LiveStats() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/stats")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (active) setStats(d);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const closed = stats ? stats.mainnet + stats.testnet : 0;
  const recovered = stats ? parseFloat(stroopsToXlm(stats.mainnetXlmStroops)) : 0;

  if (!stats || (closed === 0 && recovered === 0)) return null;

  return (
    <div className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 mkt-mono text-[0.72rem] text-white/60">
      <span className="h-1.5 w-1.5 rounded-full bg-value mkt-pulse" />
      <span className="tabular-nums text-white">{closed.toLocaleString()}</span>
      <span className="text-white/45">accounts closed</span>
      {recovered > 0 && (
        <>
          <span className="text-white/25">·</span>
          <span className="tabular-nums text-value">{fmtXlm(stats.mainnetXlmStroops)} XLM</span>
          <span className="text-white/45">recovered</span>
        </>
      )}
    </div>
  );
}
