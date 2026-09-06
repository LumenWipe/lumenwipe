"use client";

import { useEffect } from "react";
import { CheckCircle, ExternalLink, History, Link2 } from "lucide-react";
import Link from "next/link";
import type { Network } from "@/config/networks";
import { SE_EXPLORER_BASE, SV_EXPLORER_BASE } from "@/config/networks";
import type { AssetDisposition } from "@/types/plan";
import { useDemolishStore } from "@/store/demolish";
import { cleanupSession } from "@/lib/session/recovery";
import { saveHistory } from "@/lib/session/history";
import { formatXlm } from "@/lib/utils/amounts";
import { StepTypeIcon } from "@/lib/utils/stepIcons";
import { buildTxLedger, labelForTx } from "@/lib/utils/txLedger";
import { receiptAssetSummary } from "@/lib/api/close-decisions";

interface CompletionReceiptProps {
  network: Network;
}

type GroupType =
  | "NORMALIZE_SIGNERS"
  | "REMOVE_DATA_ENTRIES"
  | "CANCEL_OFFERS"
  | "CLAIM_BALANCES"
  | "HANDLE_ASSETS"
  | "REMOVE_TRUSTLINES"
  | "MERGE";

interface SummaryGroup {
  type: GroupType;
  title: string;
  summary: string;
  body: React.ReactNode;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-8)}`;
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 6)}…${hash.slice(-6)}`;
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
    transferDestinations,
    claimableBalanceSelections,
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

  // The "what was done" groups below describe state changes; the transaction ledger
  // describes the real on-chain transactions. A fused close is one transaction, a
  // mediator merge is two, and DeFi exits will each add their own - the ledger reflects
  // that count instead of implying one transaction per group.
  const ledger = buildTxLedger(confirmedSteps);

  const account = accountState;
  const groups: SummaryGroup[] = [];

  if (account) {
    const extraSigners = account.signers.filter((s) => s.key !== account.address);
    if (extraSigners.length > 0) {
      groups.push({
        type: "NORMALIZE_SIGNERS",
        title: "Signers removed",
        summary: `${extraSigners.length} extra signer${extraSigners.length === 1 ? "" : "s"}, thresholds reset`,
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

    // A balance explicitly forfeited was never claimed - exclude it from "what was done" so
    // an intentionally-abandoned balance doesn't read as claimed.
    const claimedBalances = account.claimableBalances.filter(
      (b) => claimableBalanceSelections[b.id] !== "forfeit"
    );
    if (claimedBalances.length > 0) {
      groups.push({
        type: "CLAIM_BALANCES",
        title: "Balances claimed",
        summary: `${claimedBalances.length} claimable balance${claimedBalances.length === 1 ? "" : "s"}`,
        body: (
          <ul className="space-y-1">
            {claimedBalances.map((b) => (
              <li key={b.id} className="text-xs text-white/55">
                <span className="text-white/70">{b.amount}</span> {assetCode(b.asset)}
              </li>
            ))}
          </ul>
        ),
      });
    }

    // Assets group: per-asset disposition (swapped to XLM vs returned to issuer). Prefer the
    // store's recorded dispositions; fall back to the HANDLE_ASSETS steps' fallbackToIssuer
    // flag when dispositions are empty (e.g. a recovered stepwise run).
    //
    // The list comes from receiptAssetSummary, not from load-time trustlines: an asset the
    // close claimed into existence (or into a zero-balance line) held nothing when the page
    // was analyzed, and building from that state left it out of the permanent record of an
    // irreversible close entirely - including a balance returned to its issuer, the outcome
    // someone is most likely to need to look up later.
    const { handledAssets, removedTrustlines } = receiptAssetSummary(
      account,
      claimableBalanceSelections
    );
    const assetSteps = confirmedSteps.filter((s) => s.type === "HANDLE_ASSETS");

    function dispositionFor(entry: { asset: string }): AssetDisposition | null {
      const recorded = assetDispositions[entry.asset];
      if (recorded) return recorded;
      const step = assetSteps.find((s) => s.affectedAsset === entry.asset);
      if (step) return step.fallbackToIssuer ? "issuer" : "convert";
      return null;
    }

    if (handledAssets.length > 0) {
      groups.push({
        type: "HANDLE_ASSETS",
        title: "Assets handled",
        summary: `${handledAssets.length} asset${handledAssets.length === 1 ? "" : "s"} with a balance`,
        body: (
          <ul className="space-y-1.5">
            {handledAssets.map((tl) => {
              const disposition = dispositionFor(tl);
              // "transfer" must be named, not folded into the generic fallback. This is the
              // permanent record of an irreversible close, and it is the only disposition that
              // sent the balance to a third party - saying "resolved" would hide the one
              // outcome a user is most likely to need to look up later.
              const destination = transferDestinations[tl.asset];
              const label =
                disposition === "issuer"
                  ? "returned to issuer"
                  : disposition === "convert"
                    ? "swapped to XLM"
                    : disposition === "transfer"
                      ? destination
                        ? `sent to ${shortAddr(destination)}`
                        : "sent to another account"
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

    if (removedTrustlines.length > 0) {
      groups.push({
        type: "REMOVE_TRUSTLINES",
        title: "Trustlines removed",
        summary: `${removedTrustlines.length} trustline${removedTrustlines.length === 1 ? "" : "s"}`,
        body: (
          <ul className="space-y-1">
            {removedTrustlines.map((tl) => (
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
              </div>
              <div className="mt-2 pl-[1.625rem]">{g.body}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Transaction ledger */}
      {ledger.length > 0 && (
        <div className="mkt-panel rounded-2xl overflow-hidden">
          <div className="border-b border-white/10 px-4 py-3">
            <h3 className="mkt-eyebrow text-white/45">
              {ledger.length === 1 ? "Transaction" : `Transactions · ${ledger.length}`}
            </h3>
          </div>
          <div className="divide-y divide-white/8">
            {ledger.map((tx) => (
              <div key={tx.txHash} className="flex items-center justify-between gap-4 px-4 py-3.5">
                <span className="flex min-w-0 items-center gap-2.5">
                  <Link2 className="h-4 w-4 shrink-0 text-stellar/70" />
                  <span className="min-w-0">
                    <span
                      className="block truncate text-sm font-medium text-white/85"
                      title={tx.stepTitles.join(" · ")}
                    >
                      {labelForTx(tx)}
                    </span>
                    <span className="block font-mono-address text-xs text-white/40">
                      {shortHash(tx.txHash)}
                    </span>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <a
                    href={`${explorerBase}/tx/${tx.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-stellar hover:underline"
                  >
                    SE <ExternalLink className="h-3 w-3" />
                  </a>
                  <a
                    href={`${svExplorerBase}/tx/${tx.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-stellar hover:underline"
                  >
                    SV <ExternalLink className="h-3 w-3" />
                  </a>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

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
