"use client";

import { use, useEffect, useRef, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, AlertTriangle, ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { PlanResponse } from "@lumenwipe/sdk";
import type { Network } from "@/config/networks";
import type { AccountState } from "@/types/account";
import type { PlanBlocker } from "@/types/plan";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import { fetchClosePlan } from "@/lib/api/close-client";
import { loadAnalysis, readAccount, type ClaimAnswers } from "@/lib/api/analyze-client";
import {
  claimAnswersKey,
  claimableSelectionsToDecisions,
  defiPositionsAcknowledgementToDecisions,
  issuerSupplyAcknowledgementToDecisions,
  discoveredTokensToDecisions,
  positionsLeftBehindToDecisions,
} from "@/lib/api/close-decisions";
import { loadServedRegistry } from "@/lib/exchange-registry";
import {
  decisionPointsToClaimableBalances,
  decisionPointsToConversions,
  decisionPointsToLeavablePositions,
  type AssetConvertibility,
  type ClaimableBalanceDecision,
  type LeavablePosition,
} from "@/lib/api/plan-adapters";
import PlanView from "@/components/plan/PlanView";
import StatusMessage from "@/components/a11y/StatusMessage";
import { useFocusOnMount } from "@/hooks/useFocusOnMount";
import { useKeepDecisions } from "@/hooks/useKeepDecisions";
import { readDecisions, type DecisionSnapshot } from "@/lib/session/decision-snapshot";
import {
  holdsNoDecisions,
  restoreAssetDecisions,
  restoreInputs,
} from "@/lib/session/restore-decisions";
import {
  CHOICES_RESTORED,
  changedAssetsNotice,
  choicesResetNotice,
  isStateChanged,
  toUserMessage,
} from "@/lib/utils/user-error";
import { hardBlockersOf } from "@/lib/plan/resolvable-blockers";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";

/** Everything a plan request is answering. A change re-plans; the account is not read again. */
function planAnswersKey(state: ReturnType<typeof useDemolishStore.getState>): string {
  return [
    claimAnswersKey(state.claimableBalanceSelections),
    state.defiPositionsAcknowledgedFor,
    state.issuerSupplyAcknowledgedFor,
    state.positionsLeftBehind.join(","),
  ].join("#");
}

function planFailureText(err: unknown): string {
  return isStateChanged(err)
    ? "This account changed while the plan was being prepared, so that plan was not used. Refresh the plan to try again."
    : "Failed to analyze account. Please check your connection and try again.";
}

/** How an asset is named in a notice: its code, or a token's symbol. */
function assetName(account: AccountState, asset: string): string {
  const token = account.sorobanTokens?.tokens.find((t) => t.contract === asset);
  if (token) return token.symbol ?? `${asset.slice(0, 4)}...${asset.slice(-4)}`;
  return asset.split(":")[0] ?? asset;
}

export default function AnalyzePage({ params }: { params: Promise<{ network: Network }> }) {
  const { network: routeNetwork } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();

  const source = searchParams.get("source");

  const { setAccountState, sourceAddress, planChangedNotice } = useDemolishStore();
  // A reload starts on the default network until the layout syncs it, and that sync resets the
  // store: restoring before it would be undone.
  const networkReady = useNetworkStore((s) => s.network) === routeNetwork;
  const answersKey = useDemolishStore(planAnswersKey);

  const [account, setAccount] = useState<AccountState | null>(null);
  const [conversions, setConversions] = useState<AssetConvertibility[]>([]);
  const [claimableBalanceDecisions, setClaimableBalanceDecisions] = useState<
    ClaimableBalanceDecision[]
  >([]);
  const [leavablePositions, setLeavablePositions] = useState<LeavablePosition[]>([]);
  const [blockers, setBlockers] = useState<PlanBlocker[]>([]);
  const [loading, setLoading] = useState(true);
  // Kept apart from `loading`, which swaps the whole page for a spinner. Answering a claim
  // re-plans, and blanking the page under someone who just clicked a radio button loses their
  // scroll position and reads as a crash. The panel's own refresh indicator is enough.
  const [replanning, setReplanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [changedAssets, setChangedAssets] = useState<string[]>([]);
  // Taken from the store once and cleared there, so it belongs to this visit and is not shown
  // again on the next page.
  const [reloadNotice, setReloadNotice] = useState(() => useDemolishStore.getState().reloadNotice);
  useEffect(() => {
    useDemolishStore.getState().setReloadNotice(null);
  }, []);
  const [keeping, setKeeping] = useState(false);
  // Asset answers wait for the fresh read: one is put back only for an asset it still describes.
  const pendingRestore = useRef<DecisionSnapshot | null>(null);
  // Only the first load of a source moves focus; a re-plan must not pull it off the control
  // the user just answered.
  const headingRef = useFocusOnMount<HTMLHeadingElement>(!loading && account !== null);

  const effectiveSource = source ?? sourceAddress;
  // Both refs are per SOURCE, not per mount: navigating to a different account must show the
  // full-page load state again instead of the previous account's plan, briefly gated by the
  // new account's data.
  const loadedSource = useRef<string | null>(null);
  // Monotonic guard for overlapping re-plans. Answering two claim cards quickly starts two
  // fetches; without this, whichever response lands LAST wins the screen - which can be the
  // plan for the abandoned answers, on the consent surface of an irreversible close. Only the
  // newest request may write state.
  const fetchSeq = useRef(0);

  // Apart from fetchSeq: a re-plan replaces the plan a refresh was fetching, not its account.
  const accountSeq = useRef(0);
  // Null until an account is on screen: a failed first read has nothing to re-plan.
  const knownTokens = useRef<string[] | null>(null);
  const plannedAnswers = useRef<string | null>(null);
  const readTarget = useRef<string | null>(null);

  const requestPlan = useCallback(
    (answers: ClaimAnswers, tokens: readonly string[] = []): Promise<PlanResponse> => {
      const state = useDemolishStore.getState();
      plannedAnswers.current = planAnswersKey(state);
      const planSource = effectiveSource as string;
      return fetchClosePlan(
        {
          source: planSource,
          decisions: [
            ...discoveredTokensToDecisions(tokens),
            ...claimableSelectionsToDecisions(answers),
            ...defiPositionsAcknowledgementToDecisions(
              state.defiPositionsAcknowledgedFor,
              planSource
            ),
            ...issuerSupplyAcknowledgementToDecisions(
              state.issuerSupplyAcknowledgedFor,
              planSource
            ),
            ...positionsLeftBehindToDecisions(state.positionsLeftBehind, planSource),
          ],
        },
        routeNetwork
      );
    },
    [effectiveSource, routeNetwork]
  );

  const showPlan = useCallback((plan: PlanResponse): void => {
    useDemolishStore.getState().reconcileWithPlanBlockers(plan.blockers);
    setBlockers(
      plan.blockers.map((b) => ({ message: b.message, helpUrl: b.helpUrl, code: b.code }))
    );
    // Hard blockers only. A blocker the user can answer right here must not hide the cards
    // that answer it - and it must not hide the ASSET cards either, which is what a bare
    // `blockers.length === 0` did: one unresolved claimable balance emptied the list of every
    // balance-bearing asset, and `conversions.every(...)` on an empty array then reported them
    // all resolved. That combination let a real account reach "Begin execution" and be refused
    // for decisions it had never been shown.
    setConversions(
      hardBlockersOf(plan.blockers).length === 0 ? decisionPointsToConversions(plan) : []
    );
    // Unlike other blockers, an unresolved claimable balance is resolvable right here - the
    // decision itself is what clears it - so it must render regardless of blocker state, or
    // the user could never reach the card that resolves it.
    setClaimableBalanceDecisions(decisionPointsToClaimableBalances(plan));
    // Like the claim cards, these answer a blocker, so they render whatever else blocks.
    const leavable = decisionPointsToLeavablePositions(plan);
    setLeavablePositions(leavable);
    useDemolishStore.getState().prunePositionsLeftBehind(leavable.map((p) => p.decisionId));
  }, []);

  const reload = useCallback(async () => {
    if (!effectiveSource) {
      router.push(`/${routeNetwork}`);
      return;
    }

    const firstLoad = loadedSource.current !== effectiveSource;
    if (firstLoad) {
      knownTokens.current = null;
      setLoading(true);
    } else {
      setReplanning(true);
      setStatus("Updating plan");
    }
    setError(null);
    const seq = ++fetchSeq.current;
    const isStale = () => fetchSeq.current !== seq;
    const reading = ++accountSeq.current;

    // Set when the account read itself failed, so its own message survives the catch below
    // instead of being flattened into the generic one.
    let accountError: string | null = null;

    try {
      const { plan } = await loadAnalysis({
        fetchAccount: () =>
          readAccount(routeNetwork, effectiveSource).catch((err: unknown) => {
            accountError = toUserMessage(err, "analyze");
            throw err;
          }),
        // The API derives blockers and per-asset convertibility (via server-side path
        // finding) from a plan built with no destination yet. The final plan is requested
        // with the destination + decisions at the "Begin execution" step.
        //
        // The claim answers go with it, and re-planning on a change is what makes the second
        // decision reachable: choosing to add a trustline and claim puts an asset in the account
        // that no trustline represents yet, and only the API knows whether it has a conversion
        // route. Without this the caller was never asked what to do with it, and the close
        // dead-ended a round after the claim had already run.
        //
        // The DeFi-positions acknowledgement goes with it too, for the same reason: checking
        // PlanView's box re-plans so the API's real, downgraded blocker code comes back instead
        // of leaving the page showing the hard-blocking one it just answered.
        // `tokens` is empty on the first call - it runs alongside the account read, so nothing
        // is known yet - and carries what the account turned out to hold on the re-plan
        // loadAnalysis makes when the first plan could not have known about them.
        fetchPlan: requestPlan,
        // Loaded here, not at signing time: verify() is synchronous and runs immediately before
        // the signature, so it cannot await a fetch at that moment. A failure leaves the bundled
        // floor in place; whether that floor may be relied on is decided separately by its own
        // expiry, not by whether this call happened to succeed.
        loadRegistry: loadServedRegistry,
        readAnswers: () => useDemolishStore.getState().claimableBalanceSelections,
        applyAccount: (accountData) => {
          if (accountSeq.current !== reading) return;
          knownTokens.current = (accountData.sorobanTokens?.tokens ?? []).map((t) => t.contract);
          setAccount(accountData);
          setAccountState(accountData);
          const restoring = pendingRestore.current;
          if (restoring?.source === accountData.address) {
            pendingRestore.current = null;
            const changed = restoreAssetDecisions(restoring, accountData);
            setChangedAssets(changed.map((asset) => assetName(accountData, asset)));
          }
        },
      });
      if (isStale()) return;
      showPlan(plan);
      setStatus(firstLoad ? "Account analyzed" : "Plan updated");
    } catch (err) {
      if (!isStale()) {
        setError(accountError ?? planFailureText(err));
      }
    } finally {
      if (!isStale()) {
        setLoading(false);
        setReplanning(false);
        loadedSource.current = effectiveSource;
      }
    }
  }, [effectiveSource, routeNetwork, router, setAccountState, requestPlan, showPlan]);

  const replan = useCallback(
    async (tokens: readonly string[]) => {
      setReplanning(true);
      setStatus("Updating plan");
      setError(null);
      const seq = ++fetchSeq.current;
      const isStale = () => fetchSeq.current !== seq;
      try {
        const plan = await requestPlan(
          useDemolishStore.getState().claimableBalanceSelections,
          tokens
        );
        if (isStale()) return;
        showPlan(plan);
        setStatus("Plan updated");
      } catch (err) {
        if (isStale()) return;
        setError(planFailureText(err));
      } finally {
        if (!isStale()) setReplanning(false);
      }
    },
    [requestPlan, showPlan]
  );

  // This tab's saved inputs for the account go back in before the plan is requested, so the first
  // plan already answers them. Only a store holding no answer is restored into.
  const restore = useCallback(
    (target: string) => {
      const state = useDemolishStore.getState();
      if (!holdsNoDecisions(state, target)) return;
      const read = readDecisions(routeNetwork, target);
      if (read.kind === "restored") {
        restoreInputs(read.snapshot);
        pendingRestore.current = read.snapshot;
        setReloadNotice((shown) => shown ?? CHOICES_RESTORED);
      } else if (read.kind === "failed") {
        setReloadNotice((shown) => shown ?? choicesResetNotice(read.reason));
      }
    },
    [routeNetwork]
  );

  useEffect(() => {
    if (!networkReady) return;
    // Strict Mode runs this twice on mount, and that second run is a second full account read.
    const target = `${routeNetwork}:${effectiveSource}`;
    if (readTarget.current === target) return;
    readTarget.current = target;
    if (effectiveSource) restore(effectiveSource);
    setKeeping(true);
    void reload();
  }, [effectiveSource, routeNetwork, reload, restore, networkReady]);

  useKeepDecisions(routeNetwork, effectiveSource, keeping);

  useEffect(() => {
    const tokens = knownTokens.current;
    if (tokens === null || loadedSource.current !== effectiveSource) return;
    if (plannedAnswers.current === answersKey) return;
    void replan(tokens);
  }, [answersKey, effectiveSource, replan]);

  if (loading) {
    return (
      <div role="status" className="max-w-2xl mx-auto px-4 py-20 flex flex-col items-center gap-4">
        <Loader2 aria-hidden="true" className="h-8 w-8 animate-spin text-accent" />
        <p className="text-fg-muted text-sm">Analyzing account...</p>
        <p className="text-xs text-fg-muted/60 font-mono truncate max-w-xs">{effectiveSource}</p>
      </div>
    );
  }

  // A transient failure while re-planning must not discard the rendered plan under the user -
  // the full-page error view is for the first load only. Afterwards the inline banner below
  // reports the failure while the last good plan stays on screen.
  if (error && !account) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12">
        <Callout
          tone="danger"
          icon={<AlertTriangle className="h-8 w-8" />}
          title="Analysis failed"
          className="flex-col items-center p-6 text-center"
          action={
            <Link
              href={`/${routeNetwork}`}
              className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Go back
            </Link>
          }
        >
          {error}
        </Callout>
      </div>
    );
  }

  if (!account) return null;

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <div className="flex items-center gap-2 mb-6">
        <Button asChild variant="ghost" size="icon">
          <Link href={`/${routeNetwork}`} aria-label="Back to account entry">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="mkt-display text-xl font-bold text-white outline-none"
        >
          Review &amp; decide
        </h1>
      </div>

      {reloadNotice && (
        <Callout tone="info" announce="status" className="mb-4">
          {reloadNotice}
        </Callout>
      )}
      {changedAssets.length > 0 && (
        <Callout
          tone="warning"
          announce="status"
          icon={<AlertTriangle className="h-4 w-4" />}
          className="mb-4"
        >
          {changedAssetsNotice(changedAssets)}
        </Callout>
      )}
      {planChangedNotice && (
        <Callout
          tone="warning"
          announce="status"
          icon={<AlertTriangle className="h-4 w-4" />}
          className="mb-4"
        >
          {planChangedNotice}
        </Callout>
      )}
      {error && (
        <Callout tone="danger" icon={<AlertTriangle className="h-4 w-4" />} className="mb-4">
          {error}
        </Callout>
      )}
      <PlanView
        account={account}
        conversions={conversions}
        claimableBalanceDecisions={claimableBalanceDecisions}
        leavablePositions={leavablePositions}
        blockers={blockers}
        network={routeNetwork}
        onRefresh={reload}
        loading={replanning}
        statusMessage={status}
      />
    </div>
  );
}
