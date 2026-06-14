"use client";

import { useState } from "react";
import type { FeedData, DailyActivity, MergeRecord } from "@/hooks/useFeed";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Mon", "Wed", "Fri"];

function countToLevel(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count === 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 6) return 3;
  return 4;
}

const LEVEL_CLASS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: "bg-white/[0.04]",
  1: "bg-stellar/[0.22]",
  2: "bg-stellar/40",
  3: "bg-stellar/65",
  4: "bg-stellar",
};

interface Cell {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}

function buildGrid(daily: DailyActivity[]): Cell[][] {
  if (!daily.length) return [];

  const byDate = new Map<string, number>(daily.map((d) => [d.date, d.count]));

  // Start from Monday of the week 364 days ago
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayMs = today.getTime();

  const start = new Date(todayMs - 363 * 86_400_000);
  // Roll back to Monday (dow 0=Sun,1=Mon...6=Sat → we want Mon=0)
  const startDow = (start.getUTCDay() + 6) % 7; // 0=Mon
  start.setUTCDate(start.getUTCDate() - startDow);

  const weeks: Cell[][] = [];
  const cursor = new Date(start);

  while (cursor.getTime() <= todayMs + 6 * 86_400_000) {
    const week: Cell[] = [];
    for (let d = 0; d < 7; d++) {
      const iso = cursor.toISOString().slice(0, 10);
      const count = cursor.getTime() > todayMs ? -1 : (byDate.get(iso) ?? 0);
      week.push({
        date: iso,
        count: count < 0 ? 0 : count,
        level: count < 0 ? 0 : countToLevel(count),
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push(week);
  }

  return weeks;
}

function getMonthLabels(weeks: Cell[][]): { label: string; col: number }[] {
  const labels: { label: string; col: number }[] = [];
  let lastMonth = -1;
  weeks.forEach((week, col) => {
    const month = new Date(week[0].date).getUTCMonth();
    if (month !== lastMonth) {
      labels.push({ label: MONTHS[month], col });
      lastMonth = month;
    }
  });
  return labels;
}

interface HoveredCell {
  date: string;
  count: number;
  closes: MergeRecord[];
  col: number;
  row: number;
}

export default function CalendarHeatmap({ feed }: { feed: FeedData | null }) {
  const [hovered, setHovered] = useState<HoveredCell | null>(null);

  const daily = feed?.daily ?? [];
  const weeks = buildGrid(daily);
  const monthLabels = getMonthLabels(weeks);

  const closesByDate = new Map<string, MergeRecord[]>();
  feed?.recent.forEach((r) => {
    const date = r.timestamp.slice(0, 10);
    if (!closesByDate.has(date)) closesByDate.set(date, []);
    closesByDate.get(date)!.push(r);
  });

  const totalDays = daily.filter((d) => d.count > 0).length;
  const maxStreak = (() => {
    let streak = 0;
    let best = 0;
    for (const d of daily) {
      if (d.count > 0) {
        streak++;
        best = Math.max(best, streak);
      } else {
        streak = 0;
      }
    }
    return best;
  })();

  return (
    <div className="overflow-hidden rounded-2xl border border-white/8 bg-white/[0.02]">
      <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
        <span className="mkt-mono text-[0.68rem] uppercase tracking-wider text-white/55">
          Activity - last 12 months
        </span>
        <div className="flex items-center gap-4">
          {feed && (
            <>
              <span className="mkt-mono text-[0.62rem] text-white/30">{totalDays} active days</span>
              {maxStreak > 1 && (
                <span className="mkt-mono text-[0.62rem] text-white/30">
                  {maxStreak}-day streak
                </span>
              )}
            </>
          )}
          <div className="flex items-center gap-1">
            <span className="mkt-mono text-[0.58rem] text-white/25">Less</span>
            {([0, 1, 2, 3, 4] as const).map((l) => (
              <div key={l} className={`h-2.5 w-2.5 rounded-[2px] ${LEVEL_CLASS[l]}`} />
            ))}
            <span className="mkt-mono text-[0.58rem] text-white/25">More</span>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto px-4 pb-4 pt-2">
        <div className="relative" style={{ minWidth: weeks.length * 14 + 24 }}>
          {/* month labels */}
          <div className="mb-1 flex" style={{ paddingLeft: 24 }}>
            {monthLabels.map((m) => (
              <div
                key={m.label + m.col}
                className="mkt-mono text-[0.6rem] text-white/30"
                style={{ position: "absolute", left: 24 + m.col * 14 }}
              >
                {m.label}
              </div>
            ))}
          </div>

          <div className="mt-4 flex gap-0">
            {/* day labels */}
            <div className="mr-1.5 flex flex-col gap-[2px] pt-[1px]">
              {Array.from({ length: 7 }).map((_, i) => (
                <div
                  key={i}
                  className="mkt-mono text-[0.55rem] text-white/20"
                  style={{ height: 12, lineHeight: "12px" }}
                >
                  {i === 0 ? "Mon" : i === 2 ? "Wed" : i === 4 ? "Fri" : ""}
                </div>
              ))}
            </div>

            {/* grid */}
            <div className="flex gap-[2px]">
              {weeks.length === 0
                ? Array.from({ length: 53 }).map((_, wi) => (
                    <div key={wi} className="flex flex-col gap-[2px]">
                      {Array.from({ length: 7 }).map((_, di) => (
                        <div
                          key={di}
                          className="h-[12px] w-[12px] animate-pulse rounded-[2px] bg-white/[0.04]"
                        />
                      ))}
                    </div>
                  ))
                : weeks.map((week, wi) => (
                    <div key={wi} className="flex flex-col gap-[2px]">
                      {week.map((cell, di) => (
                        <div
                          key={cell.date}
                          className={`relative h-[12px] w-[12px] cursor-default rounded-[2px] transition-all duration-150 ${LEVEL_CLASS[cell.level]} ${
                            hovered?.date === cell.date
                              ? "ring-1 ring-stellar/70 ring-offset-[1px] ring-offset-transparent"
                              : ""
                          }`}
                          onMouseEnter={() =>
                            setHovered({
                              date: cell.date,
                              count: cell.count,
                              closes: closesByDate.get(cell.date) ?? [],
                              col: wi,
                              row: di,
                            })
                          }
                          onMouseLeave={() => setHovered(null)}
                        />
                      ))}
                    </div>
                  ))}
            </div>
          </div>
        </div>
      </div>

      {/* tooltip / detail panel */}
      {hovered && (
        <div className="border-t border-white/5 px-4 py-3">
          <div className="flex items-start gap-4">
            <div>
              <span className="mkt-mono text-[0.68rem] text-white/45">
                {new Date(hovered.date + "T00:00:00Z").toLocaleDateString("en-US", {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                  timeZone: "UTC",
                })}
              </span>
              <p className="mt-0.5 mkt-mono text-[0.72rem] text-white/75">
                {hovered.count === 0
                  ? "No closes"
                  : `${hovered.count} account${hovered.count !== 1 ? "s" : ""} closed`}
              </p>
            </div>
            {hovered.closes.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {hovered.closes.slice(0, 5).map((r) => (
                  <a
                    key={r.txHash}
                    href={`https://stellar.expert/explorer/public/tx/${r.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mkt-mono rounded-md border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[0.62rem] text-white/40 transition-colors hover:border-stellar/40 hover:text-stellar"
                  >
                    {r.txHash.slice(0, 8)}… ↗
                  </a>
                ))}
                {hovered.closes.length > 5 && (
                  <span className="mkt-mono text-[0.62rem] text-white/25">
                    +{hovered.closes.length - 5} more
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {DAYS.length === 0 && null}
    </div>
  );
}
