import type { Metadata } from "next";
import { pageMetadata } from "@/lib/site/pages";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import Faq from "@/components/marketing/Faq";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = pageMetadata({
  path: "/faq",
  title: "FAQ",
  description:
    "Answers to the common questions about closing a Stellar account with LumenWipe: non-custodial signing, irreversibility, exchange merges, Soroban DeFi, supported wallets and resumable sessions.",
});

export default function FaqPage() {
  return (
    <section className="mx-auto max-w-3xl px-5 py-20 lg:px-8 lg:py-24">
      <div className="text-center">
        <span className="mkt-eyebrow inline-flex items-center gap-2 text-fg-muted">
          <span className="h-px w-5 bg-accent/60" />
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
        <Button asChild size="lg" className="group">
          <Link href="/mainnet">
            Open the app
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </Button>
        <Button asChild size="lg" variant="secondary">
          <a href="https://docs.lumenwipe.com" target="_blank" rel="noopener noreferrer">
            Read the documentation
          </a>
        </Button>
      </div>
    </section>
  );
}
