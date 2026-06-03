"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, Zap, GitMerge, AlertOctagon, RotateCcw, X } from "lucide-react";
import type { Network } from "@/config/networks";
import AccountEntryForm from "@/components/account-entry/AccountEntryForm";
import NetworkStats from "@/components/stats/NetworkStats";
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
    <div className="max-w-2xl mx-auto px-4 py-12">
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
      <div className="text-center mb-10">
        <div className="inline-flex items-center gap-2 bg-secondary border border-border rounded-full px-3 py-1 text-xs text-muted-foreground mb-4">
          <ShieldCheck className="h-3.5 w-3.5 text-stellar" />
          Non-custodial · Client-side signing only
        </div>
        <h1 className="text-3xl font-bold tracking-tight mb-3">Merge your Stellar account</h1>
        <p className="text-muted-foreground text-base leading-relaxed max-w-lg mx-auto">
          Safely wind down a Stellar account and recover all locked XLM reserves. Remove trustlines,
          cancel offers, and merge your account in a guided, step-by-step process.
        </p>
      </div>

      {/* Features row */}
      <div className="grid grid-cols-3 gap-3 mb-10">
        {[
          { icon: Zap, label: "Step-by-step", desc: "Guided execution" },
          { icon: ShieldCheck, label: "Non-custodial", desc: "Keys never leave your browser" },
          { icon: GitMerge, label: "Exchange-friendly", desc: "Intermediary account support" },
        ].map(({ icon: Icon, label, desc }) => (
          <div key={label} className="bg-card border border-border rounded-lg p-3 text-center">
            <Icon className="h-5 w-5 text-stellar mx-auto mb-1.5" />
            <p className="text-xs font-medium">{label}</p>
            <p className="text-xs text-muted-foreground">{desc}</p>
          </div>
        ))}
      </div>

      {/* Live stats */}
      <NetworkStats />

      {/* Warning */}
      <div className="flex items-start gap-2.5 bg-warning/10 border border-warning/20 rounded-lg p-3 mb-8 text-sm">
        <AlertOctagon className="h-4 w-4 text-warning mt-0.5 shrink-0" />
        <p className="text-muted-foreground">
          <span className="text-warning font-medium">Irreversible action.</span> An Account Merge
          transfers the XLM balance to the destination and removes the source account from the
          Stellar ledger. Make sure you have a working destination address before proceeding.
        </p>
      </div>

      {/* Form */}
      <div className="bg-card border border-border rounded-xl p-6">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-5">
          Account details
        </h2>
        <AccountEntryForm />
      </div>
    </div>
  );
}
