"use client";

import { use, useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, AlertTriangle, ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { Network } from "@/config/networks";
import type { AccountState } from "@/types/account";
import type { PlanBlocker } from "@/types/plan";
import type { AssetConvertibility } from "@/lib/stellar/fast-path";
import { useDemolishStore } from "@/store/demolish";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { assessConversions } from "@/lib/stellar/fast-path";
import PlanView from "@/components/plan/PlanView";

export default function AnalyzePage({ params }: { params: Promise<{ network: Network }> }) {
  const { network: routeNetwork } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();

  const source = searchParams.get("source");

  const { setAccountState, sourceAddress } = useDemolishStore();

  const [account, setAccount] = useState<AccountState | null>(null);
  const [conversions, setConversions] = useState<AssetConvertibility[]>([]);
  const [blockers, setBlockers] = useState<PlanBlocker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const effectiveSource = source ?? sourceAddress;

  const fetchData = useCallback(async () => {
    if (!effectiveSource) {
      router.push(`/${routeNetwork}`);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const accountRes = await fetch(`/api/${routeNetwork}/account/${effectiveSource}`);

      if (!accountRes.ok) {
        const data = await accountRes.json();
        setError(data.error ?? "Failed to fetch account data");
        return;
      }

      const accountData: AccountState = await accountRes.json();
      setAccount(accountData);
      setAccountState(accountData);

      // Destination is unknown at this stage; build the preview plan with
      // mediatorRequired=false and fastPathEligible=false purely for grouping and
      // blocker detection. The final plan is built at the destination step.
      const { blockers: planBlockers } = buildPlan(accountData, false, false);
      setBlockers(planBlockers);

      // Only probe per-asset convertibility when the account is otherwise clean.
      if (planBlockers.length === 0) {
        setConversions(await assessConversions(accountData, routeNetwork));
      } else {
        setConversions([]);
      }
    } catch {
      setError("Failed to analyze account. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [effectiveSource, routeNetwork, router, setAccountState]);

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

  if (error) {
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

      <PlanView
        account={account}
        conversions={conversions}
        blockers={blockers}
        network={routeNetwork}
        onRefresh={fetchData}
        loading={loading}
      />
    </div>
  );
}
