"use client";

import { useEffect } from "react";
import { CheckCircle, ExternalLink, History } from "lucide-react";
import Link from "next/link";
import type { Network } from "@/config/networks";
import { SE_EXPLORER_BASE, SV_EXPLORER_BASE } from "@/config/networks";
import { useDemolishStore } from "@/store/demolish";
import { cleanupSession } from "@/lib/session/recovery";
import { saveHistory } from "@/lib/session/history";
import { formatXlm } from "@/lib/utils/amounts";

interface CompletionReceiptProps {
  network: Network;
}

export default function CompletionReceipt({ network }: CompletionReceiptProps) {
  const { executionPlan, destinationAddress, sourceAddress, sessionId, reset, mediatorRequired } =
    useDemolishStore();
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
    }).then(() => cleanupSession(sessionId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return (
    <div className="space-y-6">
      {/* Success banner */}
      <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-6 text-center">
        <CheckCircle className="h-12 w-12 text-emerald-500 mx-auto mb-3" />
        <h2 className="mkt-display text-2xl font-bold mb-1 text-white">Account successfully merged</h2>
        <p className="text-sm text-white/55">
          All assets have been transferred and the account has been removed from the Stellar ledger.
        </p>
      </div>

      {/* Transaction list */}
      <div className="mkt-panel rounded-2xl overflow-hidden">
        <div className="border-b border-white/10 px-4 py-3">
          <h3 className="mkt-eyebrow text-white/45">Transaction receipts</h3>
        </div>
        <div className="divide-y divide-white/8">
          {confirmedSteps.map((step) => (
            <div key={step.index} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium text-white">{step.title}</p>
                <p className="text-xs mkt-mono text-white/45 mt-0.5">
                  {step.txHash?.slice(0, 20)}...
                </p>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={`${explorerBase}/tx/${step.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-stellar hover:underline"
                >
                  SE <ExternalLink className="h-3 w-3" />
                </a>
                <a
                  href={`${svExplorerBase}/tx/${step.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-stellar hover:underline"
                >
                  SV <ExternalLink className="h-3 w-3" />
                </a>
              </div>
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
