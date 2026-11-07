"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, AlertTriangle, ArrowRight, Loader2 } from "lucide-react";
import type { Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { closeOwner, saveCloseSession } from "@/lib/session/close-record";
import { forgetDecisions } from "@/lib/session/decision-snapshot";
import { readUnresolved } from "@/lib/session/recovery";
import { journeyOf } from "@/lib/journey/journey-state";
import {
  CONFIRM_HELD,
  CONFIRM_NOT_SAVED,
  CONFIRM_SAVE_FAILED,
  CONFIRM_UNCHECKED,
} from "@/lib/utils/user-error";
import { formatStroops } from "@/lib/api/plan-adapters";
import { withFeeStroops } from "@/lib/plan/expected-receive";
import { totalFeeStroops, transactionCountLine } from "@/lib/plan/review-fees";
import { assetOutcomes } from "@/lib/plan/asset-outcomes";
import { confirmedMemo } from "@/lib/plan/memo-field";
import { destinationKind, memoLine, relayRoute } from "@/lib/plan/destination-kind";
import PlanStepList from "@/components/review/PlanStepList";
import ReviewHero, { MemoValue } from "@/components/review/ReviewHero";
import AssetOutcomeTable from "@/components/review/AssetOutcomeTable";
import AccountContents from "@/components/plan/AccountContents";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { FullAddress } from "@/components/ui/full-address";

/** How long the confirm waits for the close to be saved: a blocked database never answers. */
export const CONFIRM_SAVE_TIMEOUT_MS = 5000;

function withinSaveTime<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("save timed out")), CONFIRM_SAVE_TIMEOUT_MS);
  });
  return Promise.race([pending, limit]).finally(() => clearTimeout(timer));
}

interface ReviewViewProps {
  network: Network;
}

export default function ReviewView({ network }: ReviewViewProps) {
  const router = useRouter();
  const {
    accountState,
    executionPlan,
    destinationAddress,
    destinationAcknowledgedFor,
    sourceAddress,
    memo,
    memoType,
    setPhase,
    resumedClose,
    expectedReceive,
    estimatedTransactionCount,
    assetDispositions,
    transferDestinations,
    tokenConversionFloors,
    classicConversionFloors,
    claimableBalanceSelections,
  } = useDemolishStore();

  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [held, setHeld] = useState<string | null>(null);

  // The relay is said where verify() holds the close to it, never from the stored flag.
  const viaRelay = destinationAddress !== null && relayRoute(destinationAddress) === "relay";
  const memoShown = memoLine(
    destinationAddress ? confirmedMemo(destinationAddress, memo, memoType) : null
  );

  // One fee on this screen: the exact sum of the steps' fees, which the list below shows one by
  // one, is also the fee line of the amount the user is told they will receive. A step whose fee
  // cannot be read leaves both unknown, never understated. The final plan's steps already hold
  // the relay's forward payment (the builder counts it in the merge step), so nothing is added.
  const totalFee = totalFeeStroops(executionPlan);
  const expected =
    expectedReceive && totalFee !== null ? withFeeStroops(expectedReceive, totalFee) : null;

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
      (await withinSaveTime(saveCloseSession(closeOwner(network, sourceAddress))).then(
        (id) => (id ? null : CONFIRM_NOT_SAVED),
        () => CONFIRM_SAVE_FAILED
      ));
    if (hold) {
      setHeld(hold);
      setConfirming(false);
      return;
    }

    // The choices were consented to just now: none of them outlives this confirm, so a resume
    // after it asks for them again.
    forgetDecisions();
    setPhase("STEP_EXECUTING");
    router.push(`/${network}/execute`);
  }

  return (
    <div className="space-y-5">
      {sourceAddress && destinationAddress && (
        <ReviewHero
          network={network}
          source={sourceAddress}
          destination={destinationAddress}
          kind={destinationKind(destinationAddress, {
            acknowledgedFor: destinationAcknowledgedFor,
          })}
          memo={memoShown}
          expected={expected}
        />
      )}
      {resumedClose?.source === sourceAddress && (
        <p className="text-sm text-fg-muted">
          You are continuing a close you started earlier, so this plan lists only what is left on
          the account now.
        </p>
      )}
      {accountState && (
        <AssetOutcomeTable
          rows={assetOutcomes({
            account: accountState,
            dispositions: assetDispositions,
            transferDestinations,
            tokenConversionFloors,
            classicConversionFloors,
            claimSelections: claimableBalanceSelections,
          })}
          expected={expected}
        />
      )}
      {accountState && (
        <Card>
          <details open>
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-white/80">
              What is on this account
            </summary>
            <AccountContents account={accountState} className="border-t border-white/10" />
          </details>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Full plan</CardTitle>
          <p className="mt-1 text-sm text-white/80" data-testid="transaction-count">
            {transactionCountLine(estimatedTransactionCount)}
          </p>
        </CardHeader>
        <div className="px-4 pb-1">
          <PlanStepList
            steps={executionPlan}
            destinationAddress={destinationAddress}
            viaRelay={viaRelay}
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
          {destinationAddress && (
            <FullAddress
              value={destinationAddress}
              label="destination address"
              className="text-white/80"
            />
          )}
          {viaRelay ? " through the shared relay account." : "."}
        </p>
        <p className="mt-1">
          Memo: <MemoValue memo={memoShown} />
        </p>
      </Callout>

      <p className="text-sm text-fg-muted" data-testid="fee-summary">
        {totalFee === null ? (
          "Network fees could not be estimated for this plan. They are paid from the account and deducted from what arrives."
        ) : (
          <>
            Network fees: about{" "}
            <span className="mkt-mono text-white/80">{formatStroops(totalFee)} XLM</span>, paid from
            the account and deducted from what arrives.
          </>
        )}
      </p>

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
          <p>{held}</p>
          {held === CONFIRM_SAVE_FAILED && (
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              onClick={() => void handleConfirm()}
              disabled={confirming}
            >
              Try again
            </Button>
          )}
        </Callout>
      )}

      {!accountState && (
        <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
          <AlertTriangle className="h-3.5 w-3.5" />
          Account summary unavailable - the plan below is still accurate.
        </p>
      )}
    </div>
  );
}
