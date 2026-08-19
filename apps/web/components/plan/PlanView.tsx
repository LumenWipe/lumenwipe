"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, AlertTriangle, RefreshCw } from "lucide-react";
import type { AccountState } from "@/types/account";
import type { ClaimableBalanceSelection, PlanBlocker } from "@/types/plan";
import type { Network } from "@/config/networks";
import type { AssetConvertibility, ClaimableBalanceDecision } from "@/lib/api/plan-adapters";
import type { MediatorCheckResult } from "@/types/account";
import { useDemolishStore } from "@/store/demolish";
import { fetchClosePlan } from "@/lib/api/close-client";
import {
  claimableSelectionsToDecisions,
  destinationAcknowledgementToDecisions,
  dispositionsToDecisions,
} from "@/lib/api/close-decisions";
import { apiStepsToPlannedSteps } from "@/lib/api/plan-adapters";
import { goToReview } from "@/lib/plan/confirm-plan";
import { isValidGAddress, isValidMemo } from "@/lib/utils/validation";
import {
  getMemoRequirement,
  isCexAddress,
  requiresMediatorForAddress,
} from "@/lib/exchange-registry";
import AccountSummaryCard from "./AccountSummaryCard";
import BlockersPanel from "./BlockersPanel";
import PlanAccordion from "./PlanAccordion";
import DestinationInput from "@/components/account-entry/DestinationInput";

interface PlanViewProps {
  account: AccountState;
  conversions: AssetConvertibility[];
  claimableBalanceDecisions: ClaimableBalanceDecision[];
  blockers: PlanBlocker[];
  network: Network;
  onRefresh: () => void;
  loading: boolean;
}

