"use client";

import { useState, useRef } from "react";
import { CheckCircle, AlertCircle, ExternalLink, Wallet } from "lucide-react";
import type { PlannedStep } from "@/types/plan";
import type { Network } from "@/config/networks";
import { SE_EXPLORER_BASE, SV_EXPLORER_BASE } from "@/config/networks";
import { cn } from "@/lib/utils/cn";
import SecretKeyInput from "@/components/account-entry/SecretKeyInput";
import XdrPreviewModal from "./XdrPreviewModal";
import ProgressIndicator from "./ProgressIndicator";
import { StepTypeIcon } from "@/lib/utils/stepIcons";

interface StepDetailPanelProps {
  step: PlannedStep;
  network: Network;
  secretKeyRef: React.MutableRefObject<string>;
  onSign: () => Promise<void>;
  onRetry: () => void;
  progressStatus: string | null;
  noSwapPath?: boolean;
  noSwapPathAsset?: string | null;
  onSendToIssuer?: () => void;
  onSkipStep?: () => void;
}

export default function StepDetailPanel({
  step,
  network,
  secretKeyRef,
  onSign,
  onRetry,
  progressStatus,
  noSwapPath,
  noSwapPathAsset,
  onSendToIssuer,
  onSkipStep,
}: StepDetailPanelProps) {
  const [confirmed, setConfirmed] = useState(false);
  const [keyValid, setKeyValid] = useState(false);
  const explorerBase = SE_EXPLORER_BASE[network];
  const svExplorerBase = SV_EXPLORER_BASE[network];

  const isExecuting = step.status === "signing" || step.status === "submitted";
  const isMerge = step.type === "MERGE";
  const canSign = confirmed && keyValid && !isExecuting;

  const confirmText = isMerge
    ? "I have verified the destination address and understand that this account will be merged and removed from the Stellar ledger."
    : step.fallbackToIssuer
      ? `I understand my ${step.affectedAsset?.split(":")[0]} balance will be sent to the issuer instead of swapped on the DEX.`
      : `I understand this will ${step.description.toLowerCase()}`;

  return (
    <div className="mkt-panel rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="border-b border-white/10 px-5 py-4">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-stellar">
            <StepTypeIcon type={step.type} className="h-5 w-5" />
          </span>
          <h2 className="mkt-display font-bold text-lg text-white">{step.title}</h2>
        </div>
        <p className="text-sm text-white/55">{step.description}</p>
      </div>

      {/* Meta */}
      <div className="border-b border-white/10 px-5 py-3 flex gap-6 mkt-mono text-xs text-white/45">
        <span>
          {step.operationCount} operation{step.operationCount !== 1 ? "s" : ""}
        </span>
        <span>~{step.estimatedFeeLumens} XLM fee</span>
        {step.affectedAsset && <span>Asset: {step.affectedAsset.split(":")[0]}</span>}
      </div>

      <div className="p-5 space-y-5">
        {/* Confirmed step view */}
        {step.status === "confirmed" && step.txHash && (
          <div className="flex items-start gap-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-4">
            <CheckCircle className="h-5 w-5 text-emerald-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-emerald-400 mb-1">Step confirmed</p>
              <div className="flex items-center gap-3">
                <a
                  href={`${explorerBase}/tx/${step.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-stellar transition-colors font-mono"
                >
                  {step.txHash.slice(0, 20)}...{step.txHash.slice(-8)}
                  <ExternalLink className="h-3 w-3" />
                </a>
                <a
                  href={`${svExplorerBase}/tx/${step.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-stellar transition-colors shrink-0"
                >
                  StellarView <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          </div>
        )}

        {/* Failed step view */}
        {step.status === "failed" && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 space-y-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <p className="text-sm text-destructive">{step.error}</p>
            </div>
            <button onClick={onRetry} className="text-xs text-stellar hover:underline">
              Retry this step
            </button>
          </div>
        )}

        {/* Pending / executing view */}
        {(step.status === "pending" || isExecuting) && (
          <>
            {/* No DEX path warning - shown before user makes a choice */}
            {noSwapPath && !isExecuting && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 space-y-3">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-amber-400">
                      No swap route available for {noSwapPathAsset}
                    </p>
                    <p className="text-sm text-white/55 mt-1">
                      The Stellar DEX has no liquidity path for this asset right now. You can skip
                      this step and convert it manually on{" "}
                      <a
                        href="https://stellar.expert"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-stellar underline-offset-2 hover:underline"
                      >
                        stellar.expert
                      </a>{" "}
                      or another exchange, then come back to continue. Alternatively, you can return
                      the balance to the issuer - note that not all issuers accept returning tokens.
                    </p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={onSkipStep}
                    className="flex-1 py-2 px-3 rounded-lg text-sm font-semibold bg-stellar/15 text-stellar border border-stellar/30 hover:bg-stellar/25 transition-colors"
                  >
                    Skip for now
                  </button>
                  <button
                    onClick={onSendToIssuer}
                    className="flex-1 py-2 px-3 rounded-lg text-sm font-semibold bg-white/5 text-white/45 border border-white/10 hover:bg-white/10 transition-colors"
                  >
                    Return to issuer
                  </button>
                </div>
              </div>
            )}

            {/* Normal sign flow - hidden while waiting for no-path choice */}
            {!noSwapPath && (
              <>
                {/* Merge-specific warning */}
                {isMerge && (
                  <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 text-sm">
                    <p className="font-semibold text-destructive mb-1">
                      This action is permanent and irreversible.
                    </p>
                    <p className="text-white/60">
                      After this step, the account will be removed from the Stellar ledger. Verify
                      your destination address carefully before signing.
                    </p>
                  </div>
                )}

                {/* XDR preview */}
                {step.txXdr && <XdrPreviewModal xdr={step.txXdr} network={network} />}

                {/* Secret key */}
                <SecretKeyInput
                  secretKeyRef={secretKeyRef}
                  onValidityChange={setKeyValid}
                  disabled={isExecuting}
                />

                {/* Wallet extension - coming soon */}
                <div className="flex items-center gap-2 text-white/25">
                  <div className="h-px flex-1 bg-white/10" />
                  <span className="text-xs">or</span>
                  <div className="h-px flex-1 bg-white/10" />
                </div>
                <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 opacity-45 cursor-not-allowed select-none">
                  <Wallet className="h-4 w-4 shrink-0 text-white/50" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-white/70">Sign with browser wallet</p>
                    <p className="text-xs text-white/40">
                      Freighter, xBull, and others via Stellar Wallets Kit
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full border border-white/15 px-2 py-0.5 text-[0.6rem] font-medium uppercase tracking-wide text-white/35">
                    Soon
                  </span>
                </div>

                {/* Confirmation checkbox */}
                <label className="flex items-start gap-3 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    disabled={isExecuting}
                    className="mt-0.5 accent-stellar"
                  />
                  <span className="text-sm text-white/60">{confirmText}</span>
                </label>

                {/* Progress or sign button */}
                {progressStatus ? (
                  <ProgressIndicator status={progressStatus} />
                ) : (
                  <button
                    onClick={onSign}
                    disabled={!canSign}
                    className={cn(
                      "w-full py-3 px-4 rounded-xl font-semibold text-sm transition-all",
                      "flex items-center justify-center gap-2",
                      isMerge
                        ? "bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-40"
                        : "bg-stellar text-black hover:bg-stellar/90 hover:shadow-[0_0_28px_-6px_hsl(var(--stellar)/0.7)] disabled:opacity-40 disabled:shadow-none",
                      !canSign && "cursor-not-allowed"
                    )}
                  >
                    {isMerge ? "Sign and merge account" : "Sign and submit"}
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
