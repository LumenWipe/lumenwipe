"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Bomb,
  FlaskConical,
  Loader2,
  Play,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { usePlaygroundStore } from "@/store/playground";
import { errorCopy, GENERIC_ERROR_COPY } from "@/lib/error-copy";
import { lockedReserveXlm } from "@/lib/account-summary";
import { FEATURE_SETS, validateSelection } from "@/lib/scenarios";
import { useSessionCountdown } from "@/hooks/useSessionCountdown";
import { BatchSizeField } from "./BatchPanel";
import BlockerCard from "./BlockerCard";
import CredentialsPanel from "./CredentialsPanel";
import LiveAccountState from "./LiveAccountState";
import LiveStatus from "./LiveStatus";
import ScenarioPicker from "./ScenarioPicker";
import { CountdownBadge, CountdownNotice, TIME_UP_COPY, WARNING_COPY } from "./SessionCountdown";
import WillCreateList from "./WillCreateList";

export default function PlaygroundControls({
  start,
  demolish,
  resolve,
  startBatch,
  closeBatch,
  progressStatus,
}: {
  start: () => void;
  demolish: () => void;
  resolve: (blocker: string) => void;
  startBatch: () => void;
  closeBatch: () => void;
  progressStatus: string | null;
}) {
  const phase = usePlaygroundStore((s) => s.phase);
  const expiredReason = usePlaygroundStore((s) => s.expiredReason);
  const lastError = usePlaygroundStore((s) => s.lastError);
  const blocker = usePlaygroundStore((s) => s.blocker);
  const accountState = usePlaygroundStore((s) => s.accountState);
  const recoveredXlm = usePlaygroundStore((s) => s.recoveredXlm);
  const sessionId = usePlaygroundStore((s) => s.sessionId);
  const selection = usePlaygroundStore((s) => s.selection);
  const preset = usePlaygroundStore((s) => s.preset);
  const seed = usePlaygroundStore((s) => s.seed);
  const unavailable = usePlaygroundStore((s) => s.unavailable);
  const reset = usePlaygroundStore((s) => s.reset);
  const demolishFailed = usePlaygroundStore((s) => s.demolishFailed);
  const linkPending = usePlaygroundStore((s) => s.linkPending);
  const batchSize = usePlaygroundStore((s) => s.batchSize);
  const batch = usePlaygroundStore((s) => s.batch);

  // "Start over" after a close stopped part way asks first: the account is abandoned on testnet.
  const [confirmingAbandon, setConfirmingAbandon] = useState(false);
  const countdown = useSessionCountdown();

  const busy = phase === "MESSING" || phase === "DEMOLISHING";
  const lockedReserve = accountState ? lockedReserveXlm(accountState) : 0;
  const counting = countdown.remaining !== null && phase !== "IDLE" && phase !== "COMPLETE";

  const primaryButton =
    "flex w-full items-center justify-center gap-2 rounded-md px-4 py-3 font-display text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50";

  const presetLabel =
    preset === "random" ? "Random wallet" : FEATURE_SETS.find((f) => f.id === preset)?.label;
  const demoLabel = presetLabel ?? "Custom";
  // Shown with the summary and every error, so a failed random wallet can be reported and replayed.
  const replayLine = seed ? (
    <span className="mt-1 block mkt-mono text-[11px] text-white/50">Replay code {seed}</span>
  ) : null;
  const validation = validateSelection(selection, { unavailable });
  const runnable = !linkPending && validation.ok;
  // A batch run, or a batch about to start: its members are the batch defaults, not the picker's.
  const batchMode = batch !== null || batchSize > 0;
  const startRun = batchMode ? startBatch : start;
  const closedCount = batch?.members.filter((m) => m.close === "closed").length ?? 0;
  const stoppedCount = batch ? batch.members.length - closedCount : 0;

  const phaseMessage =
    phase === "DIRTY" && !batch
      ? `The account is now a mess: ${lockedReserve.toFixed(1)} XLM locked in reserves across ${accountState?.numSubEntries ?? 0} subentries.`
      : phase === "DIRTY"
        ? "Every account is set up and planned."
        : phase === "COMPLETE"
          ? "The demo is complete."
          : "";
  const liveMessage =
    (busy ? progressStatus : null) ??
    (counting && countdown.timeUp ? TIME_UP_COPY : null) ??
    (counting && countdown.warning && !countdown.extended ? WARNING_COPY : null) ??
    phaseMessage;

  return (
    <div className="mkt-panel mkt-ticks relative rounded-lg p-5">
      <div className="mb-4 flex items-center justify-between">
        <p className="mkt-eyebrow text-white/50">Control panel</p>
        {counting && countdown.remaining !== null && (
          <CountdownBadge remaining={countdown.remaining} />
        )}
      </div>
      <LiveStatus message={liveMessage} />
      {counting && phase !== "EXPIRED" && <CountdownNotice countdown={countdown} />}

      {phase === "IDLE" && (
        <>
          <BatchSizeField />
          {batchSize === 0 && <ScenarioPicker />}
          {batchSize === 0 && validation.ok && <WillCreateList steps={validation.plan.steps} />}

          <div className="my-4 flex items-start gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2.5 text-xs text-subtle">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stellar/60" />
            <span>
              This sandbox is the <em>only</em> custodial part of LumenWipe - we create a throwaway
              testnet account so you can explore the full flow without a wallet.
            </span>
          </div>

          <button
            className={`${primaryButton} bg-stellar text-black hover:opacity-90`}
            onClick={startRun}
            disabled={batchSize > 0 ? linkPending : !runnable}
          >
            <FlaskConical className="h-4 w-4" />
            {batchSize > 0
              ? `Create & trash ${batchSize} demo accounts`
              : "Create & trash a demo account"}
          </button>
        </>
      )}

      {busy && (
        <div className="flex items-center gap-3 rounded-md border border-white/10 bg-white/[0.03] px-4 py-3">
          <Loader2 className="h-4 w-4 animate-spin text-stellar" aria-hidden />
          <span className="text-sm text-white/70">{progressStatus ?? "Working..."}</span>
        </div>
      )}

      {phase === "MESSING" && !batch && accountState && <LiveAccountState state={accountState} />}

      {phase === "DIRTY" && batch && (
        <button
          className={`${primaryButton} bg-value text-black hover:opacity-90`}
          onClick={closeBatch}
        >
          <Bomb className="h-4 w-4" />
          Close every account
        </button>
      )}

      {phase === "COMPLETE" && batch && (
        <>
          <div className="mb-4 rounded-md border border-stellar/30 bg-[hsl(var(--stellar)/0.07)] px-4 py-3 text-sm text-white/75">
            Batch complete: {closedCount} of {batch.members.length} accounts merged away
            {stoppedCount > 0 ? `, ${stoppedCount} reported and left open` : ""} - each row shows
            how its close went.
          </div>
          <div className="flex flex-col gap-2">
            <button
              className={`${primaryButton} bg-stellar text-black hover:opacity-90`}
              onClick={startBatch}
            >
              <RotateCcw className="h-4 w-4" />
              Run another batch
            </button>
            <button
              className={`${primaryButton} border border-white/15 text-white/70 hover:bg-white/5`}
              onClick={reset}
            >
              Change the setup
            </button>
          </div>
        </>
      )}

      {phase === "DIRTY" && !batch && (
        <>
          <div className="mb-4 rounded-md border border-value/30 bg-[hsl(var(--value)/0.07)] px-4 py-3 text-sm text-white/75">
            The account is now a mess:{" "}
            <span className="text-value">{lockedReserve.toFixed(1)} XLM</span> locked in reserves
            across {accountState?.numSubEntries ?? 0} subentries.
          </div>
          <div className="flex flex-col gap-2">
            <button
              className={`${primaryButton} bg-value text-black hover:opacity-90`}
              onClick={demolish}
            >
              <Bomb className="h-4 w-4" />
              Demolish it here
            </button>
            {sessionId && (
              <CredentialsPanel
                key={countdown.timeUp ? "ended" : "running"}
                sessionId={sessionId}
                timeUp={countdown.timeUp}
                buttonClassName={`${primaryButton} border border-white/15 text-white/70 hover:bg-white/5`}
              />
            )}
          </div>
          {accountState && <LiveAccountState state={accountState} />}
        </>
      )}

      {phase === "COMPLETE" && !batch && (
        <>
          <div className="mb-4 rounded-md border border-stellar/30 bg-[hsl(var(--stellar)/0.07)] px-4 py-3 text-sm text-white/75">
            {demoLabel} demo complete. The account was merged away
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
            {replayLine}
          </div>
          <div className="flex flex-col gap-2">
            <button
              className={`${primaryButton} bg-stellar text-black hover:opacity-90`}
              onClick={start}
            >
              <RotateCcw className="h-4 w-4" />
              Run the same demo again
            </button>
            <button
              className={`${primaryButton} border border-white/15 text-white/70 hover:bg-white/5`}
              onClick={reset}
            >
              Choose different scenarios
            </button>
          </div>
        </>
      )}

      {phase === "EXPIRED" && (
        <>
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-md border border-value/30 bg-[hsl(var(--value)/0.07)] px-4 py-3 text-sm text-white/75"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-value" aria-hidden />
            <span>
              {expiredReason === "time_up" ? TIME_UP_COPY : errorCopy("session_not_found")}
              {replayLine}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {expiredReason === "time_up" && (
              <button
                className={`${primaryButton} bg-value text-black hover:opacity-90`}
                onClick={batch ? closeBatch : demolish}
              >
                <Bomb className="h-4 w-4" aria-hidden />
                {batch ? "Close every account" : "Close the demo account now"}
              </button>
            )}
            <button
              className={`${primaryButton} ${
                expiredReason === "time_up"
                  ? "border border-white/15 text-white/70 hover:bg-white/5"
                  : "bg-stellar text-black hover:opacity-90"
              }`}
              onClick={startRun}
            >
              <FlaskConical className="h-4 w-4" aria-hidden />
              Start a new session
            </button>
          </div>
        </>
      )}

      {phase === "ERROR" && (
        <>
          {blocker ? (
            <BlockerCard
              message={lastError ?? GENERIC_ERROR_COPY}
              stop={blocker}
              onResolve={resolve}
            >
              {replayLine}
            </BlockerCard>
          ) : (
            <div
              role="alert"
              className="mb-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-white/75"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <span className="break-words">
                {lastError ?? GENERIC_ERROR_COPY}
                {replayLine}
              </span>
            </div>
          )}
          {demolishFailed && !batchMode ? (
            <div className="flex flex-col gap-2">
              <button
                className={`${primaryButton} bg-stellar text-black hover:opacity-90`}
                onClick={() => {
                  setConfirmingAbandon(false);
                  demolish();
                }}
              >
                <Play className="h-4 w-4" />
                Resume the close
              </button>
              {confirmingAbandon ? (
                <div className="rounded-md border border-value/30 bg-[hsl(var(--value)/0.07)] p-3">
                  <p className="mb-3 flex items-start gap-2 text-xs leading-relaxed text-white/75">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-value" />
                    <span>
                      The demo account is still open on testnet, holding test XLM and what is left
                      of its mess. Starting over abandons it there: nothing will close it later.
                    </span>
                  </p>
                  <div className="flex flex-col gap-2">
                    <button
                      className={`${primaryButton} border border-value/40 text-value hover:bg-white/5`}
                      onClick={() => {
                        setConfirmingAbandon(false);
                        start();
                      }}
                    >
                      Abandon it and start over
                    </button>
                    <button
                      className={`${primaryButton} border border-white/15 text-white/70 hover:bg-white/5`}
                      onClick={() => setConfirmingAbandon(false)}
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className={`${primaryButton} border border-white/15 text-white hover:bg-white/5`}
                  onClick={() => (accountState ? setConfirmingAbandon(true) : start())}
                >
                  <RotateCcw className="h-4 w-4" />
                  Start over
                </button>
              )}
            </div>
          ) : (
            <button
              className={`${primaryButton} border border-white/15 text-white hover:bg-white/5`}
              onClick={startRun}
            >
              <RotateCcw className="h-4 w-4" />
              Start over
            </button>
          )}
        </>
      )}
    </div>
  );
}
