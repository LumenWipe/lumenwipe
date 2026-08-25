import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

export const metadata: Metadata = {
  title: "Playground - LumenWipe",
  description:
    "Try the exact same close flow as the app on a disposable Stellar testnet account - no wallet, no real funds.",
};

const btnGold =
  "inline-flex items-center gap-2 rounded-xl bg-value px-5 py-3 text-sm font-semibold text-[hsl(var(--value-foreground))] transition-all hover:bg-value/90 hover:shadow-[0_12px_30px_-14px_hsl(var(--value)/0.7)]";

export default function PlaygroundPage() {
  return (
    <section className="mx-auto w-full max-w-2xl px-4 pb-24 pt-24 text-center sm:px-6">
      <p className="mkt-eyebrow mb-3 text-stellar">Testnet playground</p>
      <h1 className="mkt-display text-4xl text-white sm:text-5xl">Try the exact same close, risk-free</h1>
      <p className="mt-4 text-base leading-relaxed text-white/70">
        The playground runs on the LumenWipe API and walks the identical close flow as the app -
        trustlines, offers, data entries, signers, the merge - against a disposable testnet account
        we hand you. No wallet, no real funds, nothing to lose.
      </p>
      <a
        href="https://playground.lumenwipe.com"
        target="_blank"
        rel="noopener noreferrer"
        className={`group mt-8 ${btnGold}`}
      >
        Open the playground
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </a>
      <div className="mt-6">
        <Link
          href="/testnet"
          className="inline-block text-sm text-stellar underline-offset-2 hover:underline"
        >
          Or close your own testnet account →
        </Link>
      </div>
    </section>
  );
}
