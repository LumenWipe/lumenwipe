"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, AlertTriangle, ArrowRight, Loader2 } from "lucide-react";
import type { Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { saveCloseSession } from "@/lib/session/close-record";
import { readUnresolved } from "@/lib/session/recovery";
import { journeyOf } from "@/lib/journey/journey-state";
import {
  CONFIRM_HELD,
  CONFIRM_NOT_SAVED,
  CONFIRM_SAVE_FAILED,
  CONFIRM_UNCHECKED,
} from "@/lib/utils/user-error";
import { formatXlm } from "@/lib/utils/amounts";
import PlanStepAccordion from "@/components/review/PlanStepAccordion";
import AccountSummaryCard from "@/components/plan/AccountSummaryCard";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";

interface ReviewViewProps {
  network: Network;
}

export default function ReviewView({ network }: ReviewViewProps) {
  const router = useRouter();
  const {
    accountState,
    executionPlan,
    destinationAddress,
    mediatorRequired,
    sourceAddress,
    memo,
    memoType,
    setPhase,
  } = useDemolishStore();

  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [held, setHeld] = useState<string | null>(null);

  const totalFee = executionPlan
    .reduce((sum, step) => sum + parseFloat(step.estimatedFeeLumens), 0)
    .toFixed(7);

  // The only caller allowed to transition PREFLIGHT_COMPLETE -> STEP_EXECUTING. Nothing
  // is persisted until this fires, so leaving this page without confirming (closing the
  // tab, navigating away) never leaves a resumable session behind. A transaction of this
  // account with an unknown outcome, or a saved state that cannot be read or written, holds it.
  async function handleConfirm() {
    if (!sourceAddress || !destinationAddress) return;
    setConfirming(true);
    setHeld(null);

    const hold =
      (await readUnresolved(network, sourceAddress).then(
        (found) =>
          found || journeyOf(useDemolishStore.getState()).mayBeInFlight ? CONFIRM_HELD : null,
        () => CONFIRM_UNCHECKED
      )) ??
      (await saveCloseSession({ network, source: sourceAddress }).then(
        (id) => (id ? null : CONFIRM_NOT_SAVED),
        () => CONFIRM_SAVE_FAILED
      ));
    if (hold) {
      setHeld(hold);
      setConfirming(false);
      return;
    }

    setPhase("STEP_EXECUTING");
    router.push(`/${network}/execute`);
  }

  return (
    <div className="space-y-5">
      {accountState && (
        <AccountSummaryCard
          account={accountState}
          destinationAddress={destinationAddress}
          totalFee={totalFee}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Full plan</CardTitle>
        </CardHeader>
        <div className="p-3">
          <PlanStepAccordion
            steps={executionPlan}
            destinationAddress={destinationAddress}
            mediatorRequired={mediatorRequired}
          />
        </div>
      </Card>

      <Callout tone="info" icon={<ShieldCheck className="h-4 w-4" />}>
        Before you sign each transaction, your browser checks its destination, memo and what it does
        with each asset against what you chose, and does not sign it if anything does not match.
        Once you proceed, you&apos;ll sign each step on the next screen.
      </Callout>

      <Callout
        tone="danger"
        announce={false}
        title="This plan is permanent and irreversible."
        className="p-4"
      >
        <p>
          The account will be removed from the Stellar ledger and its balance sent to{" "}
          <span className="font-mono text-white/80 break-all">{destinationAddress}</span>
          {mediatorRequired ? " through the exchange relay account." : "."}
        </p>
        {memo && (
          <p className="mt-1">
            Memo: <span className="font-mono text-white/80">{memo}</span>
            {memoType ? ` (${memoType})` : ""}
          </p>
        )}
      </Callout>

      <label className="flex items-start gap-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="mt-0.5 accent-accent"
        />
        <span className="text-sm text-white/60">
          I have reviewed this plan and want to execute it.
        </span>
      </label>

      <Button
        onClick={handleConfirm}
        disabled={confirming || executionPlan.length === 0 || !acknowledged}
        loading={confirming}
        className="w-full"
        iconEnd={<ArrowRight className="h-4 w-4" />}
      >
        {confirming ? "Preparing..." : "I understand this plan and want to proceed"}
      </Button>

      {held && (
        <Callout tone="danger" icon={<AlertTriangle className="h-4 w-4" />}>
          {held}
        </Callout>
      )}

      {!accountState && (
        <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
          <AlertTriangle className="h-3.5 w-3.5" />
          Account summary unavailable - the plan below is still accurate.
        </p>
      )}

      <p className="text-center text-xs text-fg-subtle">
        {formatXlm(totalFee)} in estimated network fees
      </p>
    </div>
  );
}
