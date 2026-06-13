"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import {
  ShieldCheck,
  Zap,
  GitMerge,
  AlertOctagon,
  RotateCcw,
  X,
  FlaskConical,
  ArrowRight,
} from "lucide-react";
import Link from "next/link";
import type { Network } from "@/config/networks";
import AccountEntryForm from "@/components/account-entry/AccountEntryForm";
import { useSessionRecovery } from "@/hooks/useSessionRecovery";
import { deleteSession } from "@/lib/session/store";
import { useDemolishStore } from "@/store/demolish";
import { getMemoRequirement } from "@/lib/exchange-registry";

export default function HomePage({ params }: { params: Promise<{ network: Network }> }) {
  const { network } = use(params);
  const router = useRouter();
  const { session, checked, clearSession } = useSessionRecovery(network);
  const { setAddresses, setMediatorRequired, initSession } = useDemolishStore();

  function handleResume() {
    if (!session) return;
    const memoReq = getMemoRequirement(session.destinationAddress);
    const memoType = memoReq.requiresMemo ? (memoReq.memoType ?? undefined) : undefined;
    setAddresses(
      session.sourceAddress,
      session.destinationAddress,
      session.memo ?? undefined,
      memoType
    );
    setMediatorRequired(!!session.mediatorPublicKey, session.mediatorPublicKey ?? undefined);
    initSession();
    router.push(`/${network}/execute`);
  }

  async function handleDismiss() {
    if (!session) return;
    await deleteSession(session.id);
    clearSession();
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      {/* Session recovery banner */}
      {checked && session && (
        <div className="flex items-center justify-between gap-3 bg-stellar/10 border border-stellar/30 rounded-lg px-4 py-3 mb-6 text-sm">
          <div className="flex items-center gap-2 min-w-0">
            <RotateCcw className="h-4 w-4 text-stellar shrink-0" />
            <span className="text-muted-foreground truncate">
              In-progress account merge found for{" "}
              <span className="font-mono text-xs">{session.sourceAddress.slice(0, 8)}…</span>
            </span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button onClick={handleResume} className="text-stellar font-medium hover:underline">
              Resume
            </button>
            <button
              onClick={handleDismiss}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Hero */}
      <div className="text-center mb-6">
        <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 mkt-mono text-[0.66rem] uppercase tracking-wider text-white/65 mb-3">
          <ShieldCheck className="h-3.5 w-3.5 text-stellar" />
          Non-custodial · Client-side signing only
        </div>
        <h1 className="mkt-display text-3xl sm:text-4xl font-extrabold tracking-tight mb-2 text-white">
          Wind down your Stellar account
        </h1>
        <p className="text-white/55 text-sm sm:text-base leading-relaxed max-w-lg mx-auto">
          Recover all the XLM locked in reserves. Remove trustlines, cancel offers, and merge your
          account in a guided, step-by-step flow, signed entirely in your browser.
        </p>
      </div>

      {/* Form */}
      <div className="mkt-panel rounded-2xl p-6 mb-6">
        <h2 className="mkt-eyebrow text-white/45 mb-5">Account details</h2>
        <AccountEntryForm />
      </div>

      {/* Warning */}
      <div className="flex items-start gap-2.5 bg-warning/10 border border-warning/25 rounded-xl p-3.5 mb-8 text-sm">
        <AlertOctagon className="h-4 w-4 text-warning mt-0.5 shrink-0" />
        <p className="text-white/60">
          <span className="text-warning font-medium">Irreversible action.</span> An Account Merge
          transfers the XLM balance to the destination and removes the source account from the
          Stellar ledger. Make sure you have a working destination address before proceeding.
        </p>
      </div>

      {/* Features row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { icon: Zap, label: "Step-by-step", desc: "Guided execution" },
          { icon: ShieldCheck, label: "Non-custodial", desc: "Keys never leave your browser" },
          { icon: GitMerge, label: "Exchange-friendly", desc: "Intermediary account support" },
        ].map(({ icon: Icon, label, desc }) => (
          <div key={label} className="mkt-panel rounded-xl p-3.5 text-center">
            <Icon className="h-5 w-5 text-stellar mx-auto mb-1.5" />
            <p className="text-xs font-medium text-white">{label}</p>
            <p className="text-xs text-white/45">{desc}</p>
          </div>
        ))}
      </div>

      {/* Receive-as row - XLM active; USDC coming soon */}
      <div className="mt-3 flex items-center gap-3 mkt-panel rounded-xl px-4 py-3">
        <span className="text-xs text-white/40 shrink-0">Receive as</span>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-stellar/40 bg-stellar/10 px-3 py-1.5 text-xs font-medium text-stellar">
            XLM
            <span className="h-1.5 w-1.5 rounded-full bg-stellar" />
          </div>
          <div className="flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-white/30 opacity-50 select-none">
            USDC
            <span className="rounded-full border border-white/15 px-1.5 py-0.5 text-[0.55rem] uppercase tracking-wide text-white/30">
              Soon
            </span>
          </div>
        </div>
      </div>

      {network === "testnet" && (
        <Link
          href="/playground"
          className="mt-4 flex items-center justify-between gap-4 mkt-panel rounded-xl px-4 py-3.5 group hover:border-stellar/30 transition-colors"
        >
          <div className="flex items-center gap-3 min-w-0">
            <FlaskConical className="h-4 w-4 text-stellar/60 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-white/75">No account to test with?</p>
              <p className="text-xs text-white/40 truncate">
                Try the Playground - we create a demo and walk you through the full flow.
              </p>
            </div>
          </div>
          <ArrowRight className="h-4 w-4 text-white/25 group-hover:text-stellar/60 transition-colors shrink-0" />
        </Link>
      )}
    </div>
  );
}
