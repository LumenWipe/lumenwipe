"use client";

import { use, useEffect, useRef, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, AlertTriangle, ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { Network } from "@/config/networks";
import type { AccountState } from "@/types/account";
import type { PlanBlocker } from "@/types/plan";
import { useDemolishStore } from "@/store/demolish";
import { fetchClosePlan } from "@/lib/api/close-client";
import { claimAnswersKey, claimableSelectionsToDecisions } from "@/lib/api/close-decisions";
import { loadServedRegistry } from "@/lib/exchange-registry";
import {
  decisionPointsToClaimableBalances,
  decisionPointsToConversions,
  type AssetConvertibility,
  type ClaimableBalanceDecision,
} from "@/lib/api/plan-adapters";
import PlanView from "@/components/plan/PlanView";
import { apiErrorMessage } from "@/lib/api/error-body";
import { hardBlockersOf } from "@/lib/plan/resolvable-blockers";

export default function AnalyzePage({ params }: { params: Promise<{ network: Network }> }) {
  const { network: routeNetwork } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();

  const source = searchParams.get("source");

  const { setAccountState, sourceAddress, claimableBalanceSelections } = useDemolishStore();

  const [account, setAccount] = useState<AccountState | null>(null);
  const [conversions, setConversions] = useState<AssetConvertibility[]>([]);
  const [claimableBalanceDecisions, setClaimableBalanceDecisions] = useState<
    ClaimableBalanceDecision[]
  >([]);
  const [blockers, setBlockers] = useState<PlanBlocker[]>([]);
  const [loading, setLoading] = useState(true);
  // Kept apart from `loading`, which swaps the whole page for a spinner. Answering a claim
  // re-plans, and blanking the page under someone who just clicked a radio button loses their
  // scroll position and reads as a crash. The panel's own refresh indicator is enough.
  const [replanning, setReplanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Keyed on the answers' CONTENT, never their object identity - see claimAnswersKey for why a
  // dependency on the object itself made this fetch retrigger in a loop.
  const answersKey = claimAnswersKey(claimableBalanceSelections);

  const fetchData = useCallback(async () => {
    if (!effectiveSource) {
      router.push(`/${routeNetwork}`);
      return;
    }

    const firstLoad = loadedSource.current !== effectiveSource;
    if (firstLoad) setLoading(true);
    else setReplanning(true);
    setError(null);
    const seq = ++fetchSeq.current;
    const isStale = () => fetchSeq.current !== seq;

    try {
      const accountRes = await fetch(`/api/${routeNetwork}/account/${effectiveSource}`);

      if (!accountRes.ok) {
        const data = await accountRes.json();
        setError(apiErrorMessage(data, "Failed to fetch account data"));
        return;
      }

      const accountData: AccountState = await accountRes.json();
      if (isStale()) return;
      setAccount(accountData);
      setAccountState(accountData);

      // Load the served registry here, not at signing time: verify() is synchronous and runs
      // immediately before the signature, so it cannot await a fetch at that moment. A failure
      // leaves the bundled floor in place; whether that floor may be relied on is decided
      // separately by its own expiry, not by whether this call happened to succeed.
      await loadServedRegistry();

      // The API derives blockers and per-asset convertibility (via server-side path
      // finding) from a plan built with no destination yet. The final plan is requested
      // with the destination + decisions at the "Begin execution" step.
      //
      // The claim answers go with it, and re-planning on a change is what makes the second
      // decision reachable: choosing to add a trustline and claim puts an asset in the account
      // that no trustline represents yet, and only the API knows whether it has a conversion
      // route. Without this the caller was never asked what to do with it, and the close
      // dead-ended a round after the claim had already run.
      const plan = await fetchClosePlan(
        {
          source: effectiveSource,
          decisions: claimableSelectionsToDecisions(
            useDemolishStore.getState().claimableBalanceSelections
          ),
        },
        routeNetwork
      );
      if (isStale()) return;
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
    } catch {
      if (!isStale()) {
        setError("Failed to analyze account. Please check your connection and try again.");
      }
    } finally {
      if (!isStale()) {
        setLoading(false);
        setReplanning(false);
        loadedSource.current = effectiveSource;
      }
    }
  }, [effectiveSource, routeNetwork, router, setAccountState, answersKey]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-20 flex flex-col items-center gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-stellar" />
        <p className="text-muted-foreground text-sm">Analyzing account...</p>
        <p className="text-xs text-muted-foreground/60 font-mono truncate max-w-xs">
          {effectiveSource}
        </p>
      </div>
    );
  }

  // A transient failure while re-planning must not discard the rendered plan under the user -
  // the full-page error view is for the first load only. Afterwards the inline banner below
  // reports the failure while the last good plan stays on screen.
  if (error && !account) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12">
        <div className="mkt-panel border-destructive/30 rounded-2xl p-6 text-center space-y-4">
          <AlertTriangle className="h-8 w-8 text-destructive mx-auto" />
          <p className="font-medium text-white">Analysis failed</p>
          <p className="text-sm text-muted-foreground">{error}</p>
          <Link
            href={`/${routeNetwork}`}
            className="inline-flex items-center gap-1.5 text-sm text-stellar hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Go back
          </Link>
        </div>
      </div>
    );
  }

  if (!account) return null;

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <div className="flex items-center gap-2 mb-6">
        <Link
          href={`/${routeNetwork}`}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="mkt-display text-xl font-bold text-white">Review &amp; decide</h1>
      </div>

      {error && (
        <div className="mkt-panel border-destructive/30 rounded-xl px-4 py-3 mb-4 flex items-center gap-2 text-sm text-muted-foreground">
          <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
          <span>{error}</span>
        </div>
      )}
      <PlanView
        account={account}
        conversions={conversions}
        claimableBalanceDecisions={claimableBalanceDecisions}
        blockers={blockers}
        network={routeNetwork}
        onRefresh={fetchData}
        loading={replanning}
      />
    </div>
  );
}
