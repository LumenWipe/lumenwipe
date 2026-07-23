import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import Faq from "@/components/marketing/Faq";

export const metadata: Metadata = {
  title: "FAQ - LumenWipe",
  description:
    "Answers to the common questions about closing a Stellar account with LumenWipe: non-custodial signing, irreversibility, exchange merges, Soroban DeFi, supported wallets and resumable sessions.",
};

export default function FaqPage() {
  return (
    <section className="mx-auto max-w-3xl px-5 py-20 lg:px-8 lg:py-24">
      <div className="text-center">
        <span className="mkt-eyebrow inline-flex items-center gap-2 text-white/55">
          <span className="h-px w-5 bg-stellar/60" />
          FAQ
        </span>
        <h1 className="mkt-display mt-4 text-4xl font-bold text-white sm:text-5xl">
          Questions, answered.
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-white/70">
          Closing an account is irreversible. Here&apos;s exactly how LumenWipe keeps it safe.
        </p>
      </div>

      <div className="mt-12">
        <Faq />
      </div>

      <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/mainnet"
          className="group inline-flex items-center gap-2 rounded-xl bg-value px-5 py-3 text-sm font-semibold text-[hsl(var(--value-foreground))] transition-all hover:bg-value/90 hover:shadow-[0_12px_30px_-14px_hsl(var(--value)/0.7)]"
        >
          Open the app
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
        <a
          href="https://docs.lumenwipe.com"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.02] px-5 py-3 text-sm font-semibold text-white/85 transition-colors hover:border-white/30 hover:text-white"
        >
          Read the documentation
        </a>
      </div>
    </section>
  );
}
