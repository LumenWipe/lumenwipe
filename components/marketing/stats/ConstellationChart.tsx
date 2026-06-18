"use client";

import { useState } from "react";
import { stroopsToXlm } from "@/lib/utils/amounts";
import { SE_EXPLORER_BASE } from "@/config/networks";
import type { FeedData, MergeRecord } from "@/hooks/useFeed";

const W = 900;
const H = 200;
const PAD_X = 16;
const PAD_TOP = 18;
const PAD_BOTTOM = 36;
const CHART_H = H - PAD_TOP - PAD_BOTTOM; // 146px
const CHART_W = W - PAD_X * 2;
const DAYS_SHOWN = 60;

// Deterministic Y jitter from txHash so server and client agree.
function hashJitter(txHash: string): number {
  let h = 0;
  for (let i = 0; i < txHash.length; i++) {
    h = (Math.imul(31, h) + txHash.charCodeAt(i)) | 0;
  }
  return ((h >>> 0) / 0xffffffff) * 0.7 + 0.15; // 0.15 – 0.85
}

function xlmFromStroops(stroops: string): number {
  return parseFloat(stroopsToXlm(stroops)) || 0;
}

function xlmToRadius(xlm: number): number {
  return Math.max(3, Math.min(16, 3 + Math.sqrt(xlm) * 1.1));
}

function xlmToColor(xlm: number): string {
  if (xlm <= 5) return "hsl(196,100%,47%)";
  if (xlm >= 40) return "hsl(41,96%,56%)";
  const t = (xlm - 5) / 35;
  const h = Math.round(196 + (41 - 196) * t);
  const s = Math.round(100 - (100 - 96) * t);
  const l = Math.round(47 + (56 - 47) * t);
  return `hsl(${h},${s}%,${l}%)`;
}

function tsToX(ts: string, start: number, end: number): number {
  const t = new Date(ts).getTime();
  const clamped = Math.max(start, Math.min(end, t));
  return PAD_X + ((clamped - start) / (end - start)) * CHART_W;
}

