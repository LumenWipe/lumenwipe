"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, AlertTriangle, ArrowRight, Loader2, RefreshCw } from "lucide-react";
import type { Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { closeOwner, saveCloseSession } from "@/lib/session/close-record";
import { forgetDecisions } from "@/lib/session/decision-snapshot";
import { readUnresolved } from "@/lib/session/recovery";
import { journeyOf } from "@/lib/journey/journey-state";
import { useJourneyState } from "@/lib/journey/use-journey-state";
import { allows } from "@/lib/journey/claims";
import {
  CONFIRM_HELD,
  CONFIRM_NOT_SAVED,
  CONFIRM_SAVE_FAILED,
  CONFIRM_UNCHECKED,
} from "@/lib/utils/user-error";
import { refreshReviewedPlan, type RefreshOutcome } from "@/lib/plan/refresh-plan";
import { describeChange, preparedAgo } from "@/lib/plan/plan-freshness";
import { goBackToAnalyze } from "@/lib/plan/confirm-plan";
import { formatStroops } from "@/lib/api/plan-adapters";
import { withFeeStroops, type ExpectedReceive } from "@/lib/plan/expected-receive";
import { totalFeeStroops, transactionCountLine } from "@/lib/plan/review-fees";
import { assetOutcomes } from "@/lib/plan/asset-outcomes";
import { confirmedMemo } from "@/lib/plan/memo-field";
import { destinationKind, memoLine, relayRoute } from "@/lib/plan/destination-kind";
import PlanStepList from "@/components/review/PlanStepList";
import ReviewHero, { MemoValue } from "@/components/review/ReviewHero";
import AssetOutcomeTable from "@/components/review/AssetOutcomeTable";
import AccountContents from "@/components/plan/AccountContents";
import { receiveFigure } from "@/components/plan/ExpectedReceiveBreakdown";
import { NETWORK_NAME } from "@/components/layout/NetworkBadge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { FullAddress } from "@/components/ui/full-address";
import { shortenAddress } from "@/components/ui/short-address";

/** How long the confirm waits for the close to be saved: a blocked database never answers. */
export const CONFIRM_SAVE_TIMEOUT_MS = 5000;

function withinSaveTime<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("save timed out")), CONFIRM_SAVE_TIMEOUT_MS);
  });
  return Promise.race([pending, limit]).finally(() => clearTimeout(timer));
}

const CONSENT_REQUIRED_ID = "review-consent-required";

/** How often the "prepared" line is brought up to date while the page is open. */
export const PREPARED_TICK_MS = 30_000;

/** What the last refresh found, as shown; an unchanged confirm-time refresh shows nothing. */
type RefreshNote =
  | Exclude<RefreshOutcome, { kind: "unchanged" | "failed" }>
  | { kind: "same" }
  | { kind: "failed"; message: string; fromConfirm: boolean };

/** The current time, brought up to date every tick, for a line that says how old something is. */
function useNow(tickMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(timer);
  }, [tickMs]);
  return now;
}

/** What the consent says arrives: the hero's own figure, so the two never disagree. */
function amountPhrase(expected: ExpectedReceive | null): string {
  if (!expected) return "what is left of its balance";
  const figure = receiveFigure(expected);
  return figure.feesExceed
    ? "what is left after fees, which may be nothing,"
    : `about ${figure.xlm} XLM`;
}

/** The one sentence the user consents to: which account, on which network, how much, to whom.
 *  The memo, when there is one, follows it as the hero shows it. */
