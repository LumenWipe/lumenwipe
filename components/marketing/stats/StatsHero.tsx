"use client";

import { useEffect, useRef, useState } from "react";
import { stroopsToXlm } from "@/lib/utils/amounts";
import type { FeedData } from "@/hooks/useFeed";

function useCountUp(target: number, duration = 1400): number {
  const [count, setCount] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);
  const prevTarget = useRef(0);

  useEffect(() => {
    if (target === prevTarget.current) return;
    const from = prevTarget.current;
    prevTarget.current = target;
    startRef.current = null;

    function step(ts: number) {
      if (startRef.current === null) startRef.current = ts;
      const p = Math.min((ts - startRef.current) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setCount(Math.round(from + (target - from) * eased));
      if (p < 1) rafRef.current = requestAnimationFrame(step);
    }

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration]);

  return count;
}

function Skeleton() {
  return <span className="inline-block h-10 w-28 animate-pulse rounded-lg bg-white/8" />;
}

interface StatCardProps {
  label: string;
  value: string | null;
  sub?: string;
  accent?: "stellar" | "value";
}

function StatCard({ label, value, sub, accent = "stellar" }: StatCardProps) {
  return (
    <div className="flex flex-col gap-1.5 rounded-2xl border border-white/8 bg-white/[0.025] px-6 py-5">
      <span className="mkt-mono text-[0.68rem] uppercase tracking-wider text-white/45">
        {label}
      </span>
      <div className="mkt-display text-4xl font-bold leading-none text-white sm:text-5xl">
        {value === null ? (
          <Skeleton />
        ) : (
          <span className={accent === "value" ? "text-value" : "text-white"}>{value}</span>
        )}
      </div>
      {sub && <span className="mkt-mono text-[0.7rem] text-white/40">{sub}</span>}
    </div>
  );
}

export default function StatsHero({ feed }: { feed: FeedData | null }) {
  const mainnetCount = feed?.totals.mainnet ?? 0;
  const testnetCount = feed?.totals.testnet ?? 0;
  const xlmStroops = feed?.totals.mainnetXlmStroops ?? "0";

  const closedCount = useCountUp(mainnetCount + testnetCount);
  const mainnetClosedCount = useCountUp(mainnetCount);

  const xlmNum = feed ? parseFloat(stroopsToXlm(xlmStroops || "0")) : 0;
  const xlmAnimated = useCountUp(Math.round(xlmNum));

  const avg =
    mainnetCount > 0 ? (parseFloat(stroopsToXlm(xlmStroops)) / mainnetCount).toFixed(1) : null;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatCard
        label="Accounts closed"
        value={feed ? closedCount.toLocaleString() : null}
        sub={feed ? `${mainnetClosedCount.toLocaleString()} on mainnet` : undefined}
      />
      <StatCard
        label="XLM recovered on mainnet"
        value={feed ? `${xlmAnimated.toLocaleString()} XLM` : null}
        sub="From reserves released on-chain"
        accent="value"
      />
      <StatCard
        label="Avg per mainnet close"
        value={feed ? (avg ? `${avg} XLM` : "-") : null}
        sub="Median reserve released per merge"
      />
    </div>
  );
}