function buildAxisLabels(start: number, end: number): { label: string; x: number }[] {
  const labels: { label: string; x: number }[] = [];
  const cursor = new Date(start);
  cursor.setUTCHours(0, 0, 0, 0);
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  while (cursor.getTime() <= end) {
    if (cursor.getUTCDate() === 1) {
      labels.push({
        label: months[cursor.getUTCMonth()],
        x: tsToX(cursor.toISOString(), start, end),
      });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return labels;
}

interface Tooltip {
  x: number;
  y: number;
  record: MergeRecord;
  xlm: number;
}

export default function ConstellationChart({ feed }: { feed: FeedData | null }) {
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  const now = Date.now();
  const windowStart = now - DAYS_SHOWN * 86_400_000;

  const records = (feed?.recent ?? []).filter(
    (r) => new Date(r.timestamp).getTime() >= windowStart
  );

  const axisLabels = buildAxisLabels(windowStart, now);

  // Grid lines: every ~10 days
  const gridLines: number[] = [];
  for (let i = 0; i <= DAYS_SHOWN; i += 10) {
    gridLines.push(PAD_X + (i / DAYS_SHOWN) * CHART_W);
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/8 bg-white/[0.02]">
      {/* header */}
      <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
        <span className="mkt-mono text-[0.68rem] uppercase tracking-wider text-white/55">
          Each close · last {DAYS_SHOWN} days
        </span>
        <span className="mkt-mono text-[0.62rem] text-white/25">
          size = XLM recovered · gold = large close
        </span>
      </div>

      {/* chart */}
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height="auto"
          aria-label="Constellation of account closes over time"
          style={{ display: "block" }}
        >
          <defs>
            <filter id="star-glow" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="star-glow-lg" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* grid lines */}
          {gridLines.map((x) => (
            <line
              key={x}
              x1={x}
              y1={PAD_TOP}
              x2={x}
              y2={PAD_TOP + CHART_H}
              stroke="rgba(255,255,255,0.04)"
              strokeWidth="1"
            />
          ))}

          {/* horizontal center line */}
          <line
            x1={PAD_X}
            y1={PAD_TOP + CHART_H / 2}
            x2={PAD_X + CHART_W}
            y2={PAD_TOP + CHART_H / 2}
            stroke="rgba(255,255,255,0.03)"
            strokeWidth="1"
            strokeDasharray="4 6"
          />

          {/* empty state */}
          {feed && records.length === 0 && (
            <text
              x={W / 2}
              y={H / 2}
              textAnchor="middle"
              dominantBaseline="middle"
              fill="rgba(255,255,255,0.2)"
              fontSize="12"
              fontFamily="monospace"
            >
              No mainnet closes in this window yet
            </text>
          )}

          {/* skeleton shimmer dots when loading */}
          {!feed &&
            Array.from({ length: 18 }).map((_, i) => {
              const jitter = ((i * 137.5) % 1) * 0.7 + 0.15;
              const xFrac = (i * 0.057 + 0.02) % 0.96;
              return (
                <circle
                  key={i}
                  cx={PAD_X + xFrac * CHART_W}
                  cy={PAD_TOP + jitter * CHART_H}
                  r={3 + (i % 4)}
                  fill="rgba(255,255,255,0.04)"
                />
              );
            })}

          {/* data points */}
          {records.map((r) => {
            const xlm = xlmFromStroops(r.xlmStroops);
            const cx = tsToX(r.timestamp, windowStart, now);
            const jitter = hashJitter(r.txHash);
            const cy = PAD_TOP + jitter * CHART_H;
            const rad = xlmToRadius(xlm);
            const color = xlmToColor(xlm);
            const isLarge = xlm >= 20;
            return (
              <circle
                key={r.txHash}
                cx={cx}
                cy={cy}
                r={rad}
                fill={color}
                fillOpacity={0.75 + Math.min(xlm / 80, 0.25)}
                filter={isLarge ? "url(#star-glow-lg)" : "url(#star-glow)"}
                style={{ cursor: "pointer" }}
                onMouseEnter={(e) => {
                  const svgEl = (e.target as SVGCircleElement).closest("svg")!;
                  const rect = svgEl.getBoundingClientRect();
                  const scaleX = rect.width / W;
                  const scaleY = rect.height / H;
                  setTooltip({
                    x: cx * scaleX + rect.left - rect.left,
                    y: cy * scaleY,
                    record: r,
                    xlm,
                  });
                }}
                onMouseLeave={() => setTooltip(null)}
              />
            );
          })}

          {/* x-axis */}
          <line
            x1={PAD_X}
            y1={PAD_TOP + CHART_H + 8}
            x2={PAD_X + CHART_W}
            y2={PAD_TOP + CHART_H + 8}
            stroke="rgba(255,255,255,0.08)"
            strokeWidth="1"
          />
          {axisLabels.map((l) => (
            <text
              key={l.label + l.x}
              x={l.x}
              y={PAD_TOP + CHART_H + 22}
              textAnchor="middle"
              fill="rgba(255,255,255,0.3)"
              fontSize="9"
              fontFamily="monospace"
            >
              {l.label}
            </text>
          ))}
        </svg>

        {/* tooltip - positioned relative to chart container */}
        {tooltip && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full"
            style={{
              left: `${(tooltip.x / CHART_W) * 100}%`,
              top: `${tooltip.y}px`,
              marginTop: -8,
            }}
          >
            <div className="flex flex-col gap-1 rounded-xl border border-white/15 bg-[hsl(var(--card)/0.95)] px-3 py-2 shadow-xl backdrop-blur">
              <span className="mkt-mono text-[0.75rem] font-medium text-white">
                {tooltip.xlm.toLocaleString("en-US", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}{" "}
                XLM
              </span>
              <a
                href={`${SE_EXPLORER_BASE[tooltip.record.network]}/tx/${tooltip.record.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="pointer-events-auto mkt-mono text-[0.65rem] text-stellar hover:underline"
              >
                {tooltip.record.txHash.slice(0, 12)}… ↗
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
