"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, AlertTriangle, RefreshCw } from "lucide-react";
import type { AccountState } from "@/types/account";
import type { AssetDisposition, ClaimableBalanceSelection, PlanBlocker } from "@/types/plan";
import type { Network } from "@/config/networks";
import type {
  AssetConvertibility,
  ClaimableBalanceDecision,
  LeavablePosition,
} from "@/lib/api/plan-adapters";
import {
  useDemolishStore,
  type ClassicConversionFloor,
  type TokenConversionFloor,
} from "@/store/demolish";
import { fetchClosePlan } from "@/lib/api/close-client";
import { signatureOf } from "@/lib/plan/plan-freshness";
import {
  claimableSelectionsToDecisions,
  closeDecisions,
  destinationAcknowledgementToDecisions,
  dispositionsToDecisions,
  discoveredTokensToDecisions,
} from "@/lib/api/close-decisions";
import {
  apiStepsToPlannedSteps,
  planTransactionCountOf,
  planTransactionsOf,
  decisionPointsToLeavablePositions,
  planFeeStroopsOf,
} from "@/lib/api/plan-adapters";
import { goToReview } from "@/lib/plan/confirm-plan";
import { isValidGAddress } from "@/lib/utils/validation";
import { memoField, type ChosenMemoType } from "@/lib/plan/memo-field";
import {
  isCexAddress,
  isRegistryUsable,
  memoTypeInDispute,
  requiresMediatorForAddress,
  mediatorAllowedFor,
} from "@/lib/exchange-registry";
import AccountSummaryCard from "./AccountSummaryCard";
import BlockersPanel from "./BlockersPanel";
import PlanAccordion from "./PlanAccordion";
import DefiPositionsAcknowledgement from "./DefiPositionsAcknowledgement";
import IssuerSupplyAcknowledgement from "./IssuerSupplyAcknowledgement";
import LeavePositionAcknowledgement from "./LeavePositionAcknowledgement";
import DestinationInput from "@/components/account-entry/DestinationInput";
import {
  hardBlockersOf,
  displayBlockersOf,
  proceedError,
  DEFI_POSITIONS_UNAVAILABLE_CODE,
  ISSUER_SUPPLY_BLOCKER_CODE,
} from "@/lib/plan/resolvable-blockers";
import {
  defiPositionsAcknowledgementToDecisions,
  issuerSupplyAcknowledgementToDecisions,
  isConversionImpactConfirmed,
  positionsLeftBehindToDecisions,
} from "@/lib/api/close-decisions";
import StatusMessage from "@/components/a11y/StatusMessage";
import {
  assetCardsWithheld as cardsWithheld,
  assetResolved,
  classicFloorOf,
  convertFloorOf,
  convertUnfloored,
  tokenFloorOf,
  assetsResolved,
  claimResolved,
} from "@/lib/plan/asset-resolution";
import {
  BLOCKERS_ID,
  DESTINATION_ID,
  REFRESH_ID,
  groupChip,
  jumpToItem,
  newlyOpenGroup,
  proceedReasons,
  reasonsSummary,
  type DestinationFact,
  type GroupChip,
  type JumpTarget,
  type MemoFact,
  type OpenItem,
  type PlanGroupType,
} from "@/lib/plan/open-items";
import { expectedReceive, type ExpectedReceive } from "@/lib/plan/expected-receive";
import { destinationRefusal } from "@/lib/plan/destination-check";
import { keepDestinationDraft } from "@/lib/session/restore-decisions";
import { isStateChanged, toUserMessage } from "@/lib/utils/user-error";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";

interface PlanViewProps {
  account: AccountState;
  conversions: AssetConvertibility[];
  claimableBalanceDecisions: ClaimableBalanceDecision[];
  leavablePositions?: LeavablePosition[];
  blockers: PlanBlocker[];
  /** The fee the latest plan estimated, in stroops; null until a plan is in. */
  planFeeStroops: string | null;
  network: Network;
  onRefresh: () => void;
  loading: boolean;
  /** The last re-plan failed, so the plan on screen may not answer the latest choices. */
  planStale?: boolean;
  statusMessage?: string;
}

