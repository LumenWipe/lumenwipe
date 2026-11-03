"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ShieldCheck, Zap, GitMerge, AlertOctagon, RotateCcw, ShieldOff, X } from "lucide-react";
import type { Network } from "@/config/networks";
import AccountEntryForm from "@/components/account-entry/AccountEntryForm";
import { useSessionRecovery } from "@/hooks/useSessionRecovery";
import { deleteSettledSession } from "@/lib/session/store";
import { settleRecorded } from "@/lib/session/settle-unconfirmed";
import { interruptedCloseNotice } from "@/lib/session/recorded-progress";
import {
  CHECK_FAILED_NOTICE,
  CLOSE_FINISHED_NOTICE,
  STILL_UNCONFIRMED_NOTICE,
  UNCONFIRMED_NOTICE,
} from "@/lib/utils/user-error";
import { useDemolishStore } from "@/store/demolish";
import { getMemoRequirement } from "@/lib/exchange-registry";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardTitle, cardVariants } from "@/components/ui/card";
import { cn } from "@/lib/utils/cn";

const RECORDED_NOTICES = {
  closed: CLOSE_FINISHED_NOTICE,
  failed: CHECK_FAILED_NOTICE,
  released: null,
};

export default function HomePage({ params }: { params: Promise<{ network: Network }> }) {
  const { network } = use(params);
  const router = useRouter();
  const { session, checked, clearSession, reload } = useSessionRecovery(network);
  const { setAddresses, setMediatorRequired, restoreSession } = useDemolishStore();
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [settled, setSettled] = useState(false);
  // Read once and cleared, so each is shown on the visit it was raised for and not again.
  const [interrupted] = useState(() => useDemolishStore.getState().executeInterrupted);
  const [reloadNotice] = useState(() => useDemolishStore.getState().reloadNotice);
  useEffect(() => {
    useDemolishStore.getState().setExecuteInterrupted(false);
    useDemolishStore.getState().setReloadNotice(null);
  }, []);
  const unconfirmed = session && !settled ? session.unconfirmed : undefined;

  async function handleCheck() {
    if (!session) return;
    setChecking(true);
    const outcome = await settleRecorded(session, network);
    setChecking(false);
    if (outcome === "unknown") return setRecoveryNotice(STILL_UNCONFIRMED_NOTICE);
    setRecoveryNotice(RECORDED_NOTICES[outcome]);
    if (outcome === "closed") clearSession();
    else setSettled(true);
  }

  function handleResume() {
    if (!session) return;
    // Prefer the persisted memoType; fall back to the registry for records created
    // before memoType was added to SessionRecord (backward-compat).
    let memoType = session.memoType ?? undefined;
    if (!memoType && session.memo) {
      const req = getMemoRequirement(session.destinationAddress);
      if (req.requiresMemo) memoType = req.memoType ?? undefined;
    }
    // Restore addresses into the store so PlanView can pre-fill the destination.
    setAddresses(
      session.sourceAddress,
      session.destinationAddress,
      session.memo ?? undefined,
      memoType
    );
    setMediatorRequired(session.mediatorRequired);
    // Reuse the existing ID: subsequent saves overwrite the same record instead
    // of creating a second "in_progress" entry that is never cleaned up.
    restoreSession(session.id);
    // Navigate to analyze so a fresh plan is built from current on-chain state.
    // /execute requires an executionPlan in the store, which only exists after the
    // user confirms the plan in the analyze → PlanView step.
    router.push(`/${network}/analyze?source=${encodeURIComponent(session.sourceAddress)}`);
  }

  async function handleDismiss() {
    if (!session || unconfirmed) return;
    if (await deleteSettledSession(session.id)) clearSession();
    else await reload();
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      {reloadNotice && (
        <p role="status" className="mb-6 text-sm text-white/70">
          {reloadNotice}
        </p>
      )}
      {checked && session && interrupted && (
        <p role="status" className="mb-2 text-sm text-white/70">
          {interruptedCloseNotice(session)}
        </p>
      )}
      {/* Session recovery banner */}
      {recoveryNotice && (
        <p role="status" className="mb-6 text-sm text-white/70">
          {recoveryNotice}
        </p>
      )}
      {checked && session && unconfirmed && !recoveryNotice && (
        <p className="mb-2 text-sm text-white/70">{UNCONFIRMED_NOTICE}</p>
      )}
      {checked && session && (
        <div className="flex items-center justify-between gap-3 bg-accent/10 border border-accent/30 rounded-lg px-4 py-3 mb-6 text-sm">
          <div className="flex items-center gap-2 min-w-0">
            <RotateCcw className="h-4 w-4 text-accent shrink-0" />
            <span className="text-fg-muted truncate">
              In-progress account merge found for{" "}
              <span className="font-mono text-xs">{session.sourceAddress.slice(0, 8)}…</span>
            </span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {unconfirmed ? (
              <button
                onClick={() => void handleCheck()}
                disabled={checking}
                className="text-accent font-medium hover:underline disabled:opacity-50"
              >
                Check again
              </button>
            ) : (
              <button onClick={handleResume} className="text-accent font-medium hover:underline">
                Resume
              </button>
            )}
            {!unconfirmed && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Dismiss the in-progress close"
                onClick={handleDismiss}
                icon={<X className="h-4 w-4" />}
              />
            )}
          </div>
        </div>
      )}

      {/* Hero */}
      <div className="text-center mb-6">
        <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 mkt-mono text-caption uppercase tracking-wide text-white/65 mb-3">
          <ShieldCheck className="h-3.5 w-3.5 text-accent" />
          Non-custodial · Client-side signing only
        </div>
        <h1 className="mkt-display text-3xl sm:text-4xl font-extrabold tracking-tight mb-2 text-white">
          Close your Stellar account
        </h1>
        <p className="text-fg-muted text-sm sm:text-base leading-relaxed max-w-lg mx-auto">
          Recover all the XLM locked in reserves. Remove trustlines, cancel offers, and merge your
          account in a guided, step-by-step flow, signed entirely in your browser.
        </p>
      </div>

      {/* Form */}
      <Card className="mb-6 p-6">
        <CardTitle className="mb-5">Account details</CardTitle>
        <AccountEntryForm />
      </Card>

      {/* Warning */}
      <Callout
        tone="warning"
        announce={false}
        icon={<AlertOctagon className="h-4 w-4" />}
        className="mb-8"
      >
        <p className="text-fg-muted">
          <span className="text-warning font-medium">Irreversible action.</span> An Account Merge
          transfers the XLM balance to the destination and removes the source account from the
          Stellar ledger. Make sure you have a working destination address before proceeding.
        </p>
      </Callout>

      {/* Features row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { icon: Zap, label: "Step-by-step", desc: "Guided execution" },
          { icon: ShieldCheck, label: "Non-custodial", desc: "Keys never leave your browser" },
          { icon: GitMerge, label: "Exchange-friendly", desc: "Relay account support" },
        ].map(({ icon: Icon, label, desc }) => (
          <Card key={label} className="p-3.5 text-center">
            <Icon className="h-5 w-5 text-accent mx-auto mb-1.5" />
            <p className="text-xs font-medium text-white">{label}</p>
            <p className="text-xs text-fg-subtle">{desc}</p>
          </Card>
        ))}
      </div>

      {/* Receive-as row - XLM active; USDC coming soon */}
      <Card className="mt-3 flex items-center gap-3 px-4 py-3">
        <span className="text-xs text-fg-subtle shrink-0">Receive as</span>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent">
            XLM
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          </div>
          <div className="flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-fg-subtle select-none">
            USDC
            <span className="rounded-full border border-white/15 px-1.5 py-0.5 text-caption uppercase tracking-wide text-fg-subtle">
              Soon
            </span>
          </div>
        </div>
      </Card>

      {/* Standalone security utility, independent of closing an account. */}
      <Link
        href={`/${network}/allowances`}
        className={cn(
          cardVariants(),
          "mt-3 flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors hover:bg-surface-raised"
        )}
      >
        <span className="flex items-center gap-2.5 min-w-0">
          <ShieldOff className="h-4 w-4 text-accent shrink-0" />
          <span className="min-w-0">
            <span className="block font-medium text-white">Allowance inspector</span>
            <span className="block text-xs text-fg-subtle">
              Audit and revoke token approvals - no close required
            </span>
          </span>
        </span>
        <span className="shrink-0 text-fg-disabled">→</span>
      </Link>
    </div>
  );
}
