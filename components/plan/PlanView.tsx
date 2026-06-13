"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, AlertTriangle, RefreshCw } from "lucide-react";
import type { AccountState } from "@/types/account";
import type { PlanBlocker } from "@/types/plan";
import type { Network } from "@/config/networks";
import type { AssetConvertibility } from "@/lib/stellar/fast-path";
import type { MediatorCheckResult } from "@/types/account";
import { getMediatorPublicKey } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { isValidGAddress, isValidMemo } from "@/lib/utils/validation";
import { getMemoRequirement } from "@/lib/exchange-registry";
import AccountSummaryCard from "./AccountSummaryCard";
import BlockersPanel from "./BlockersPanel";
import PlanAccordion from "./PlanAccordion";
import DestinationInput from "@/components/account-entry/DestinationInput";

interface PlanViewProps {
  account: AccountState;
  conversions: AssetConvertibility[];
  blockers: PlanBlocker[];
  network: Network;
  onRefresh: () => void;
  loading: boolean;
}

export default function PlanView({
  account,
  conversions,
  blockers,
  network,
  onRefresh,
  loading,
}: PlanViewProps) {
  const router = useRouter();
  const {
    assetDispositions,
    setAssetDisposition,
    setAddresses,
    setMediatorRequired,
    setPlan,
    setPhase,
  } = useDemolishStore();

  const [destination, setDestination] = useState("");
  const [memo, setMemo] = useState("");
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

  const allAssetsResolved = conversions.every(
    (c) => c.convertible || assetDispositions[c.asset] === "issuer"
  );

  const destinationStepReady = allAssetsResolved && blockers.length === 0;

  const memoReq = isValidGAddress(destination) ? getMemoRequirement(destination) : null;
  const memoRequired = memoReq?.requiresMemo ?? false;
  const memoTypeForDest = memoReq?.memoType ?? "text";
  const memoValid =
    !memoRequired || (memo.trim().length > 0 && isValidMemo(memo.trim(), memoTypeForDest));

  const canProceed =
    destinationStepReady &&
    isValidGAddress(destination) &&
    destination !== account.address &&
    memoValid;

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
      const mediatorData: MediatorCheckResult = await res.json();
      const needsMediator = mediatorData.requiresMediator ?? false;
      const mediatorPublicKey = needsMediator
        ? getMediatorPublicKey(network) || undefined
        : undefined;

      const effectiveMemoType = memoRequired ? memoTypeForDest : undefined;
      setAddresses(account.address, destination, memo.trim() || undefined, effectiveMemoType);
      setMediatorRequired(needsMediator, mediatorPublicKey);

      const fastPathEligible = allAssetsResolved && blockers.length === 0;
      const { steps } = buildPlan(account, needsMediator, fastPathEligible);
      setPlan(steps);
      setPhase("STEP_EXECUTING");

      router.push(`/${network}/execute`);
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

      <BlockersPanel blockers={blockers} />

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
            destinationAddress={destinationStepReady && destination ? destination : null}
            mediatorRequired={false}
          />
        </div>
      </div>

      {!destinationStepReady && (
        <p className="text-center text-xs text-white/45">
          {blockers.length > 0
            ? "Resolve the blockers above to continue."
            : "Decide what happens to each asset above to continue."}
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
