"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, GitMerge, Unlink, X } from "lucide-react";

const STORAGE_KEY = "lumenwipe_risk_accepted";

export default function RiskDisclaimerModal() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const accepted = sessionStorage.getItem(STORAGE_KEY);
    if (!accepted) setVisible(true);
  }, []);

  function handleAccept() {
    sessionStorage.setItem(STORAGE_KEY, "1");
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      {/* Panel */}
      <div className="relative w-full max-w-md rounded-2xl border border-white/15 bg-[#0d0d14] shadow-2xl">
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-white/10 px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-white">
              Beta Software — Use at Your Own Risk
            </h2>
            <p className="mt-0.5 text-xs text-white/45">LumenWipe is under active development</p>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4 text-sm text-white/65 leading-relaxed">
          <p>
            LumenWipe is currently in{" "}
            <span className="text-amber-400 font-medium">public beta</span>. While it has been
            tested, bugs and unexpected behavior may still occur. Closing a Stellar account is{" "}
            <span className="font-medium text-white/80">permanent and irreversible</span> — always
            verify your destination address before signing any transaction.
          </p>

          <div>
            <p className="text-xs uppercase tracking-wider text-white/35 mb-2 font-medium">
              What is confirmed to work
            </p>
            <ul className="space-y-2">
              <li className="flex items-start gap-2.5">
                <GitMerge className="h-4 w-4 text-stellar shrink-0 mt-0.5" />
                <span>
                  <span className="font-medium text-white/80">Account merge</span> — direct merge
                  and merge via intermediary account (for exchange addresses).
                </span>
              </li>
              <li className="flex items-start gap-2.5">
                <Unlink className="h-4 w-4 text-stellar shrink-0 mt-0.5" />
                <span>
                  <span className="font-medium text-white/80">Trustline removal</span> — clearing
                  balances and removing all trustlines from an account.
                </span>
              </li>
            </ul>
          </div>

          <p className="text-xs text-white/40">
            Soroban DeFi position unwinding (Blend, Aquarius, etc.) is under development and not yet
            available.
          </p>
        </div>

        {/* Footer */}
        <div className="border-t border-white/10 px-5 py-4">
          <button
            onClick={handleAccept}
            className="w-full rounded-xl bg-stellar py-2.5 text-sm font-semibold text-black transition-all hover:bg-stellar/90 hover:shadow-[0_0_24px_-4px_hsl(var(--stellar)/0.6)]"
          >
            I understand, continue
          </button>
          <p className="mt-2.5 text-center text-[0.68rem] text-white/30">
            This notice will appear once per browser session.
          </p>
        </div>
      </div>
    </div>
  );
}
