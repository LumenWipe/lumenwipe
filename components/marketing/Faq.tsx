"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

type Item = { q: string; a: React.ReactNode };

const ITEMS: Item[] = [
  {
    q: "Is LumenWipe really non-custodial?",
    a: (
      <>
        Yes. Every transaction is built and signed in your browser, through your wallet or an
        in-memory secret key. Your private key never reaches our servers. The backend is read-only
        and stateless. It aggregates on-chain data and is never in the signing path, so no operator
        (including us) can move your funds.
      </>
    ),
  },
  {
    q: "Is closing an account reversible?",
    a: (
      <>
        No. <span className="mkt-mono text-white/80">ACCOUNT_MERGE</span> permanently removes the
        source account from the Stellar ledger. Because the action is irreversible, LumenWipe shows
        the complete plan up front, simulates each step, and asks for explicit confirmation (with
        the raw XDR available to review) before every signature.
      </>
    ),
  },
  {
    q: "How much XLM will I actually get back?",
    a: (
      <>
        Everything recoverable. Stellar requires a <span className="text-value">1 XLM</span> minimum
        balance (two base reserves) plus <span className="text-value">0.5 XLM</span> for each
        subentry: every trustline, open offer, data entry, and extra signer. LumenWipe unwinds all
        of them to release those reserves, converts leftover tokens to XLM, and sweeps the full
        balance to your destination.
      </>
    ),
  },
  {
    q: "Can I send the recovered XLM straight to an exchange?",
    a: (
      <>
        Yes. Exchanges don&apos;t support{" "}
        <span className="mkt-mono text-white/80">ACCOUNT_MERGE</span>, so LumenWipe routes the final
        merge through a shared mediator account in one atomic transaction and pays out to your
        deposit address with the correct memo, so you recover essentially all of your XLM. Known
        exchanges are validated against a registry that enforces the required memo type, so deposits
        don&apos;t go missing.
      </>
    ),
  },
  {
    q: "Does it handle Soroban DeFi positions?",
    a: (
      <>
        This is where LumenWipe goes furthest. It detects and exits positions across{" "}
        <span className="text-white/80">Blend, Aquarius, Soroswap, Phoenix and FxDAO</span>, on top
        of classic DEX offers and AMM pools, using OctoPos for position detection. The full classic
        wind-down is live today; complete DeFi coverage is on the way.
      </>
    ),
  },
  {
    q: "Which wallets are supported?",
    a: (
      <>
        Any SEP-43 wallet through{" "}
        <span className="mkt-mono text-white/80">stellar-wallets-kit</span>: Freighter, xBull,
        Albedo, LOBSTR, Hana, WalletConnect and more. Power users can also use an advanced
        secret-key mode where the key is held in memory only for the duration of the close, never
        persisted and never sent to a server, and wiped when you finish, abort, navigate away, or
        click &quot;Forget key&quot;.
      </>
    ),
  },
  {
    q: "What if I close the tab in the middle?",
    a: (
      <>
        Nothing is lost. The wind-down is an explicit state machine persisted in IndexedDB (never
        your keys). When you return, the session is reconciled against on-chain state and any step
        already completed is skipped, so nothing double-executes.
      </>
    ),
  },
  {
    q: "Mainnet or testnet?",
    a: (
      <>
        Both. Run the entire flow on testnet with no real funds at risk to see exactly what will
        happen, then switch to mainnet for the real close. Closing an account on mainnet is
        irreversible and entirely at your own risk: review each step, the simulation result, and the
        destination address before you sign anything.
      </>
    ),
  },
];

export default function Faq() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <div className="divide-y divide-white/8 overflow-hidden rounded-2xl border border-white/10 bg-[#0a0a10]/60">
      {ITEMS.map((item, i) => {
        const isOpen = open === i;
        return (
          <div key={item.q}>
            <button
              onClick={() => setOpen(isOpen ? null : i)}
              aria-expanded={isOpen}
              className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-white/[0.02] sm:px-6 sm:py-5"
            >
              <span
                className={`text-[0.98rem] font-medium transition-colors ${
                  isOpen ? "text-white" : "text-white/80"
                }`}
              >
                {item.q}
              </span>
              <Plus
                className={`h-4 w-4 shrink-0 text-stellar transition-transform duration-300 ${
                  isOpen ? "rotate-45" : ""
                }`}
              />
            </button>
            <div
              className={`grid transition-all duration-300 ease-out ${
                isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
              }`}
            >
              <div className="overflow-hidden">
                <p className="px-5 pb-5 pr-10 text-sm leading-relaxed text-white/85 sm:px-6 sm:pb-6">
                  {item.a}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
