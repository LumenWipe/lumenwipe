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
    const tick = () => {
      step = step >= ROWS.length ? 0 : step + 1;
      setActive(step);
      timer.current = setTimeout(tick, step === 0 ? 1400 : step >= ROWS.length ? 1800 : 780);
    };
    timer.current = setTimeout(tick, 900);
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
          {ROWS.map((r, i) => {
            const done = i < active;
            const running = i === active && scanning;
            return (
              <div
                key={r.n}
                className={`flex items-center gap-3 py-2.5 text-[0.85rem] transition-colors duration-300 ${
                  running
                    ? "-mx-4 border-l-2 border-stellar bg-white/[0.04] px-4 text-white"
                    : "border-t border-white/[0.05] text-white/85 first:border-t-0"
                }`}
              >
                <span className="mkt-mono w-5 text-[0.72rem] text-white/40">{r.n}</span>
                <span>{r.label}</span>
                {done && <Check className="h-3.5 w-3.5 text-stellar" />}
                {running ? (
                  <span className="ml-auto h-1 w-16 overflow-hidden rounded-full bg-white/10">
                    <span className="mkt-sweep block h-full w-1/2 rounded-full bg-stellar" />
                  </span>
                ) : (
                  <span
                    className={`mkt-mono ml-auto tabular-nums transition-colors ${
                      done ? "text-white/60" : "text-white/30"
                    }`}
                  >
                    {r.amount > 0 ? `+${r.amount.toFixed(2)}` : "—"}
                  </span>
                )}
              </div>
            );
          })}
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