export default function PlanView({
  account,
  conversions,
  claimableBalanceDecisions,
  leavablePositions = [],
  blockers,
  planFeeStroops,
  network,
  onRefresh,
  loading,
  planStale = false,
  statusMessage = "",
}: PlanViewProps) {
  const router = useRouter();
  const {
    assetDispositions,
    setAssetDisposition,
    claimableBalanceSelections,
    setClaimableBalanceSelection,
    clearClaimableBalanceSelection,
    setAddresses,
    setMediatorRequired,
    setPlan,
    setExpectedReceive,
    setPhase,
    destinationAddress: storedDest,
    memo: storedMemo,
    memoType: storedMemoType,
    destinationAcknowledgedFor,
    acknowledgeDestination,
    defiPositionsAcknowledgedFor,
    acknowledgeDefiPositions,
    issuerSupplyAcknowledgedFor,
    acknowledgeIssuerSupply,
    conversionImpactAcknowledgedFor,
    acknowledgeConversionImpact,
    tokenConversionFloors,
    positionsLeftBehind,
    setPositionLeftBehind,
    transferDestinations,
    setTransferDestination,
  } = useDemolishStore();

  // Pre-fill destination/memo from the store when navigating here from a resume.
  // On fresh flows the store values are null (reset by "Close another account") so
  // this is a no-op; on resume they hold the session's saved destination.
  const [destination, setDestination] = useState(storedDest ?? "");
  const [memo, setMemo] = useState(storedMemo ?? "");
  const [memoType, setMemoType] = useState<ChosenMemoType>(storedMemoType === "id" ? "id" : "text");
  // The destination the user last picked a memo type for. Kept here only, so a destination whose
  // type is theirs to state (one only the served registry lists) is asked again on a new page.
  const [memoTypeChosenFor, setMemoTypeChosenFor] = useState<string | null>(null);
  const [proceeding, setProceeding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-set convertible assets to "convert" so they feed the builder without user action -
  // but only when the user has not answered yet.
  //
  // The condition used to be `!== "convert"`, which also matched "transfer": refetching the
  // plan (the refresh button in this very panel, or a same-tab resume) rebuilt `conversions`,
  // re-ran this effect, and reverted a convertible asset the user had marked for transfer -
  // deleting the typed destination with it, since setAssetDisposition drops it on any move
  // off transfer. Nothing went amber, because a convertible asset is resolved either way, so
  // the card silently went back to reading "will be swapped to XLM" and the balance would
  // have been sold. `=== undefined` mirrors the claimable-balance effect below, which had it
  // right.
  // The floors the plan quoted, kept for the convert answers and for verify(). Read from the same
  // rule that decides whether a convert answer is resolved (asset-resolution.ts), so an asset
  // with no floor here is never shown as answered.
  useEffect(() => {
    const floors: Record<string, TokenConversionFloor> = {};
    const classic: Record<string, ClassicConversionFloor> = {};
    for (const c of conversions) {
      const token = tokenFloorOf(c);
      if (token) floors[c.asset] = token;
      const floor = classicFloorOf(c);
      if (floor) classic[c.asset] = floor;
    }
    useDemolishStore.getState().setTokenConversionFloors(floors);
    useDemolishStore.getState().setClassicConversionFloors(classic);
  }, [conversions]);

  useEffect(() => {
    for (const c of conversions) {
      // Never for a Soroban token: its conversion is not built yet, so an auto-selected "convert"
      // would pass the resolved gate and leave the balance behind. Never without a floor either:
      // a swap with no minimum is refused at review and at signing, so it stays the user's call.
      if (
        c.convertible &&
        !c.token &&
        assetDispositions[c.asset] === undefined &&
        convertFloorOf(c) !== undefined
      ) {
        setAssetDisposition(c.asset, "convert");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversions]);

  // Auto-select "claim" for balances the account can already claim (the opt-out default),
  // mirroring the convertible-assets effect above. Only where the plan offers claiming: a balance
  // whose options could not be read is never claimed by default.
  useEffect(() => {
    for (const b of claimableBalanceDecisions) {
      if (b.offered.includes("claim") && claimableBalanceSelections[b.balanceId] === undefined) {
        setClaimableBalanceSelection(b.balanceId, "claim");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimableBalanceDecisions]);

  function handleSetDisposition(asset: string, disposition: AssetDisposition) {
    // A non-convertible asset can still hold "convert", seeded by a trustline claim below or kept
    // from a plan that had a route; allAssetsResolved never treats it as resolved for one.
    setAssetDisposition(asset, disposition);
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
      // Seed the default only where no answer exists yet - the same `=== undefined` guard the
      // auto-select effects use. Unconditional seeding meant a forfeit -> add round trip
      // clobbered an explicit transfer or issuer-return the user had already chosen.
      if (decision && useDemolishStore.getState().assetDispositions[decision.asset] === undefined) {
        setAssetDisposition(decision.asset, "convert");
      }
    }
  }
  // A bulk answer is one answer per listed balance, through the same path a card takes, so the
  // trustline seeding above is never skipped. React batches the writes into one render and one
  // re-plan. The result is said once here, not once per card.
  function handleBulkSelectClaimableBalances(
    balanceIds: string[],
    selection: ClaimableBalanceSelection,
    result: string
  ) {
    for (const id of balanceIds) handleSelectClaimableBalance(id, selection);
    announceAction(result);
  }

  // Undo touches only the balances still holding the bulk answer: one the user answered by hand
  // since keeps that answer. Each gets its earlier answer back where the latest plan still offers
  // it; otherwise its answer is cleared so the card asks again, since an answer the plan stopped
  // offering would be refused at build, after review. The announcement says which happened.
  function handleUndoClaimableBalances(
    previous: Record<string, ClaimableBalanceSelection>,
    bulkChoice: ClaimableBalanceSelection
  ) {
    const current = useDemolishStore.getState().claimableBalanceSelections;
    let restored = 0;
    let cleared = 0;
    let kept = 0;
    for (const [id, selection] of Object.entries(previous)) {
      if (current[id] !== bulkChoice) {
        kept++;
        continue;
      }
      const decision = claimableBalanceDecisions.find((b) => b.balanceId === id);
      if (decision?.offered.includes(selection)) {
        handleSelectClaimableBalance(id, selection);
        restored++;
      } else {
        clearClaimableBalanceSelection(id);
        cleared++;
      }
    }
    announceAction(undoAnnouncement(restored, cleared, kept));
  }

  const assetsNeedingDecision =
    account.trustlines.filter((tl) => Number(tl.balance) > 0).length +
    (account.sorobanTokens?.tokens ?? []).filter((t) => /^[1-9]\d*$/.test(t.balance)).length;
  // Empty is not the same as resolved - see assetCardsWithheld, where that distinction lives.
  const assetCardsWithheld = cardsWithheld(conversions, assetsNeedingDecision);
  const assetAnswers = {
    network,
    dispositions: assetDispositions,
    transferDestinations,
    tokenConversionFloors,
    conversionImpactAcknowledgedFor,
  };
  const allAssetsResolved = assetsResolved({
    ...assetAnswers,
    conversions,
    balanceBearingCount: assetsNeedingDecision,
  });

  // A flagged conversion is confirmed for the floor the convert answer carries now, never for
  // whatever the plan quotes next.
  const isImpactConfirmed = (asset: string): boolean =>
    isConversionImpactConfirmed(asset, tokenConversionFloors, conversionImpactAcknowledgedFor);
  function handleConfirmImpact(asset: string, confirmed: boolean) {
    acknowledgeConversionImpact(
      asset,
      confirmed ? (tokenConversionFloors[asset]?.minAmountOut ?? null) : null
    );
  }

  const allClaimsResolved = claimableBalanceDecisions.every((b) =>
    claimResolved(b, claimableBalanceSelections[b.balanceId])
  );

  // Both claimable-balance blocker codes are resolved locally by `allClaimsResolved` above,
  // computed live from the user's own selections - not by refetching the plan on every card
  // interaction. The initial `blockers` fetch (before any decision) always reports the
  // "unclaimable" wording for an unresolved balance, and a forfeit choice keeps producing its
  // own (acknowledged, non-trapping) blocker - neither should hard-block once the local
  // resolution check says the decision is made. `defi_positions_unconfirmed_no_trustlines`
  // (a direct on-chain check already confirmed nothing on a zero-trustline account) is the same
  // kind of non-trapping signal. Every other blocker code still hard-blocks.
  //
  // `defi_positions_unavailable` gets the same locally-resolved treatment, but conditionally:
  // unlike the codes above, its own presence is what decides whether the acknowledgement
  // checkbox (DefiPositionsAcknowledgement) even renders, so it cannot sit in
  // resolvable-blockers.ts's unconditional sets - see DEFI_POSITIONS_UNAVAILABLE_CODE's own
  // comment there for why. This local carve-out only affects this page's own proceed gate;
  // `handleProceed`'s post-decision `proceedError` check below calls the
  // plain, unmodified `hardBlockersOf` and remains the authoritative gate before anything is
  // built or signed.
  const defiPositionsBlocker = blockers.find((b) => b.code === DEFI_POSITIONS_UNAVAILABLE_CODE);
  const defiPositionsAcknowledged =
    !defiPositionsBlocker || defiPositionsAcknowledgedFor === account.address;
  const issuerSupplyBlocker = blockers.find((b) => b.code === ISSUER_SUPPLY_BLOCKER_CODE);
  const issuerSupplyAcknowledged = issuerSupplyAcknowledgedFor === account.address;
  const hardBlockers = hardBlockersOf(blockers).filter(
    (b) =>
      !(b.code === DEFI_POSITIONS_UNAVAILABLE_CODE && defiPositionsAcknowledged) &&
      !(b.code === ISSUER_SUPPLY_BLOCKER_CODE && issuerSupplyAcknowledged)
  );
  // Unlike hardBlockers, this keeps non-trapping codes with no dedicated card of their own (the
  // DeFi one above) so the panel below still shows them - only codes already fully conveyed by
  // their own UI (claimable balances) are dropped.
  const displayBlockers = displayBlockersOf(blockers).filter(
    (b) => b.code !== ISSUER_SUPPLY_BLOCKER_CODE
  );

  const destinationStepReady = allAssetsResolved && allClaimsResolved && hardBlockers.length === 0;

  // Every decision still owed, in the order the page shows them: the two confirmations above the
  // plan, then the claim cards, then the asset cards. Read from the same predicates as the gates
  // above, so the list is empty exactly when they pass.
  const defiAckOpen = hardBlockers.some((b) => b.code === DEFI_POSITIONS_UNAVAILABLE_CODE);
  const issuerAckOpen = hardBlockers.some((b) => b.code === ISSUER_SUPPLY_BLOCKER_CODE);
  const openClaims = claimableBalanceDecisions.filter(
    (b) => !claimResolved(b, claimableBalanceSelections[b.balanceId])
  );
  const openAssets = conversions.filter((c) => !assetResolved(c, assetAnswers));
  const openItems: OpenItem[] = [
    ...(defiAckOpen ? [{ id: "confirm:defi", kind: "confirmation" as const, group: null }] : []),
    ...(issuerAckOpen
      ? [{ id: "confirm:issuer", kind: "confirmation" as const, group: null }]
      : []),
    ...openClaims.map((b) => ({
      id: `claim:${b.balanceId}`,
      kind: "claim" as const,
      group: "CLAIM_BALANCES" as const,
    })),
    ...openAssets.map((c) => ({
      id: `asset:${c.asset}`,
      kind: "asset" as const,
      group: "HANDLE_ASSETS" as const,
      ...(convertUnfloored(c, assetDispositions[c.asset]) ? { unquoted: c.code } : {}),
    })),
  ];
  const chips: Partial<Record<PlanGroupType, GroupChip>> = {
    CLAIM_BALANCES: groupChip(openClaims.length),
    HANDLE_ASSETS: groupChip(openAssets.length),
    DEFI_POSITIONS: groupChip(defiPositionsBlocker ? (defiAckOpen ? 1 : 0) : null),
  };

  // The group open in the plan. It opens itself on the first decision when the page loads, and
  // again only when a re-plan brings a decision that was not there before; otherwise the user's
  // own open and close stand.
  const seenOpenItems = useRef<Set<string> | null>(null);
  const [openGroup, setOpenGroup] = useState<PlanGroupType | null>(
    () => newlyOpenGroup(null, openItems) ?? "HANDLE_ASSETS"
  );
  const openItemsKey = openItems.map((i) => i.id).join("\n");
  useEffect(() => {
    const target = seenOpenItems.current && newlyOpenGroup(seenOpenItems.current, openItems);
    seenOpenItems.current = new Set([
      ...(seenOpenItems.current ?? []),
      ...openItems.map((i) => i.id),
    ]);
    if (target) setOpenGroup(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openItemsKey]);

  // A jump opens the group first and moves focus once it has rendered open: a closed panel is
  // inert, so nothing inside it can take focus before then.
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  function jumpTo(target: JumpTarget) {
    if (target.group) setOpenGroup(target.group);
    setPendingFocus(target.selector);
  }
  useEffect(() => {
    if (pendingFocus === null) return;
    setPendingFocus(null);
    focusJumpTarget(pendingFocus);
  }, [pendingFocus]);

  // One memo, validated once: the value and type checked here are what the draft keeps, what the
  // review shows and what the request carries.
  const memoState = memoField(
    destination,
    network,
    memo,
    memoType,
    memoTypeChosenFor === destination
  );

  useEffect(() => {
    keepDestinationDraft(
      network,
      account.address,
      destination,
      memoState.normalized,
      memoState.memoType
    );
  }, [network, account.address, destination, memoState.normalized, memoState.memoType]);

  // Preview: derive mediator requirement from the registry synchronously so the
  // plan accordion shows the correct step titles before the user clicks proceed.
  // The authoritative check happens in handleProceed.
  const previewMediatorRequired =
    isValidGAddress(destination) && requiresMediatorForAddress(destination, network);

  // A destination the registry doesn't list may still be an exchange deposit address, and
  // closing directly into one is unrecoverable. Only the user knows where the address came
  // from, so their confirmation gates the flow (the API refuses the build without it too).
  const destinationAcknowledged =
    !isValidGAddress(destination) ||
    isCexAddress(destination, network) ||
    destinationAcknowledgedFor === destination;

  // Fail closed on a stale registry, but only where staleness can actually cause harm. The
  // registry's memo and mediator rules matter for an exchange destination; for a personal
  // wallet nothing about the close depends on them, so blocking every close on an expired file
  // would be a self-inflicted outage rather than a safeguard.
  const registryBlocksExchange = isCexAddress(destination, network) && !isRegistryUsable();

  const destinationFact: DestinationFact =
    destination === ""
      ? "empty"
      : !isValidGAddress(destination)
        ? "invalid"
        : destination === account.address
          ? "self"
          : "ok";
  const memoFact: MemoFact = memoState.fact;

  // A re-plan in flight (a claim answer just changed) still owes this view its conversions and
  // their floors; a plan requested before they land is hashed without them and refused at build.
  const reasons = proceedReasons({
    replanning: loading,
    planStale,
    otherHardBlockers: hardBlockers.length - (defiAckOpen ? 1 : 0) - (issuerAckOpen ? 1 : 0),
    assetCardsWithheld,
    openItems,
    destination: destinationFact,
    registryStale: registryBlocksExchange,
    // The verifier refuses this close at signing; say so here, before the user gets that far.
    registryMemoTypeDisputed: isCexAddress(destination, network) && memoTypeInDispute(destination),
    memo: memoFact,
    destinationUnacknowledged: !destinationAcknowledged,
  });
  const canProceed = reasons.length === 0;
  // The page's one live region says the latest of the page's own status and how many things are
  // left, never the list itself: a list re-read on every keystroke in the destination field would
  // drown out everything else. The count is first said when it changes, not over "Account
  // analyzed" on load.
  const summary = reasonsSummary(reasons);
  const [announcement, setAnnouncement] = useState(statusMessage);
  useEffect(() => setAnnouncement(statusMessage), [statusMessage]);
  const firstSummary = useRef(summary);
  // What a bulk answer or an undo just did. When the same change also moves the count, the count
  // follows it in the one announcement instead of replacing it.
  const pendingAction = useRef<string | null>(null);
  function announceAction(text: string) {
    pendingAction.current = text;
    setAnnouncement(text);
  }
  useEffect(() => {
    if (summary === firstSummary.current) return;
    firstSummary.current = summary;
    const action = pendingAction.current;
    setAnnouncement(action === null ? summary : `${action} ${summary}`);
  }, [summary]);
  // An action speaks for the render it caused, never for a later one.
  useEffect(() => {
    pendingAction.current = null;
  });

  const expectedFrom = (feeStroops: string, relayForwardUncounted: boolean): ExpectedReceive =>
    expectedReceive({
      account,
      planFeeStroops: feeStroops,
      relayForwardUncounted,
      conversions,
      dispositions: assetDispositions,
      claims: claimableBalanceDecisions,
      claimSelections: claimableBalanceSelections,
    });
  // The plan on screen was asked for without a destination, so it never counts the relay's
  // forward payment; the plan fetched on proceed does.
  const expected =
    planFeeStroops === null ? null : expectedFrom(planFeeStroops, previewMediatorRequired);

  async function handleProceed() {
    if (!canProceed) return;
    setProceeding(true);
    setError(null);

    try {
      const refusal = await destinationRefusal(network, destination, memoState.normalized);
      if (refusal !== null) {
        setError(refusal);
        return;
      }

      // No second gate on knowing the intermediary's address: verification asserts the
      // hand-off structurally, so nothing client-side needs to be told which account it is.

      setAddresses(
        account.address,
        destination,
        memoState.normalized || undefined,
        memoState.memoType ?? undefined
      );
      setMediatorRequired(mediatorAllowedFor(destination, network));

      // Request the final plan (for the execute sidebar) from the API with the destination
      // and the user's asset + claimable-balance decisions. Execution itself re-requests the
      // transactions.
      const decisions = closeDecisions(
        useDemolishStore.getState(),
        account.address,
        destination,
        (account.sorobanTokens?.tokens ?? []).map((tk) => tk.contract)
      );
      const plan = await fetchClosePlan(
        { source: account.address, destination, decisions },
        network
      );
      // Blockers on THIS plan, not the one fetched on page load. The load-time plan is
      // requested with no decisions at all, so it structurally cannot contain a transfer
      // problem - and the API reports those exactly here, as blockers on a 200 response
      // (close.controller.ts). Dropping them meant every destination problem the API can
      // name - account does not exist, no trustline, not authorized, limit too low,
      // destination is the account being closed, destination is an exchange deposit
      // address - stayed invisible until the user had ticked through the review gate and
      // pasted their secret key, where it surfaced as a bare 422. The exchange one is the
      // guard against permanent token loss.
      // Hard blockers only. An acknowledged forfeit arrives here as a blocker too
      // (claimable_balance_forfeited, the audit trail of the user's own answer, already
      // shown as a warning beside its card) - counting it stopped the close the moment
      // anyone gave a balance up.
      const proceedBlockersError = proceedError(plan.blockers);
      if (proceedBlockersError !== null) {
        setError(proceedBlockersError);
        // A position that became impossible to exit since the page loaded needs its own card.
        const offered = decisionPointsToLeavablePositions(plan).map((p) => p.decisionId);
        if (offered.some((id) => !leavablePositions.some((p) => p.decisionId === id))) onRefresh();
        return;
      }

      // The status is the API's own word on whether anything still needs an answer, computed
      // against THIS plan - the one built with the decisions just sent. The local gates above
      // are computed from load-time state, so a claimable balance (or a topped-up asset) that
      // appeared between page load and this click is invisible to them; proceeding would walk
      // the user through review and a secret key to a bare 422. Refresh instead, so the new
      // decision renders its card.
      if (plan.status === "needs_decisions") {
        setError(
          "This account changed while you were deciding: something new needs an answer. The plan has been refreshed - review the cards above."
        );
        onRefresh();
        return;
      }

      // What /review compares a fresh plan against before signing.
      setPlan(
        apiStepsToPlannedSteps(plan),
        plan.planHash,
        planTransactionCountOf(plan),
        signatureOf(plan, account, useDemolishStore.getState()),
        planTransactionsOf(plan)
      );
      const finalFee = planFeeStroopsOf(plan);
      setExpectedReceive(finalFee === null ? null : expectedFrom(finalFee, false));

      // No session is persisted here: the review page's own confirmation is the only
      // caller allowed to write a resumable record, so an interruption on /review before
      // the user clicks through leaves nothing behind to resume.
      goToReview(setPhase, router, network);
    } catch (err) {
      if (isStateChanged(err)) {
        setError(
          "This account changed while the plan was being prepared, so that plan was not used. The plan is being refreshed - review it, then continue."
        );
        onRefresh();
        return;
      }
      setError(toUserMessage(err, "analyze"));
    } finally {
      setProceeding(false);
    }
  }

  return (
    <div className="space-y-5">
      <StatusMessage message={proceeding ? "Building your plan" : announcement} />
      <AccountSummaryCard
        account={account}
        destinationAddress={isValidGAddress(destination) ? destination : null}
        expected={expected}
      />

      {/* Claimable-balance blockers are already fully conveyed live by the cards below (an
          unresolved or forfeited balance shows its own up-to-date state there); a stale
          snapshot repeating the same thing here would only confuse once the user has acted. */}
      <div id={BLOCKERS_ID} tabIndex={-1} className="outline-none">
        <BlockersPanel blockers={displayBlockers} blocking={hardBlockers.length > 0} />
      </div>

      {defiPositionsBlocker && (
        <div data-open-item="confirm:defi">
          <DefiPositionsAcknowledgement
            acknowledged={defiPositionsAcknowledgedFor === account.address}
            onAcknowledgedChange={(ack) => acknowledgeDefiPositions(ack ? account.address : null)}
          />
        </div>
      )}

      {(issuerSupplyBlocker || issuerSupplyAcknowledged) && (
        <div data-open-item="confirm:issuer">
          <IssuerSupplyAcknowledgement
            message={issuerSupplyBlocker?.message ?? null}
            acknowledged={issuerSupplyAcknowledged}
            onAcknowledgedChange={(ack) => acknowledgeIssuerSupply(ack ? account.address : null)}
          />
        </div>
      )}

      {leavablePositions.map((position) => (
        <LeavePositionAcknowledgement
          key={position.decisionId}
          position={position}
          leftBehind={positionsLeftBehind.includes(position.decisionId)}
          onLeftBehindChange={(leave) => setPositionLeftBehind(position.decisionId, leave)}
        />
      ))}

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>What this close will do</CardTitle>
          <Button
            id={REFRESH_ID}
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh the plan"
            className="-my-3.5 px-2"
            icon={<RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />}
          />
        </CardHeader>
        <div className="p-3">
          <PlanAccordion
            network={network}
            open={openGroup}
            onOpenChange={setOpenGroup}
            chips={chips}
            account={account}
            conversions={conversions}
            assetDispositions={assetDispositions}
            transferDestinations={transferDestinations}
            mergeDestination={isValidGAddress(destination) ? destination : null}
            onSetDisposition={handleSetDisposition}
            onSetTransferDestination={setTransferDestination}
            isImpactConfirmed={isImpactConfirmed}
            onConfirmImpact={handleConfirmImpact}
            claimableBalanceDecisions={claimableBalanceDecisions}
            claimableBalanceSelections={claimableBalanceSelections}
            onSelectClaimableBalance={handleSelectClaimableBalance}
            onBulkSelectClaimableBalances={handleBulkSelectClaimableBalances}
            onUndoClaimableBalances={handleUndoClaimableBalances}
            destinationAddress={destinationFact === "ok" ? destination : null}
            mediatorRequired={previewMediatorRequired}
          />
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <div>
          <CardTitle className="mb-1">Destination</CardTitle>
          <p className="text-xs text-fg-subtle">
            {destinationStepReady
              ? "Every item is decided. Enter where the recovered XLM should go."
              : "You can enter this now. The button below unlocks once every item above is decided."}
          </p>
        </div>

        <div id={DESTINATION_ID}>
          <DestinationInput
            network={network}
            destination={destination}
            onDestinationChange={setDestination}
            memo={memo}
            onMemoChange={setMemo}
            memoType={memoType}
            onMemoTypeChange={(type) => {
              setMemoType(type);
              setMemoTypeChosenFor(destination);
            }}
            memoTypeChosen={memoTypeChosenFor === destination}
            source={account.address}
            acknowledged={destinationAcknowledgedFor === destination}
            onAcknowledgedChange={(ack) => acknowledgeDestination(ack ? destination : null)}
          />
        </div>

        {error && (
          <Callout tone="danger" icon={<AlertTriangle className="h-4 w-4" />}>
            {error}
          </Callout>
        )}

        {openItems.length > 0 && (
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={() => jumpTo(jumpToItem(openItems[0]))}
          >
            {openItems.length === 1
              ? "1 decision left, jump to it"
              : `${openItems.length} decisions left, jump to next`}
          </Button>
        )}

        <Button
          onClick={handleProceed}
          disabled={!canProceed || proceeding}
          loading={proceeding}
          aria-describedby={reasons.length > 0 ? "plan-proceed-reasons" : undefined}
          className="w-full"
          iconEnd={<ArrowRight className="h-4 w-4" />}
        >
          {proceeding ? "Building your plan..." : "Review the full plan"}
        </Button>

        {reasons.length > 0 && (
          <ul id="plan-proceed-reasons" aria-label="Before you can review" className="space-y-1">
            {reasons.map((r) => (
              <li key={r.key} className="text-xs text-fg-muted">
                {r.target ? (
                  <button
                    type="button"
                    onClick={() => jumpTo(r.target as JumpTarget)}
                    className="text-left underline decoration-fg-subtle underline-offset-2 hover:text-fg"
                  >
                    {r.text}
                  </button>
                ) : (
                  r.text
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** Moves focus to what a reason or a jump names: the chosen answer of a decision when it has one,
 *  else its first control, else the element itself. A collapsed group of balances opens first. */
function focusJumpTarget(selector: string): void {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return;
  const details = el.closest("details");
  if (details) details.open = true;
  const control = el.matches("input, button, textarea, select")
    ? el
    : (el.querySelector<HTMLElement>("input:checked") ??
      el.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled]), textarea"));
  (control ?? el).focus();
}

function balances(n: number): string {
  return `${n} ${n === 1 ? "balance" : "balances"}`;
}

/** What an undo did, in one sentence per outcome that happened. */
function undoAnnouncement(restored: number, cleared: number, kept: number): string {
  const parts: string[] = [];
  if (restored > 0) parts.push(`Restored the earlier answer for ${balances(restored)}.`);
  if (cleared > 0) {
    parts.push(
      `${balances(cleared)} need${cleared === 1 ? "s" : ""} a new answer: the plan no longer offers the earlier one.`
    );
  }
  if (kept > 0) {
    parts.push(
      `${balances(kept)} answered since then ${kept === 1 ? "keeps its" : "keep their"} answer.`
    );
  }
  return parts.join(" ") || "Nothing to undo.";
}
