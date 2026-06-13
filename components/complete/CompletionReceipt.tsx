"use client";

import { useEffect } from "react";
import { CheckCircle, ExternalLink, History } from "lucide-react";
import Link from "next/link";
import type { Network } from "@/config/networks";
import { SE_EXPLORER_BASE, SV_EXPLORER_BASE } from "@/config/networks";
import type { StepType, AssetDisposition } from "@/types/plan";
import type { Trustline } from "@/types/account";
import { useDemolishStore } from "@/store/demolish";
import { cleanupSession } from "@/lib/session/recovery";
import { saveHistory } from "@/lib/session/history";
import { formatXlm } from "@/lib/utils/amounts";
import { StepTypeIcon } from "@/lib/utils/stepIcons";

interface CompletionReceiptProps {
  network: Network;
}

type GroupType =
  | "NORMALIZE_SIGNERS"
  | "REMOVE_DATA_ENTRIES"
  | "CANCEL_OFFERS"
  | "CLAIM_BALANCES"
  | "CONVERT_ASSETS"
  | "REMOVE_TRUSTLINES"
  | "MERGE";

interface SummaryGroup {
  type: GroupType;
  title: string;
  summary: string;
  body: React.ReactNode;
  /** Transaction hash that effected this group, or null when it cannot be resolved. */
  txHash: string | null;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-8)}`;
}

function assetCode(asset: string): string {
  return asset === "native" ? "XLM" : asset.split(":")[0];
}

export default function CompletionReceipt({ network }: CompletionReceiptProps) {
  const {
    executionPlan,
    destinationAddress,
    sourceAddress,
    sessionId,
    reset,
    mediatorRequired,
    accountState,
    assetDispositions,
  } = useDemolishStore();
  const explorerBase = SE_EXPLORER_BASE[network];
  const svExplorerBase = SV_EXPLORER_BASE[network];

  const confirmedSteps = executionPlan.filter((s) => s.status === "confirmed" && s.txHash);

  const totalFee = executionPlan
    .reduce((sum, s) => sum + parseFloat(s.estimatedFeeLumens), 0)
    .toFixed(7);

  useEffect(() => {
    if (!sessionId || !sourceAddress || !destinationAddress) return;

    saveHistory({
      id: sessionId,
      network,
      sourceAddress,
      destinationAddress,
      completedAt: new Date().toISOString(),
      txReceipts: confirmedSteps.map((s) => ({
        type: s.type,
        title: s.title,
        txHash: s.txHash!,
      })),
      totalFeeLumens: totalFee,
      usedMediator: mediatorRequired,
    })
      .then(() => cleanupSession(sessionId))
      .catch((err) => console.error("[receipt] save/cleanup failed:", err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Map each step type to the hash that effected it. A fused CLOSE_ACCOUNT covers every
  // cleanup group (and the merge when direct); an explicit step of the group's type wins
  // when the plan ran stepwise.
  const hashByType = new Map<StepType, string>();
  for (const step of confirmedSteps) {
    if (step.txHash && !hashByType.has(step.type)) hashByType.set(step.type, step.txHash);
  }
  const closeHash = hashByType.get("CLOSE_ACCOUNT") ?? null;

  // Cleanup groups fall back to the fused close hash; the merge group prefers the dedicated
  // MERGE hash (mediator transfer for exchanges) and falls back to the fused close hash.
  function cleanupHash(type: StepType): string | null {
    return hashByType.get(type) ?? closeHash;
  }
  const mergeHash = hashByType.get("MERGE") ?? closeHash;

  const account = accountState;
  const groups: SummaryGroup[] = [];

  if (account) {
    const extraSigners = account.signers.filter((s) => s.key !== account.address);
    if (extraSigners.length > 0) {
      groups.push({
        type: "NORMALIZE_SIGNERS",
        title: "Signers removed",
        summary: `${extraSigners.length} extra signer${extraSigners.length === 1 ? "" : "s"}, thresholds reset`,
        txHash: cleanupHash("NORMALIZE_SIGNERS"),
        body: (
          <ul className="space-y-1">
            {extraSigners.map((s) => (
              <li key={s.key} className="font-mono-address text-xs text-white/55">
                {shortAddr(s.key)} <span className="text-white/35">· weight {s.weight}</span>
              </li>
            ))}
          </ul>
        ),
      });
    }

    if (account.dataEntries.length > 0) {
      groups.push({
        type: "REMOVE_DATA_ENTRIES",
        title: "Data removed",
        summary: `${account.dataEntries.length} data entr${account.dataEntries.length === 1 ? "y" : "ies"}`,
        txHash: cleanupHash("REMOVE_DATA_ENTRIES"),
        body: (
          <ul className="space-y-1">
            {account.dataEntries.map((d) => (
              <li key={d.key} className="font-mono text-xs text-white/55 truncate">
                {d.key}
              </li>
            ))}
          </ul>
        ),
      });
    }

    if (account.openOffers.length > 0) {
      groups.push({
        type: "CANCEL_OFFERS",
        title: "Offers cancelled",
        summary: `${account.openOffers.length} open offer${account.openOffers.length === 1 ? "" : "s"}`,
        txHash: cleanupHash("CANCEL_OFFERS"),
        body: (
          <ul className="space-y-1">
            {account.openOffers.map((o) => (
              <li key={o.id} className="text-xs text-white/55">
                <span className="text-white/70">{o.amount}</span> {assetCode(o.selling)}{" "}
                <span className="text-white/35">→</span> {assetCode(o.buying)}
              </li>
            ))}
          </ul>
        ),
      });
    }

    if (account.claimableBalances.length > 0) {
      groups.push({
        type: "CLAIM_BALANCES",
        title: "Balances claimed",
        summary: `${account.claimableBalances.length} claimable balance${account.claimableBalances.length === 1 ? "" : "s"}`,
        txHash: cleanupHash("CLAIM_BALANCES"),
        body: (
          <ul className="space-y-1">
            {account.claimableBalances.map((b) => (
              <li key={b.id} className="text-xs text-white/55">
                <span className="text-white/70">{b.amount}</span> {assetCode(b.asset)}
              </li>
            ))}
          </ul>
        ),
      });
    }

    // Assets group: per-asset disposition (swapped to XLM vs returned to issuer). Prefer the
    // store's recorded dispositions; fall back to the CONVERT_ASSETS steps' fallbackToIssuer
    // flag when dispositions are empty (e.g. a recovered stepwise run).
    const assetsWithBalance: Trustline[] = account.trustlines.filter(
      (tl) => parseFloat(tl.balance) > 0
    );
    const convertSteps = confirmedSteps.filter((s) => s.type === "CONVERT_ASSETS");

    function dispositionFor(tl: Trustline): AssetDisposition | null {
      const recorded = assetDispositions[tl.asset];
      if (recorded) return recorded;
      const step = convertSteps.find((s) => s.affectedAsset === tl.asset);
      if (step) return step.fallbackToIssuer ? "issuer" : "convert";
      return null;
    }

    if (assetsWithBalance.length > 0) {
      groups.push({
        type: "CONVERT_ASSETS",
        title: "Assets handled",
        summary: `${assetsWithBalance.length} asset${assetsWithBalance.length === 1 ? "" : "s"} with a balance`,
        txHash: cleanupHash("CONVERT_ASSETS"),
        body: (
          <ul className="space-y-1.5">
            {assetsWithBalance.map((tl) => {
              const disposition = dispositionFor(tl);
              const label =
                disposition === "issuer"
                  ? "returned to issuer"
                  : disposition === "convert"
                    ? "swapped to XLM"
                    : "resolved";
              return (
                <li key={tl.asset} className="flex items-center gap-2 text-xs text-white/55">
                  <span className="font-medium text-white/80">{tl.code}</span>
                  <span className="text-white/35">→</span>
                  <span>{label}</span>
                </li>
              );
            })}
          </ul>
        ),
      });
    }

    if (account.trustlines.length > 0) {
      groups.push({
        type: "REMOVE_TRUSTLINES",
        title: "Trustlines removed",
        summary: `${account.trustlines.length} trustline${account.trustlines.length === 1 ? "" : "s"}`,
        txHash: cleanupHash("REMOVE_TRUSTLINES"),
        body: (
          <ul className="space-y-1">
            {account.trustlines.map((tl) => (
              <li key={tl.asset} className="text-xs text-white/55">
                {tl.code}
              </li>
            ))}
          </ul>
        ),
      });
    }
  }

  groups.push({
    type: "MERGE",
    title: "Account merged",
    summary: destinationAddress
      ? mediatorRequired
        ? `via intermediary to ${shortAddr(destinationAddress)}`
        : `to ${shortAddr(destinationAddress)}`
      : "merged to destination",
    txHash: mergeHash,
    body: (
      <div className="space-y-1 text-xs text-white/55">
        {destinationAddress && (
          <p>
            Destination:{" "}
            <span className="font-mono-address text-white/70">{shortAddr(destinationAddress)}</span>
          </p>
        )}
        <p>
          {mediatorRequired
            ? "The merge was routed through a shared intermediary account as a co-signed transfer."
            : "The account was merged into the destination and removed from the Stellar ledger."}
        </p>
      </div>
    ),
  });

  return (
    <div className="space-y-6">
      {/* Success banner */}
      <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-6 text-center">
        <CheckCircle className="h-12 w-12 text-emerald-500 mx-auto mb-3" />
        <h2 className="mkt-display text-2xl font-bold mb-1 text-white">
          Account successfully merged
        </h2>
        <p className="text-sm text-white/55">
          All assets have been transferred and the account has been removed from the Stellar ledger.
        </p>
      </div>

      {/* Grouped summary */}
      <div className="mkt-panel rounded-2xl overflow-hidden">
        <div className="border-b border-white/10 px-4 py-3">
          <h3 className="mkt-eyebrow text-white/45">What was done</h3>
        </div>
        <div className="divide-y divide-white/8">
          {groups.map((g) => (
            <div key={g.type} className="px-4 py-3.5">
              <div className="flex items-start justify-between gap-4">
                <span className="flex min-w-0 items-start gap-2.5">
                  <StepTypeIcon type={g.type} className="h-4 w-4 mt-0.5 shrink-0 text-stellar/70" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-white/85">{g.title}</span>
                    <span className="block truncate text-xs text-white/45">{g.summary}</span>
                  </span>
                </span>
                {g.txHash && (
                  <span className="flex shrink-0 items-center gap-2">
                    <a
                      href={`${explorerBase}/tx/${g.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs text-stellar hover:underline"
                    >
                      SE <ExternalLink className="h-3 w-3" />
                    </a>
                    <a
                      href={`${svExplorerBase}/tx/${g.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs text-stellar hover:underline"
                    >
                      SV <ExternalLink className="h-3 w-3" />
                    </a>
                  </span>
                )}
              </div>
              <div className="mt-2 pl-[1.625rem]">{g.body}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Summary */}
      <div className="mkt-panel rounded-2xl p-4 space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-white/55">Source account</span>
          <span className="font-mono-address text-xs text-white/70">
            {sourceAddress?.slice(0, 8)}...{sourceAddress?.slice(-8)}
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-white/55">Destination</span>
          <span className="font-mono-address text-xs text-white/70">
            {destinationAddress?.slice(0, 8)}...{destinationAddress?.slice(-8)}
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-white/55">Total fees paid</span>
          <span className="text-xs mkt-mono text-white/70">{formatXlm(totalFee)}</span>
        </div>
      </div>

      {/* History saved notice */}
      <div className="flex items-start gap-2.5 bg-white/[0.03] border border-white/10 rounded-xl p-3 text-xs text-white/50">
        <History className="h-4 w-4 shrink-0 mt-0.5 text-stellar" />
        Receipt saved to local history. You can review past merges anytime from the history icon in
        the navigation bar.
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={reset}
          className="flex-1 py-2.5 px-4 rounded-xl border border-white/15 text-sm font-medium text-white/85 hover:border-white/30 hover:text-white transition-colors"
        >
          Merge another account
        </button>
        <Link
          href={`${explorerBase}/account/${destinationAddress}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 flex items-center justify-center gap-1.5 py-2.5 px-4 rounded-xl bg-stellar text-black text-sm font-semibold hover:bg-stellar/90 transition-colors"
        >
          Stellar Expert
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
        <Link
          href={`${svExplorerBase}/account/${destinationAddress}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 flex items-center justify-center gap-1.5 py-2.5 px-4 rounded-xl bg-stellar text-black text-sm font-semibold hover:bg-stellar/90 transition-colors"
        >
          StellarView
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}
