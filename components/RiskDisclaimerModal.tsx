"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  BookX,
  Database,
  Gift,
  GitMerge,
  KeyRound,
  Unlink,
} from "lucide-react";

const STORAGE_KEY = "lumenwipe_risk_accepted";

const CONFIRMED_FEATURES = [
  { icon: GitMerge, label: "Account merge (direct and via exchange intermediary)" },
  { icon: Unlink, label: "Trustline removal" },
  { icon: ArrowLeftRight, label: "Asset-to-XLM conversion via DEX path payments" },
  { icon: BookX, label: "DEX offer cancellation" },
  { icon: Database, label: "Data entry removal" },
  { icon: KeyRound, label: "Signer normalization and multisig cleanup" },
  { icon: Gift, label: "Claimable balance claiming" },
];

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
              Beta Software - Use at Your Own Risk
            </h2>
            <p className="mt-0.5 text-xs text-white/45">LumenWipe is under active development</p>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4 text-sm text-white/65 leading-relaxed">
          <p>
            Closing a Stellar account is{" "}
            <span className="font-medium text-white/80">permanent and irreversible</span> - always
            verify your destination address before signing. Bugs may still exist; use at your own
            risk.
          </p>

          <div>
            <p className="text-xs uppercase tracking-wider text-white/35 mb-2.5 font-medium">
              Confirmed working
            </p>
            <ul className="space-y-2">
              {CONFIRMED_FEATURES.map(({ icon: Icon, label }) => (
                <li key={label} className="flex items-center gap-2.5">
                  <Icon className="h-4 w-4 text-stellar shrink-0" />
                  <span className="text-white/75">{label}</span>
                </li>
              ))}
            </ul>
          </div>

          <p className="text-xs text-white/40">
            Soroban DeFi positions (Blend, Aquarius, etc.) are not yet supported.
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
            This notice appears once per browser session.
          </p>
        </div>
      </div>
    </div>
  );
}
