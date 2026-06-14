"use client";

import { ExternalLink } from "lucide-react";
import { stroopsToXlm } from "@/lib/utils/amounts";
import { SE_EXPLORER_BASE } from "@/config/networks";
import type { FeedData } from "@/hooks/useFeed";

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function fmtXlm(stroops: string): string {
  const n = parseFloat(stroopsToXlm(stroops));
  if (isNaN(n)) return "-";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 border-b border-white/5 px-4 py-3">
      <div className="h-3 w-14 animate-pulse rounded bg-white/8" />
      <div className="h-3 w-16 animate-pulse rounded bg-white/8" />
      <div className="ml-auto h-3 w-24 animate-pulse rounded bg-white/8" />
    </div>
  );
}

export default function RecentFeed({ feed }: { feed: FeedData | null }) {
  const items = feed?.recent.slice(0, 20) ?? [];

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-white/8 bg-white/[0.02]">
      {/* header */}
      <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-stellar mkt-pulse" />
          <span className="mkt-mono text-[0.68rem] uppercase tracking-wider text-white/55">
            Recent closes
          </span>
        </div>
        <span className="mkt-mono text-[0.62rem] text-white/30">mainnet · verified on-chain</span>
      </div>

      {/* column labels */}
      <div className="grid grid-cols-[90px_80px_1fr_28px] gap-x-2 border-b border-white/5 px-4 py-2">
        {["When", "XLM", "TX hash", ""].map((h) => (
          <span key={h} className="mkt-mono text-[0.6rem] uppercase tracking-wider text-white/25">
            {h}
          </span>
        ))}
      </div>

      {/* rows */}
      <div className="flex-1 overflow-y-auto" style={{ maxHeight: 400 }}>
        {!feed ? (
          Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)
        ) : items.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-sm text-white/30">
            No mainnet closes yet
          </div>
        ) : (
          items.map((r) => {
            const xlm = fmtXlm(r.xlmStroops);
            const hash = `${r.txHash.slice(0, 6)}…${r.txHash.slice(-4)}`;
            const link = `${SE_EXPLORER_BASE[r.network]}/tx/${r.txHash}`;
            const xlmNum = parseFloat(stroopsToXlm(r.xlmStroops));
            const isLarge = xlmNum >= 20;
            return (
              <div
                key={r.txHash}
                className="grid grid-cols-[90px_80px_1fr_28px] items-center gap-x-2 border-b border-white/[0.04] px-4 py-2.5 transition-colors hover:bg-white/[0.03]"
              >
                <span className="mkt-mono text-[0.68rem] text-white/40">
                  {timeAgo(r.timestamp)}
                </span>
                <span
                  className={`mkt-mono text-[0.78rem] font-medium tabular-nums ${
                    isLarge ? "text-value" : "text-white/85"
                  }`}
                >
                  {xlm}
                </span>
                <span className="mkt-mono text-[0.68rem] text-white/30">{hash}</span>
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Verify on stellar.expert"
                  className="flex items-center justify-center text-white/25 transition-colors hover:text-stellar"
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            );
          })
        )}
      </div>

      {/* footer */}
      {feed && items.length > 0 && (
        <div className="border-t border-white/5 px-4 py-2.5">
          <span className="mkt-mono text-[0.62rem] text-white/25">
            Showing last {items.length} closes · each row links to the Stellar blockchain
          </span>
        </div>
      )}
    </div>
  );
}
