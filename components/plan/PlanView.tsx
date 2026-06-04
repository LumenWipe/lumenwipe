"use client";

import { useRouter } from "next/navigation";
import { ArrowRight, RefreshCw } from "lucide-react";
import type { AccountState } from "@/types/account";
import type { PlannedStep } from "@/types/plan";
import type { Network } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import AccountSummaryCard from "./AccountSummaryCard";
import ExecutionPlanList from "./ExecutionPlanList";
import BlockersPanel from "./BlockersPanel";

interface PlanViewProps {
  account: AccountState;
  plan: PlannedStep[];
  destinationAddress: string;
  mediatorRequired: boolean;
  network: Network;
  onRefresh: () => void;
  loading: boolean;
}

export default function PlanView({
  account,
  plan,
  destinationAddress,
  mediatorRequired,
  network,
  onRefresh,
  loading,
}: PlanViewProps) {
  const router = useRouter();
  const { setPhase, setPlan, setMediatorRequired } = useDemolishStore();

  const totalFee = plan.reduce((sum, s) => sum + parseFloat(s.estimatedFeeLumens), 0).toFixed(7);

  function handleProceed() {
    setPlan(plan);
    setMediatorRequired(mediatorRequired);
    setPhase("STEP_EXECUTING");
    router.push(`/${network}/execute`);
  }

  return (
    <div className="space-y-5">
      <AccountSummaryCard
        account={account}
        destinationAddress={destinationAddress}
        totalFee={totalFee}
      />

      <BlockersPanel blockers={[]} />

      {mediatorRequired && (
        <div className="bg-stellar/10 border border-stellar/25 rounded-2xl p-4 text-sm">
          <p className="font-medium text-stellar mb-1">Exchange destination</p>
          <p className="text-white/60">
            Your destination doesn&apos;t support direct account merges, so the close is routed
            through a shared intermediary account in one atomic transaction: your account merges into
            it, and it forwards the full balance to your exchange address with the required memo. You
            recover essentially all of your XLM; only standard network fees apply.
          </p>
        </div>
      )}

      <div className="mkt-panel rounded-2xl">
        <div className="border-b border-white/10 px-4 py-3 flex items-center justify-between">
          <h3 className="mkt-eyebrow text-white/45">Execution plan</h3>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="text-white/50 hover:text-white transition-colors disabled:opacity-40"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
        <div className="p-3 space-y-2">
          <ExecutionPlanList steps={plan} />
        </div>
        <div className="border-t border-white/10 px-4 py-3 flex items-center justify-between text-sm">
          <span className="text-white/50">
            {plan.length} step{plan.length !== 1 ? "s" : ""} · estimated fees
          </span>
          <span className="mkt-mono text-xs text-white/50">{totalFee} XLM</span>
        </div>
      </div>

      <button
        onClick={handleProceed}
        disabled={plan.length === 0}
        className="w-full flex items-center justify-center gap-2 bg-stellar text-black font-semibold py-3 px-4 rounded-xl hover:bg-stellar/90 hover:shadow-[0_0_28px_-6px_hsl(var(--stellar)/0.7)] disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none transition-all"
      >
        Begin execution
        <ArrowRight className="h-4 w-4" />
      </button>

      <p className="text-center text-xs text-white/45">
        Each step requires your explicit confirmation before signing.
      </p>
    </div>
  );
}