function consentLine(
  source: string,
  network: Network,
  expected: ExpectedReceive | null,
  destination: string
): string {
  return `I confirm closing ${shortenAddress(source)} on ${NETWORK_NAME[network]} and sending ${amountPhrase(expected)} to ${shortenAddress(destination)}`;
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
    planPreparedAt,
  } = useDemolishStore();

  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [held, setHeld] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<RefreshNote | null>(null);
  // Set synchronously, so a second click before the first one's render cannot start a second
  // refresh or a second save.
  const busy = useRef(false);
  // A confirm or refresh that outlives this page must not act for it: leaving the review ends
  // what it started, and aborts what it is still fetching.
  const mounted = useRef(true);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inFlight.current?.abort();
    };
  }, []);
  const now = useNow(PREPARED_TICK_MS);
  // A resumed close may already have sent transactions, so there it says nothing MORE is sent.
  const journey = useJourneyState();
  const firstRun = allows(journey, "sent-only-when-signed");

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
  // Before any of that, the plan is fetched again with the same answers and compared with the one
  // reviewed: only a plan whose material content is unchanged moves on, carrying the fresh hash.
  async function handleConfirm() {
    // The consent is checked here, not only by the main button: a retry button starts a confirm too.
    if (!sourceAddress || !destinationAddress || !acknowledged || busy.current) return;
    busy.current = true;
    setConfirming(true);
    let advanced = false;
    try {
      advanced = await confirmFresh(sourceAddress);
    } finally {
      busy.current = false;
      // Left as "Preparing..." only on the way to the next page.
      if (!advanced && mounted.current) setConfirming(false);
    }
  }

  /** Plans again, then holds or saves; true once the close has moved on to signing. */
  async function confirmFresh(source: string): Promise<boolean> {
    setHeld(null);
    setNote(null);

    const outcome = await fetchFresh();
    if (!mounted.current) return false;
    if (outcome.kind !== "unchanged") {
      show(outcome, true);
      return false;
    }

    const unresolved = await readUnresolved(network, source).then(
      (found) =>
        found || journeyOf(useDemolishStore.getState()).mayBeInFlight ? CONFIRM_HELD : null,
      () => CONFIRM_UNCHECKED
    );
    if (!mounted.current) return false;
    const hold =
      unresolved ??
      (await withinSaveTime(saveCloseSession(closeOwner(network, source))).then(
        (id) => (id ? null : CONFIRM_NOT_SAVED),
        () => CONFIRM_SAVE_FAILED
      ));
    if (!mounted.current) return false;
    if (hold) {
      setHeld(hold);
      return false;
    }

    // The choices were consented to just now: none of them outlives this confirm, so a resume
    // after it asks for them again.
    forgetDecisions();
    setPhase("STEP_EXECUTING");
    router.push(`/${network}/execute`);
    return true;
  }

  async function fetchFresh(): Promise<RefreshOutcome> {
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      return await refreshReviewedPlan(network, controller.signal);
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  }

  function show(outcome: RefreshOutcome, fromConfirm: boolean) {
    // A changed plan was not the one consented to: the consent is asked for again.
    if (outcome.kind === "changed") setAcknowledged(false);
    setNote(
      outcome.kind === "unchanged"
        ? { kind: "same" }
        : outcome.kind === "failed"
          ? { kind: "failed", message: outcome.message, fromConfirm }
          : outcome
    );
  }

  async function handleRefresh() {
    if (busy.current) return;
    busy.current = true;
    setRefreshing(true);
    setHeld(null);
    setNote(null);
    try {
      const outcome = await fetchFresh();
      if (mounted.current) show(outcome, false);
    } finally {
      busy.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }

  const working = confirming || refreshing;

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
      <div className="flex flex-wrap items-center justify-between gap-2">
        {planPreparedAt !== null && (
          <p className="text-sm text-fg-muted" data-testid="plan-prepared">
            {preparedAgo(now - planPreparedAt)}
          </p>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void handleRefresh()}
          disabled={working}
          loading={refreshing}
          icon={<RefreshCw className="h-3.5 w-3.5" />}
        >
          Refresh plan
        </Button>
      </div>
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

      <section aria-labelledby="review-next-heading" className="space-y-2">
        <h2 id="review-next-heading" className="text-sm font-semibold text-fg">
          What happens next
        </h2>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-fg">
          <li>
            {firstRun
              ? "You sign each transaction; nothing is sent until you do."
              : "You sign each transaction; nothing more is sent until you do."}
          </li>
          <li>
            Your first signature starts changes that cannot be undone, such as swaps, returns to
            issuer and removed trustlines.
          </li>
          <li>
            {allows(journey, "resume-after-stop")
              ? "If you stop midway the account stays open and partly cleaned up, and you can resume."
              : "If you stop midway the account stays open and partly cleaned up."}
          </li>
          <li>
            <Callout tone="danger" announce={false} data-testid="review-final-warning">
              The final transaction permanently closes the account.
            </Callout>
          </li>
        </ol>
      </section>

      <Callout tone="info" icon={<ShieldCheck className="h-4 w-4" />}>
        Before you sign each transaction, we check its destination, memo and operations against what
        you chose.
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

      {sourceAddress && destinationAddress && (
        <>
          <p className="text-sm text-fg">
            Destination: <FullAddress value={destinationAddress} label="destination address" />
          </p>
          <label
            className="flex min-h-control cursor-pointer select-none items-start gap-3 py-2"
            data-testid="review-consent-row"
          >
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={working}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 accent-accent"
            />
            <span className="text-sm text-fg">
              {consentLine(sourceAddress, network, expected, destinationAddress)}
              {memoShown.value !== null && (
                <>
                  {" "}
                  with memo <MemoValue memo={memoShown} />
                </>
              )}
              .
            </span>
          </label>
        </>
      )}

      <Button
        onClick={handleConfirm}
        disabled={working || executionPlan.length === 0 || !acknowledged}
        loading={confirming}
        aria-describedby={acknowledged ? undefined : CONSENT_REQUIRED_ID}
        className="w-full"
        iconEnd={<ArrowRight className="h-4 w-4" />}
      >
        {confirming ? "Preparing..." : "Continue to signing"}
      </Button>
      {!acknowledged && (
        <p id={CONSENT_REQUIRED_ID} className="text-sm text-fg">
          Tick the box to continue
        </p>
      )}

      {note?.kind === "same" && (
        <Callout tone="info" announce="status">
          The plan is the same as the one you reviewed.
        </Callout>
      )}
      {note?.kind === "changed" && (
        <Callout
          tone="warning"
          announce="alert"
          icon={<AlertTriangle className="h-4 w-4" />}
          title="The plan changed since you reviewed it"
          data-testid="plan-changes"
        >
          <ul className="list-disc space-y-1 pl-5">
            {note.changes.map((change) => (
              <li key={change.kind}>{describeChange(change)}</li>
            ))}
          </ul>
          <p className="mt-2">Review it again, then tick the box to continue.</p>
        </Callout>
      )}
      {note?.kind === "needs-analyze" && (
        <Callout
          tone="danger"
          icon={<AlertTriangle className="h-4 w-4" />}
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => goBackToAnalyze(setPhase, router, network)}
            >
              Go back to decide
            </Button>
          }
        >
          {note.message}
        </Callout>
      )}
      {note?.kind === "failed" && (
        <Callout
          tone="danger"
          icon={<AlertTriangle className="h-4 w-4" />}
          action={
            <Button
              variant="secondary"
              size="sm"
              disabled={working || (note.fromConfirm && !acknowledged)}
              onClick={() => void (note.fromConfirm ? handleConfirm() : handleRefresh())}
            >
              Try again
            </Button>
          }
        >
          {note.message}
        </Callout>
      )}
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
