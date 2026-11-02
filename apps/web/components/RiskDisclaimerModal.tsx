"use client";

import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  BookX,
  Database,
  Target,
  GitMerge,
  KeyRound,
  Unlink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";

const STORAGE_KEY = "lumenwipe_risk_accepted";

const CONFIRMED_FEATURES = [
  { icon: GitMerge, label: "Account merge (direct and via exchange relay account)" },
  { icon: Unlink, label: "Trustline removal" },
  { icon: ArrowLeftRight, label: "Asset-to-XLM conversion via DEX path payments" },
  { icon: BookX, label: "DEX offer cancellation" },
  { icon: Database, label: "Data entry removal" },
  { icon: KeyRound, label: "Signer normalization and multisig cleanup" },
  { icon: Target, label: "Claimable balance claiming" },
];

type Decision = "unknown" | "pending" | "accepted";

function subscribeToNothing(): () => void {
  return () => {};
}

function readStoredDecision(): Decision {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) ? "accepted" : "pending";
  } catch {
    return "pending";
  }
}

function readServerDecision(): Decision {
  return "unknown";
}

function rememberAcceptance(): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Unavailable storage only means the notice shows again after a reload.
  }
}

/** Keeps `children` inert, from the server's HTML on, until the notice is known to be accepted. */
export default function RiskDisclaimerModal({ children }: { children: ReactNode }) {
  const stored = useSyncExternalStore(subscribeToNothing, readStoredDecision, readServerDecision);
  const [acceptedNow, setAcceptedNow] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const decision = acceptedNow ? "accepted" : stored;

  function handleAccept() {
    rememberAcceptance();
    setAcceptedNow(true);
  }

  return (
    <>
      <div className="contents" inert={decision !== "accepted"}>
        {children}
      </div>
      {decision === "pending" && (
        <Dialog dismissible={false} initialFocusRef={bodyRef}>
          <div className="flex items-start gap-3 border-b border-white/10 px-5 py-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-warning/15 text-warning">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold text-white">
                Beta Software - Use at Your Own Risk
              </DialogTitle>
              <p className="mt-0.5 text-xs text-fg-subtle">LumenWipe is under active development</p>
            </div>
          </div>

          <DialogBody
            ref={bodyRef}
            className="px-5 py-4 space-y-4 text-sm text-white/65 leading-relaxed"
          >
            <DialogDescription>
              Closing a Stellar account is{" "}
              <span className="font-medium text-white/80">permanent and irreversible</span> - always
              verify your destination address before signing. Bugs may still exist; use at your own
              risk.
            </DialogDescription>

            <div>
              <p className="text-xs uppercase tracking-wider text-fg-subtle mb-2.5 font-medium">
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

            <p className="text-xs text-fg-subtle">
              Soroban DeFi positions, tested on testnet: Blend pool positions (supply, collateral,
              debt) leave with the close, BLND emissions claimed first; so do Aquarius liquidity
              pools, with their AQUA rewards, and Soroswap liquidity pools. Blend backstop deposits
              only leave once their withdrawal cooldown has run out - Blend makes you queue and
              wait. Aquarius concentrated-liquidity positions, Phoenix and FxDAO are detected but
              not exited. Anything that cannot be exited blocks the close by name until you handle
              it yourself.
            </p>
          </DialogBody>

          <DialogFooter className="block border-t border-white/10 px-5 py-4">
            <Button onClick={handleAccept} className="w-full">
              I understand, continue
            </Button>
            <p className="mt-2.5 text-center text-[0.68rem] text-fg-subtle">
              This notice appears once per browser session.
            </p>
          </DialogFooter>
        </Dialog>
      )}
    </>
  );
}
