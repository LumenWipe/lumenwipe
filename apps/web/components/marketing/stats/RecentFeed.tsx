"use client";

import { formatNumber, TWO_DECIMALS } from "@/lib/i18n/format";
import { SITE_LOCALE } from "@/lib/i18n/locale";
import { STATS_PAGE } from "@/lib/i18n/messages/stats";
import { ExternalLink } from "lucide-react";
import { stroopsToXlm } from "@/lib/utils/amounts";
import { SE_EXPLORER_BASE } from "@/config/networks";
import type { FeedData } from "@/hooks/useFeed";
import { useNow } from "@/hooks/useNow";

const T = STATS_PAGE[SITE_LOCALE].feed;

function timeAgo(timestamp: string, now: number): string {
  const diff = now - new Date(timestamp).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return T.ago.seconds(s);
  const m = Math.floor(s / 60);
  if (m < 60) return T.ago.minutes(m);
  const h = Math.floor(m / 60);
  if (h < 24) return T.ago.hours(h);
  const d = Math.floor(h / 24);
  return T.ago.days(d);
}

function fmtXlm(stroops: string): string {
  const n = parseFloat(stroopsToXlm(stroops));
  if (isNaN(n)) return "-";
  return formatNumber(SITE_LOCALE, n, TWO_DECIMALS);
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
  const now = useNow(feed);
  const items = feed?.recent.slice(0, 20) ?? [];

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-white/8 bg-white/[0.02]">
      {/* header */}
      <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-accent mkt-pulse" />
          <span className="mkt-mono text-caption uppercase tracking-wider text-fg-muted">
            {T.title}
          </span>
        </div>
        <span className="mkt-mono text-caption text-fg-subtle">{T.sub}</span>
      </div>

      {/* column labels */}
      <div className="grid grid-cols-[90px_80px_1fr_28px] gap-x-2 border-b border-white/5 px-4 py-2">
        {[T.columns.when, T.columns.xlm, T.columns.hash, ""].map((h) => (
          <span key={h} className="mkt-mono text-caption uppercase tracking-wider text-fg-subtle">
            {h}
          </span>
        ))}
      </div>

      {/* rows */}
      <div className="flex-1 overflow-y-auto" style={{ maxHeight: 400 }}>
        {!feed ? (
          Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)
        ) : items.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-sm text-fg-subtle">
            {T.empty}
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
                <span className="mkt-mono text-caption text-fg-subtle">
                  {now === null ? "" : timeAgo(r.timestamp, now)}
                </span>
                <span
                  className={`mkt-mono text-label leading-normal font-medium tabular-nums ${
                    isLarge ? "text-value" : "text-white/85"
                  }`}
                >
                  {xlm}
                </span>
                <span className="mkt-mono text-caption text-fg-subtle">{hash}</span>
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={T.verify}
                  className="flex items-center justify-center text-fg-subtle transition-colors hover:text-accent"
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
          <span className="mkt-mono text-caption text-fg-subtle">{T.showing(items.length)}</span>
        </div>
      )}
    </div>
  );
}
