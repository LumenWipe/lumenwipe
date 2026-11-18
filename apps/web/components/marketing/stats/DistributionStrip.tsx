"use client";

import { formatNumber, TWO_DECIMALS } from "@/lib/i18n/format";
import { SITE_LOCALE } from "@/lib/i18n/locale";
import { STATS_PAGE } from "@/lib/i18n/messages/stats";
import { useState } from "react";
import { stroopsToXlm } from "@/lib/utils/amounts";
import { SE_EXPLORER_BASE } from "@/config/networks";
import type { FeedData, MergeRecord } from "@/hooks/useFeed";
import AxisLabels from "./AxisLabels";

const T = STATS_PAGE[SITE_LOCALE].strip;

const W = 900;
const H = 104;
const PAD_X = 12;
const PAD_Y = 12;
const TRACK_H = H - PAD_Y * 2;
const TRACK_W = W - PAD_X * 2;
const CENTER_Y = PAD_Y + TRACK_H / 2;
const AXIS_Y = H - 1;

// Log scale: 0.5 XLM → 200 XLM mapped to [0,1]
const LOG_MIN = Math.log(0.5);
const LOG_MAX = Math.log(200);

function xlmToX(xlm: number): number {
  const clamped = Math.max(0.5, Math.min(200, xlm));
  const t = (Math.log(clamped) - LOG_MIN) / (LOG_MAX - LOG_MIN);
  return PAD_X + t * TRACK_W;
}

function hashJitter(txHash: string): number {
  let h = 0;
  for (let i = 0; i < txHash.length; i++) {
    h = (Math.imul(37, h) + txHash.charCodeAt(i)) | 0;
  }
  return ((h >>> 0) / 0xffffffff) * 0.8 - 0.4; // -0.4 to +0.4
}

const AXIS_TICKS = [1, 2, 5, 10, 20, 50, 100];
const AXIS_LABELS = [
  ...AXIS_TICKS.map((v) => ({ label: String(v), x: xlmToX(v) })),
  { label: "XLM", x: W },
];

interface HoveredDot {
  record: MergeRecord;
  xlm: number;
  cx: number;
  cy: number;
}

export default function DistributionStrip({ feed }: { feed: FeedData | null }) {
  const [hovered, setHovered] = useState<HoveredDot | null>(null);

  const records = feed?.recent ?? [];

  return (
    <div className="overflow-hidden rounded-2xl border border-white/8 bg-white/[0.02]">
      <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
        <span className="mkt-mono text-caption uppercase tracking-wider text-fg-muted">
          {T.title}
        </span>
        <span className="mkt-mono text-caption text-fg-subtle">{T.hint}</span>
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height="auto"
          aria-label={T.label}
          style={{ display: "block" }}
        >
          <defs>
            <filter id="dot-glow" x="-150%" y="-150%" width="400%" height="400%">
              <feGaussianBlur stdDeviation="2.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* axis track */}
          <line
            x1={PAD_X}
            y1={CENTER_Y}
            x2={PAD_X + TRACK_W}
            y2={CENTER_Y}
            stroke="rgba(255,255,255,0.07)"
            strokeWidth="1"
          />

          {/* axis and tick marks */}
          <line
            x1={PAD_X}
            y1={AXIS_Y}
            x2={PAD_X + TRACK_W}
            y2={AXIS_Y}
            stroke="rgba(255,255,255,0.08)"
            strokeWidth="1"
          />
          {AXIS_TICKS.map((v) => {
            const x = xlmToX(v);
            return (
              <line
                key={v}
                data-axis-tick
                x1={x}
                y1={AXIS_Y - 6}
                x2={x}
                y2={AXIS_Y}
                stroke="rgba(255,255,255,0.15)"
                strokeWidth="1"
              />
            );
          })}

          {/* skeleton */}
          {!feed &&
            Array.from({ length: 24 }).map((_, i) => {
              const jitter = ((i * 137.5) % 0.8) - 0.4;
              const xFrac = Math.log(0.8 + i * 8) / LOG_MAX;
              return (
                <circle
                  key={i}
                  cx={PAD_X + Math.min(xFrac, 0.97) * TRACK_W}
                  cy={CENTER_Y + jitter * (TRACK_H / 3)}
                  r={4}
                  fill="rgba(255,255,255,0.05)"
                />
              );
            })}

          {/* data dots */}
          {records.map((r) => {
            const xlm = parseFloat(stroopsToXlm(r.xlmStroops)) || 0;
            if (xlm <= 0) return null;
            const cx = xlmToX(xlm);
            const jitter = hashJitter(r.txHash);
            const cy = CENTER_Y + jitter * (TRACK_H / 2.8);
            const isLarge = xlm >= 20;
            const color = isLarge ? "hsl(41,96%,56%)" : "hsl(196,100%,47%)";

            return (
              <circle
                key={r.txHash}
                cx={cx}
                cy={cy}
                r={isLarge ? 5 : 4}
                fill={color}
                fillOpacity={hovered?.record.txHash === r.txHash ? 1 : 0.55}
                filter="url(#dot-glow)"
                style={{ cursor: "pointer" }}
                onMouseEnter={() => setHovered({ record: r, xlm, cx, cy })}
                onMouseLeave={() => setHovered(null)}
              />
            );
          })}
        </svg>
        {feed && records.length === 0 && (
          <p className="mkt-mono absolute inset-0 flex items-center justify-center text-caption text-fg-subtle">
            {T.empty}
          </p>
        )}

        {/* tooltip */}
        {hovered && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full"
            style={{
              left: `${((hovered.cx - PAD_X) / TRACK_W) * 100}%`,
              top: `${(hovered.cy / H) * 100}%`,
              marginTop: -8,
            }}
          >
            <div className="flex flex-col gap-1 rounded-xl border border-white/15 bg-surface/95 px-3 py-2 shadow-xl backdrop-blur">
              <span className="mkt-mono text-label text-white">
                {formatNumber(SITE_LOCALE, hovered.xlm, TWO_DECIMALS)} XLM
              </span>
              <a
                href={`${SE_EXPLORER_BASE[hovered.record.network]}/tx/${hovered.record.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="pointer-events-auto mkt-mono text-caption text-accent hover:underline"
              >
                {hovered.record.txHash.slice(0, 12)}… ↗
              </a>
            </div>
          </div>
        )}
      </div>
      <AxisLabels labels={AXIS_LABELS} width={W} />
    </div>
  );
}
