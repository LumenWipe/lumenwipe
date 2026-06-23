"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";

type Row = { n: string; label: string; amount: number };

// Reserve released per step (step 04 is the swap, it frees no reserve itself).
const ROWS: Row[] = [
  { n: "01", label: "Normalize signers", amount: 0.5 },
  { n: "02", label: "Clear data entries", amount: 0.5 },
  { n: "03", label: "Cancel open offers", amount: 1.0 },
  { n: "04", label: "Convert assets to XLM", amount: 0 },
  { n: "05", label: "Remove trustlines", amount: 2.0 },
  { n: "06", label: "Merge to destination", amount: 1.0 },
];

const TOTAL = ROWS.reduce((s, r) => s + r.amount, 0);

// Row height in px. MUST match the `h-11` on each row so the sliding highlight lines up.
const ROW_HEIGHT_PX = 44;

// Scan cadence in ms - tuned for a calm read (~8.5s per loop).
const TIMING = {
  startDelay: 800, // before the first step lights up
  perStep: 850, // how long each step stays active
  completeHold: 1600, // pause on the finished state before resetting
  resetHold: 1000, // pause back at step 1 before re-scanning
} as const;

/**
 * Animated scan console for the hero: steps complete one by one, the active
 * row sweeps, and the recoverable reserve counts up. Loops gently. Honors
 * prefers-reduced-motion by rendering the finished state statically.
 */
export default function HeroConsole() {
  const [active, setActive] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setActive(ROWS.length);
      return;
    }
    let step = 0;
    const at = (fn: () => void, ms: number) => {
      timer.current = setTimeout(fn, ms);
    };
    const advance = () => {
      if (step >= ROWS.length) {
        step = 0;
        setActive(0);
        at(advance, TIMING.resetHold);
        return;
      }
      step += 1;
      setActive(step);
      at(advance, step >= ROWS.length ? TIMING.completeHold : TIMING.perStep);
    };
    at(advance, TIMING.startDelay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const recovered = ROWS.slice(0, active).reduce((s, r) => s + r.amount, 0);
  const pct = Math.round((active / ROWS.length) * 100);
  const scanning = active < ROWS.length;

  return (
    <div className="mkt-card mx-auto max-w-4xl overflow-hidden text-left">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3.5 mkt-mono text-[0.7rem] uppercase tracking-wider text-white/45">
        <span>account · GABC…WXYZ</span>
        <span className="inline-flex items-center gap-2 text-stellar">
          <span className="h-1.5 w-1.5 rounded-full bg-stellar mkt-pulse" />
          {scanning ? "scanning" : "complete"}
        </span>
      </div>
      <div className="grid sm:grid-cols-[1.4fr_1fr]">
        <div className="p-4 sm:border-r sm:border-white/[0.06]">
          <div className="relative">
            {/* single highlight that glides between rows */}
            {scanning && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 h-11 rounded-r-md border-l-2 border-l-[hsl(var(--stellar))] bg-white/[0.04] transition-transform duration-300 ease-out"
                style={{ transform: `translateY(${active * ROW_HEIGHT_PX}px)` }}
              />
            )}
            {ROWS.map((r, i) => {
              const done = i < active;
              const running = i === active && scanning;
              return (
                <div
                  key={r.n}
                  className={`relative z-10 flex h-11 items-center gap-3 border-t border-t-white/[0.06] px-3 text-[0.85rem] transition-colors duration-500 first:border-t-0 ${
                    running || done ? "text-white" : "text-white/70"
                  }`}
                >
                  <span className="mkt-mono w-5 text-[0.72rem] text-white/40">{r.n}</span>
                  <span>{r.label}</span>
                  {done && <Check className="h-3.5 w-3.5 text-stellar" />}
                  <span
                    className={`mkt-mono ml-auto tabular-nums transition-colors duration-500 ${
                      done ? "text-white/60" : "text-white/30"
                    }`}
                  >
                    {r.amount > 0 ? `+${r.amount.toFixed(2)}` : "-"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="flex flex-col justify-center p-5">
          <span className="mkt-mono text-[0.62rem] uppercase tracking-wider text-white/45">
            Recoverable reserve
          </span>
          <div className="mkt-display mt-2 text-4xl font-extrabold text-value tabular-nums">
            {recovered.toFixed(2)} <span className="text-lg font-normal text-white/45">XLM</span>
          </div>
          <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <span
              className="block h-full rounded-full bg-stellar transition-[width] duration-500 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-3 text-[0.74rem] text-white/45">
            {active} of {ROWS.length} steps · {TOTAL.toFixed(2)} XLM total · 0 servers can move
            funds
          </p>
        </div>
      </div>
    </div>
  );
}
