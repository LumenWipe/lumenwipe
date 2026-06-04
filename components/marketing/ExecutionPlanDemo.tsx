"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";

type Step = {
  label: string;
  note: string;
  delta: number;
  tag?: string;
  final?: boolean;
};

const STEPS: Step[] = [
  { label: "Normalize signers", note: "1 extra key removed", delta: 0.5 },
  { label: "Clear data entries", note: "1 ManageData entry", delta: 0.5 },
  { label: "Cancel DEX offers", note: "2 open offers", delta: 1.0 },
  { label: "Exit Blend position", note: "repay + withdraw", delta: 3.84, tag: "Soroban" },
  { label: "Convert assets to XLM", note: "3 tokens routed", delta: 3.08 },
  { label: "Remove trustlines", note: "4 trustlines", delta: 2.0 },
  { label: "Account merge", note: "via mediator to CEX", delta: 1.0, final: true },
];

const TOTAL = STEPS.length;
const TARGET = STEPS.reduce((s, x) => s + x.delta, 0); // 11.92 XLM

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = () => setReduced(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

function useAnimatedNumber(target: number, reduced: boolean) {
  const [val, setVal] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    if (reduced) {
      fromRef.current = target;
      setVal(target);
      return;
    }
    const from = fromRef.current;
    const start = performance.now();
    const dur = 650;
    let raf = 0;
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      const cur = from + (target - from) * eased;
      fromRef.current = cur;
      setVal(cur);
      if (t < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [target, reduced]);
  return val;
}

export default function ExecutionPlanDemo() {
  const reduced = usePrefersReducedMotion();
  const [phase, setPhase] = useState(0); // number of completed steps

  useEffect(() => {
    if (reduced) {
      setPhase(TOTAL);
      return;
    }
    if (phase < TOTAL) {
      const id = setTimeout(() => setPhase((p) => p + 1), phase === 0 ? 850 : 1150);
      return () => clearTimeout(id);
    }
    const id = setTimeout(() => setPhase(0), 2800);
    return () => clearTimeout(id);
  }, [phase, reduced]);

  const completed = phase;
  const done = phase >= TOTAL;
  const recoveredTarget = STEPS.slice(0, completed).reduce((s, x) => s + x.delta, 0);
  const recovered = useAnimatedNumber(done ? TARGET : recoveredTarget, reduced);
  const pct = (completed / TOTAL) * 100;

  return (
    <div className="relative mkt-ticks mkt-panel rounded-2xl p-4 sm:p-5 shadow-2xl">
      {/* header */}
      <div className="flex items-center justify-between gap-3 pb-3.5 border-b border-white/8">
        <div className="flex items-center gap-2">
          <span className="mkt-eyebrow text-stellar/90">Execution plan</span>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-2.5 py-1">
          <span
            className={`h-1.5 w-1.5 rounded-full ${done ? "bg-value" : "bg-stellar mkt-pulse"}`}
          />
          <span className="mkt-mono text-[0.65rem] uppercase tracking-wider text-white/70">
            {done ? "complete" : "mainnet"}
          </span>
        </div>
      </div>

      {/* account line */}
      <div className="flex items-center gap-2 py-3 text-[0.7rem] mkt-mono text-white/55">
        <span className="text-white/80">GDEMO…X4F2</span>
        <svg width="22" height="8" viewBox="0 0 22 8" fill="none" aria-hidden="true">
          <path
            d="M0 4h19m0 0-3-3m3 3-3 3"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="rounded border border-value/30 bg-value/10 px-1.5 py-0.5 text-value">
          CEX deposit
        </span>
      </div>

      {/* steps */}
      <ol className="space-y-0.5">
        {STEPS.map((step, i) => {
          const isDone = i < completed;
          const isActive = i === completed && !done;
          return (
            <li
              key={step.label}
              className={`relative flex items-center gap-3 overflow-hidden rounded-lg px-2.5 py-2 transition-colors duration-300 ${
                isActive ? "bg-stellar/10" : ""
              }`}
            >
              {isActive && (
                <span className="pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-stellar/10 to-transparent mkt-sweep" />
              )}

              {/* status glyph */}
              <span className="relative z-10 flex h-5 w-5 shrink-0 items-center justify-center">
                {isDone ? (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-stellar/15 text-stellar">
                    <Check className="h-3 w-3" strokeWidth={3} />
                  </span>
                ) : isActive ? (
                  <span className="flex h-5 w-5 items-center justify-center">
                    <span className="h-2.5 w-2.5 rounded-full border-2 border-stellar border-t-transparent animate-spin" />
                  </span>
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-white/20" />
                )}
              </span>

              {/* label */}
              <span className="relative z-10 min-w-0 flex-1">
                <span
                  className={`block truncate text-[0.82rem] font-medium transition-colors ${
                    isDone || isActive ? "text-white" : "text-white/45"
                  }`}
                >
                  {step.label}
                  {step.tag && (
                    <span className="ml-2 align-middle rounded border border-stellar/30 bg-stellar/10 px-1 py-px text-[0.6rem] mkt-mono uppercase tracking-wide text-stellar/90">
                      {step.tag}
                    </span>
                  )}
                </span>
                <span className="block truncate text-[0.68rem] mkt-mono text-white/35">
                  {step.note}
                </span>
              </span>

              {/* delta */}
              <span
                className={`relative z-10 shrink-0 mkt-mono text-[0.72rem] tabular-nums transition-colors ${
                  isDone ? "text-value" : "text-white/25"
                }`}
              >
                +{step.delta.toFixed(2)}
              </span>
            </li>
          );
        })}
      </ol>

      {/* footer meter */}
      <div className="mt-3.5 rounded-xl border border-white/8 bg-black/30 p-3.5">
        <div className="flex items-center justify-between">
          <span className="mkt-eyebrow text-white/45">Recovered</span>
          <span className="mkt-mono text-[0.65rem] text-white/40 tabular-nums">
            {completed}/{TOTAL} steps
          </span>
        </div>
        <div className="mt-1 flex items-baseline gap-1.5">
          <span
            className={`mkt-display text-2xl font-bold tabular-nums transition-colors ${
              done ? "text-value" : "text-white"
            }`}
          >
            {recovered.toFixed(2)}
          </span>
          <span className="mkt-mono text-xs text-white/50">XLM</span>
        </div>
        <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-white/8">
          <div
            className="h-full rounded-full bg-gradient-to-r from-stellar to-value transition-[width] duration-700 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-2 text-[0.68rem] text-white/40">
          {done ? (
            <span className="text-value/90">Account closed and removed from the ledger.</span>
          ) : (
            <>5.00 XLM in locked reserves unlocked, then balance swept and merged.</>
          )}
        </p>
      </div>
    </div>
  );
}
