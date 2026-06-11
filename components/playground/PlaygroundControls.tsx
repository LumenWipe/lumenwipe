"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Bomb,
  FlaskConical,
  Loader2,
  RotateCcw,
  ShieldCheck,
  TimerReset,
} from "lucide-react";
import { usePlaygroundStore } from "@/store/playground";

function CountdownBadge({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");
  return (
    <span className="flex items-center gap-1 mkt-mono text-[10px] text-white/40">
      <TimerReset className="h-3 w-3" />
      session {mm}:{ss}
    </span>
  );
}

export default function PlaygroundControls({
  start,
  demolish,
  progressStatus,
}: {
  start: () => void;
  demolish: () => void;
  progressStatus: string | null;
}) {
  const phase = usePlaygroundStore((s) => s.phase);
  const expiresAt = usePlaygroundStore((s) => s.expiresAt);
  const lastError = usePlaygroundStore((s) => s.lastError);
  const accountState = usePlaygroundStore((s) => s.accountState);
  const executionPlan = usePlaygroundStore((s) => s.executionPlan);
  const recoveredXlm = usePlaygroundStore((s) => s.recoveredXlm);

  const busy = phase === "CREATING_ACCOUNT" || phase === "MESSING" || phase === "DEMOLISHING";
  const lockedReserve = accountState ? 1 + accountState.numSubEntries * 0.5 : 0;
  const hasProgress = executionPlan.some((s) => s.status === "confirmed");

  const primaryButton =
    "flex w-full items-center justify-center gap-2 rounded-md px-4 py-3 font-display text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="mkt-panel mkt-ticks relative rounded-lg p-5">
      <div className="mb-4 flex items-center justify-between">
        <p className="mkt-eyebrow text-white/50">Control panel</p>
        {expiresAt && phase !== "IDLE" && phase !== "COMPLETE" && (
          <CountdownBadge expiresAt={expiresAt} />
        )}
      </div>

      {phase === "IDLE" && (
        <>
          <p className="mb-4 text-sm leading-relaxed text-white/60">
            One click creates a real testnet account and buries it in junk: scam-token trustlines,
            stale DEX offers, leftover data entries, a forgotten co-signer. Then you demolish it all
            with the same engine the real app uses.
          </p>
          <div className="mb-4 flex items-start gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2.5 text-xs text-white/45">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stellar/60" />
            <span>
              This sandbox is the <em>only</em> custodial part of LumenWipe - we create a throwaway
              testnet account so you can explore the full flow without a wallet. The real app is
              entirely non-custodial and decentralized: your keys never leave your device and we
              will never hold them.
            </span>
          </div>
          <button
            className={`${primaryButton} bg-stellar text-black hover:opacity-90`}
            onClick={start}
          >
            <FlaskConical className="h-4 w-4" />
            Create & trash a demo account
          </button>
        </>
      )}

      {busy && (
        <div className="flex items-center gap-3 rounded-md border border-white/10 bg-white/[0.03] px-4 py-3">
          <Loader2 className="h-4 w-4 animate-spin text-stellar" />
          <span className="text-sm text-white/70">{progressStatus ?? "Working..."}</span>
        </div>
      )}

      {phase === "DIRTY" && (
        <>
          <div className="mb-4 rounded-md border border-value/30 bg-[hsl(var(--value)/0.07)] px-4 py-3 text-sm text-white/75">
            The account is now a mess:{" "}
            <span className="text-value">{lockedReserve.toFixed(1)} XLM</span> locked in reserves
            across {accountState?.numSubEntries ?? 0} subentries. {executionPlan.length} steps to
            take it all apart.
          </div>
          <button
            className={`${primaryButton} bg-value text-black hover:opacity-90`}
            onClick={demolish}
          >
            <Bomb className="h-4 w-4" />
            Demolish it
          </button>
        </>
      )}

      {phase === "COMPLETE" && (
        <>
          <div className="mb-4 rounded-md border border-stellar/30 bg-[hsl(var(--stellar)/0.07)] px-4 py-3 text-sm text-white/75">
            Demolition complete. The account was merged away
            {recoveredXlm ? (
              <>
                {" "}
                and its final{" "}
                <span className="text-stellar">{parseFloat(recoveredXlm).toFixed(2)} XLM</span>{" "}
                (junk reserves included) was recovered
              </>
            ) : (
              " and every locked reserve recovered"
            )}{" "}
            - check the activity log for the receipts.
          </div>
          <button
            className={`${primaryButton} border border-white/15 text-white hover:bg-white/5`}
            onClick={start}
          >
            <RotateCcw className="h-4 w-4" />
            Run it again
          </button>
        </>
      )}

      {phase === "EXPIRED" && (
        <>
          <div className="mb-4 flex items-start gap-2 rounded-md border border-value/30 bg-[hsl(var(--value)/0.07)] px-4 py-3 text-sm text-white/75">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-value" />
            <span>This demo session expired. Start a fresh one - it only takes a few seconds.</span>
          </div>
          <button
            className={`${primaryButton} bg-stellar text-black hover:opacity-90`}
            onClick={start}
          >
            <FlaskConical className="h-4 w-4" />
            Start a new session
          </button>
        </>
      )}

      {phase === "ERROR" && (
        <>
          <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-white/75">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span className="break-words">{lastError ?? "Something went wrong."}</span>
          </div>
          <div className="flex gap-2">
            {hasProgress && (
              <button
                className={`${primaryButton} bg-value text-black hover:opacity-90`}
                onClick={demolish}
              >
                <Bomb className="h-4 w-4" />
                Resume demolish
              </button>
            )}
            <button
              className={`${primaryButton} border border-white/15 text-white hover:bg-white/5`}
              onClick={start}
            >
              <RotateCcw className="h-4 w-4" />
              Start over
            </button>
          </div>
        </>
      )}
    </div>
  );
}
