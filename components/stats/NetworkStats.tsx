"use client";

import { useEffect, useState } from "react";
import { stroopsToXlm } from "@/lib/utils/amounts";

interface Stats {
  testnet: number;
  mainnet: number;
  testnetXlmStroops: string;
  mainnetXlmStroops: string;
}

const NETWORKS: { key: keyof Pick<Stats, "testnet" | "mainnet">; label: string }[] = [
  { key: "testnet", label: "Testnet" },
  { key: "mainnet", label: "Mainnet" },
];

function formatXlmCompact(stroops: string): string {
  const xlm = parseFloat(stroopsToXlm(stroops));
  if (isNaN(xlm) || xlm === 0) return "0 XLM";
  return `${xlm.toLocaleString("en-US", { maximumFractionDigits: 2 })} XLM`;
}

export default function NetworkStats() {
  const [stats, setStats] = useState<Stats | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/stats");
      if (res.ok) setStats(await res.json());
    } catch {
      // non-critical - silently ignore
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  const totalStroops = stats ? stats.mainnetXlmStroops : null;

  return (
    <div className="space-y-3 mb-10">
      <div className="grid grid-cols-2 gap-3">
        {NETWORKS.map(({ key, label }) => {
          const count = stats?.[key];
          return (
            <div key={key} className="mkt-panel rounded-xl p-4 text-center">
              <p className="mkt-eyebrow text-white/40 mb-2">{label}</p>
              <p className="mkt-display text-3xl font-bold text-stellar tabular-nums">
                {count === undefined ? (
                  <span className="inline-block w-8 h-7 bg-border rounded animate-pulse" />
                ) : (
                  count.toLocaleString()
                )}
              </p>
              <p className="text-xs text-white/45 mt-1">accounts closed</p>
            </div>
          );
        })}
      </div>

      <div className="mkt-panel rounded-xl p-4 text-center">
        <p className="mkt-eyebrow text-white/40 mb-2">Total Recovered</p>
        <p className="mkt-display text-3xl font-bold text-value tabular-nums">
          {totalStroops === null ? (
            <span className="inline-block w-24 h-7 bg-border rounded animate-pulse" />
          ) : (
            formatXlmCompact(totalStroops)
          )}
        </p>
        <p className="text-xs text-white/45 mt-1">recovered on mainnet</p>
      </div>
    </div>
  );
}