export default function PlanView({
  account,
  conversions,
  claimableBalanceDecisions,
  blockers,
  network,
  onRefresh,
  loading,
}: PlanViewProps) {
  const router = useRouter();
  const {
    assetDispositions,
    setAssetDisposition,
    claimableBalanceSelections,
    setClaimableBalanceSelection,
    setAddresses,
    setMediatorRequired,
    setPlan,
    setPhase,
    destinationAddress: storedDest,
    memo: storedMemo,
    destinationAcknowledgedFor,
    acknowledgeDestination,
  } = useDemolishStore();

  // Pre-fill destination/memo from the store when navigating here from a resume.
  // On fresh flows the store values are null (reset by "Merge another account") so
  // this is a no-op; on resume they hold the session's saved destination.
  const [destination, setDestination] = useState(storedDest ?? "");
  const [memo, setMemo] = useState(storedMemo ?? "");
  const [proceeding, setProceeding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-set convertible assets to "convert" so they feed the builder without user action.
  useEffect(() => {
    for (const c of conversions) {
      if (c.convertible && assetDispositions[c.asset] !== "convert") {
        setAssetDisposition(c.asset, "convert");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversions]);

  // Auto-select "claim" for balances the account can already claim (the opt-out default),
  // mirroring the convertible-assets effect above.
  useEffect(() => {
    for (const b of claimableBalanceDecisions) {
      if (b.currentlyClaimable && claimableBalanceSelections[b.balanceId] === undefined) {
        setClaimableBalanceSelection(b.balanceId, "claim");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimableBalanceDecisions]);

  // A non-convertible asset is resolved only once its store disposition is "issuer".
  const returnConfirmed = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const c of conversions) {
      if (!c.convertible) map[c.asset] = assetDispositions[c.asset] === "issuer";
    }
    return map;
  }, [conversions, assetDispositions]);

  function handleToggleReturn(asset: string, confirmed: boolean) {
    // The store has no delete; "convert" is the non-issuer sentinel for an unresolved
    // non-convertible asset, which is never treated as resolved (see allAssetsResolved).
    setAssetDisposition(asset, confirmed ? "issuer" : "convert");
  }

  // Choosing "add a trustline and claim" also pre-resolves what happens to the asset once
  // claimed: it defaults to "convert" (the same opt-out default as any other asset), matching
  // the issue's framing - the trustline doesn't exist yet at plan time, so no separate
  // asset_disposition decision point is ever offered for it, and the second close round would
  // otherwise 422 on a disposition nobody had the chance to answer.
  function handleSelectClaimableBalance(balanceId: string, selection: ClaimableBalanceSelection) {
    setClaimableBalanceSelection(balanceId, selection);
    if (selection === "add_trustline_then_claim") {
      const decision = claimableBalanceDecisions.find((b) => b.balanceId === balanceId);
      if (decision) setAssetDisposition(decision.asset, "convert");
    }
  }

  const allAssetsResolved = conversions.every(
    (c) => c.convertible || assetDispositions[c.asset] === "issuer"
  );

  // A not-currently-claimable balance is resolved once the user picked a remediation path;
  // a currently-claimable one is always resolved (it defaults to "claim" above).
  const allClaimsResolved = claimableBalanceDecisions.every(
    (b) =>
      b.currentlyClaimable ||
      claimableBalanceSelections[b.balanceId] === "add_trustline_then_claim" ||
      claimableBalanceSelections[b.balanceId] === "forfeit"
  );

  // Both claimable-balance blocker codes are resolved locally by `allClaimsResolved` above,
  // computed live from the user's own selections - not by refetching the plan on every card
  // interaction. The initial `blockers` fetch (before any decision) always reports the
  // "unclaimable" wording for an unresolved balance, and a forfeit choice keeps producing its
  // own (acknowledged, non-trapping) blocker - neither should hard-block once the local
  // resolution check says the decision is made. Every other blocker code still hard-blocks.
  const hardBlockers = blockers.filter(
    (b) => b.code !== "claimable_balance_forfeited" && b.code !== "claimable_balance_unclaimable"
  );

  const destinationStepReady = allAssetsResolved && allClaimsResolved && hardBlockers.length === 0;

  const memoReq = isValidGAddress(destination) ? getMemoRequirement(destination) : null;
  const memoRequired = memoReq?.requiresMemo ?? false;
  const memoTypeForDest = memoReq?.memoType ?? "text";
  const memoValid =
    !memoRequired || (memo.trim().length > 0 && isValidMemo(memo.trim(), memoTypeForDest));

  // Preview: derive mediator requirement from the registry synchronously so the
  // plan accordion shows the correct step titles before the user clicks proceed.
  // The authoritative check happens in handleProceed via the mediator/check API.
  const previewMediatorRequired =
    isValidGAddress(destination) && requiresMediatorForAddress(destination);

  // A destination the registry doesn't list may still be an exchange deposit address, and
  // closing directly into one is unrecoverable. Only the user knows where the address came
  // from, so their confirmation gates the flow (the API refuses the build without it too).
  const destinationAcknowledged =
    !isValidGAddress(destination) ||
    isCexAddress(destination) ||
    destinationAcknowledgedFor === destination;

  const canProceed =
    destinationStepReady &&
    isValidGAddress(destination) &&
    destination !== account.address &&
    memoValid &&
    destinationAcknowledged;

  const totalSubentries =
    account.trustlines.length +
    account.openOffers.length +
    account.dataEntries.length +
    account.signers.filter((s) => s.key !== account.address).length;
  const previewFee = (totalSubentries * 0.00001).toFixed(7);

  async function handleProceed() {
    if (!canProceed) return;
    setProceeding(true);
    setError(null);

    try {
      const res = await fetch(`/api/${network}/mediator/check/${destination}`);
      if (!res.ok) throw new Error(`Mediator check failed with status ${res.status}`);
      const mediatorData: MediatorCheckResult = await res.json();
      const needsMediator = mediatorData.requiresMediator ?? false;

      // Exchange destinations go through the shared mediator. If the API can't co-sign it
      // (no mediator configured), stop here - before the user enters a key or signs -
      // rather than failing at execution time.
      if (needsMediator && mediatorData.available === false) {
        setError(
          "Sending your balance straight to this exchange isn't available right now. Instead, merge to a personal Stellar wallet you control, then send it to the exchange from there - remember to include the exchange's deposit memo, or it won't be credited."
        );
        return;
      }

      // No second gate on knowing the intermediary's address: verification asserts the
      // hand-off structurally, so nothing client-side needs to be told which account it is.

      const effectiveMemoType = memoRequired ? memoTypeForDest : undefined;
      setAddresses(account.address, destination, memo.trim() || undefined, effectiveMemoType);
      setMediatorRequired(needsMediator);

      // Request the final plan (for the execute sidebar) from the API with the destination
      // and the user's asset + claimable-balance decisions. Execution itself re-requests the
      // transactions.
      const decisions = [
        ...dispositionsToDecisions(
          useDemolishStore.getState().assetDispositions,
          useDemolishStore.getState().transferDestinations
        ),
        ...claimableSelectionsToDecisions(useDemolishStore.getState().claimableBalanceSelections),
        ...destinationAcknowledgementToDecisions(
          useDemolishStore.getState().destinationAcknowledgedFor,
          destination
        ),
      ];
      const plan = await fetchClosePlan(
        { source: account.address, destination, decisions },
        network
      );
      setPlan(apiStepsToPlannedSteps(plan));

      // No session is persisted here: the review page's own confirmation is the only
      // caller allowed to write a resumable record, so an interruption on /review before
      // the user clicks through leaves nothing behind to resume.
      goToReview(setPhase, router, network);
    } catch {
      setError("Failed to verify the destination. Please check your connection and try again.");
    } finally {
      setProceeding(false);
    }
  }

  return (
    <div className="space-y-5">
      <AccountSummaryCard
        account={account}
        destinationAddress={isValidGAddress(destination) ? destination : null}
        totalFee={previewFee}
      />

      {/* Claimable-balance blockers are already fully conveyed live by the cards below (an
          unresolved or forfeited balance shows its own up-to-date state there); a stale
          snapshot repeating the same thing here would only confuse once the user has acted. */}
      <BlockersPanel blockers={hardBlockers} />

      <div className="mkt-panel rounded-2xl">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <h3 className="mkt-eyebrow text-white/45">What this close will do</h3>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="text-white/50 transition-colors hover:text-white disabled:opacity-40"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
        <div className="p-3">
          <PlanAccordion
            account={account}
            conversions={conversions}
            returnConfirmed={returnConfirmed}
            onToggleReturn={handleToggleReturn}
            claimableBalanceDecisions={claimableBalanceDecisions}
            claimableBalanceSelections={claimableBalanceSelections}
            onSelectClaimableBalance={handleSelectClaimableBalance}
            destinationAddress={destinationStepReady && destination ? destination : null}
            mediatorRequired={previewMediatorRequired}
          />
        </div>
      </div>

      {!destinationStepReady && (
        <p className="text-center text-xs text-white/45">
          {hardBlockers.length > 0
            ? "Resolve the blockers above to continue."
            : "Decide what happens to each asset and claimable balance above to continue."}
        </p>
      )}

      {destinationStepReady && (
        <div className="mkt-panel rounded-2xl p-5 space-y-4">
          <div>
            <h3 className="mkt-eyebrow text-white/45 mb-1">Destination</h3>
            <p className="text-xs text-white/45">
              Every asset is resolved. Enter where the recovered XLM should go.
            </p>
          </div>

          <DestinationInput
            destination={destination}
            onDestinationChange={setDestination}
            memo={memo}
            onMemoChange={setMemo}
            source={account.address}
            acknowledged={destinationAcknowledgedFor === destination}
            onAcknowledgedChange={(ack) => acknowledgeDestination(ack ? destination : null)}
          />

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <button
            onClick={handleProceed}
            disabled={!canProceed || proceeding}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-stellar px-4 py-3 font-semibold text-black transition-all hover:bg-stellar/90 hover:shadow-[0_0_28px_-6px_hsl(var(--stellar)/0.7)] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          >
            {proceeding ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Preparing transaction...
              </>
            ) : (
              <>
                Begin execution
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
