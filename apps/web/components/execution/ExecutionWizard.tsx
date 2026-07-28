"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle, ShieldCheck } from "lucide-react";
import type { Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { useCloseExecution } from "@/hooks/useCloseExecution";
import { cn } from "@/lib/utils/cn";
import SecretKeyInput from "@/components/account-entry/SecretKeyInput";
import PlanSidebar from "./PlanSidebar";
import ProgressIndicator from "./ProgressIndicator";

interface ExecutionWizardProps {
  network: Network;
}

export default function ExecutionWizard({ network }: ExecutionWizardProps) {
  const router = useRouter();
  const secretKeyRef = useRef<string>("");

  const executionPlan = useDemolishStore((s) => s.executionPlan);
  const destinationAddress = useDemolishStore((s) => s.destinationAddress);
  const mediatorRequired = useDemolishStore((s) => s.mediatorRequired);
  const phase = useDemolishStore((s) => s.phase);
  const lastError = useDemolishStore((s) => s.lastError);

  const { run, progressStatus } = useCloseExecution();
  const [keyEntered, setKeyEntered] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);

  // Wipe the key from memory when the wizard unmounts (navigation away).
  useEffect(() => () => void (secretKeyRef.current = ""), []);

  // On success, wipe the key and advance to the completion screen.
  useEffect(() => {
    if (phase === "COMPLETE") {
      secretKeyRef.current = "";
      setKeyEntered(false);
      router.push(`/${network}/complete`);
    }
  }, [phase, network, router]);

  const forgetKey = useCallback(() => {
    secretKeyRef.current = "";
    setKeyEntered(false);
  }, []);

  const execute = useCallback(async () => {
    if (!secretKeyRef.current || running) return;
    setRunning(true);
    try {
      // The engine re-reads on-chain state each round, so a retry after a failure
      // resumes: already-confirmed steps are not rebuilt or re-submitted.
      await run(secretKeyRef.current);
    } finally {
      setRunning(false);
    }
  }, [run, running]);

  if (executionPlan.length === 0 || !destinationAddress) {
    return (
      <div className="text-center py-12 text-white/45 text-sm">
        No execution plan found. Please go back and analyze your account.
      </div>
    );
  }

  const failed = phase === "STEP_FAILED" && !running;
  const busy = running || progressStatus !== null;

  return (
    <div className="flex gap-5">
      {/* Sidebar */}
      <div className="w-52 shrink-0 hidden md:block">
        <div className="sticky top-20">
          <p className="mkt-eyebrow text-white/45 mb-3">Steps</p>
          <PlanSidebar steps={executionPlan} currentIndex={0} />
        </div>
      </div>

      {/* Main panel */}
      <div className="flex-1 min-w-0">
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 flex flex-col gap-5">
          <div>
            <h2 className="text-lg font-semibold text-white">Sign &amp; execute the close</h2>
            <p className="mt-1 text-sm text-white/55">
              LumenWipe signs each transaction in your browser and submits it through the API. Your
              key never leaves this device.
            </p>
          </div>

          {/* Trust note */}
          <div className="flex items-start gap-2.5 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-sm text-white/60">
            <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5 text-stellar" />
            <span>
              Every transaction is verified against your own choices — destination, asset
              decisions, and memo — before it is signed. Anything unexpected is rejected.
            </span>
          </div>

          {/* Irreversible warning */}
          <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 text-sm">
            <p className="font-semibold text-destructive mb-1">
              This action is permanent and irreversible.
            </p>
            <p className="text-white/60">
              The account will be removed from the Stellar ledger and its balance sent to{" "}
              <span className="font-mono text-white/80 break-all">{destinationAddress}</span>
              {mediatorRequired ? " through the exchange mediator." : "."} Verify it carefully.
            </p>
          </div>

          {busy ? (
            <ProgressIndicator status={progressStatus ?? "Working…"} />
          ) : failed ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-white/70">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-destructive" />
                <span>{lastError ?? "The close could not be completed."}</span>
              </div>
              <button
                onClick={execute}
                disabled={!keyEntered}
                className="w-full py-3 px-4 rounded-xl font-semibold text-sm bg-stellar text-black hover:bg-stellar/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                Retry
              </button>
            </div>
          ) : (
            <>
              {keyEntered ? (
                <div className="flex items-center justify-between gap-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2.5">
                  <span className="flex items-center gap-2 text-sm text-emerald-400">
                    <CheckCircle className="h-4 w-4 shrink-0" />
                    Secret key loaded for this session
                  </span>
                  <button
                    type="button"
                    onClick={forgetKey}
                    className="text-xs text-white/60 hover:text-white underline-offset-2 hover:underline transition-colors"
                  >
                    Forget key
                  </button>
                </div>
              ) : (
                <SecretKeyInput
                  secretKeyRef={secretKeyRef}
                  onValidityChange={setKeyEntered}
                  disabled={running}
                />
              )}

              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  className="mt-0.5 accent-stellar"
                />
                <span className="text-sm text-white/60">
                  I understand this permanently closes the account and sends its balance to the
                  destination above.
                </span>
              </label>

              <button
                onClick={execute}
                disabled={!keyEntered || !confirmed}
                className={cn(
                  "w-full py-3 px-4 rounded-xl font-semibold text-sm transition-all",
                  "flex items-center justify-center gap-2",
                  "bg-destructive text-destructive-foreground hover:bg-destructive/90",
                  "disabled:opacity-40 disabled:cursor-not-allowed"
                )}
              >
                Sign &amp; execute close
              </button>
            </>
          )}
        </div>

        {/* Mobile step list */}
        <div className="md:hidden mt-5">
          <p className="mkt-eyebrow text-white/45 mb-2">All steps</p>
          <PlanSidebar steps={executionPlan} currentIndex={0} />
        </div>
      </div>
    </div>
  );
}
