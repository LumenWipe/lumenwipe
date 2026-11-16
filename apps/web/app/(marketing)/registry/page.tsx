import type { Metadata } from "next";
import { pageMetadata } from "@/lib/site/pages";
import RegistryClient from "@/components/marketing/registry/RegistryClient";

export const metadata: Metadata = pageMetadata({
  path: "/registry",
  title: "Exchange registry",
  description:
    "The exchanges LumenWipe recognizes, the memo rule each one enforces, which DeFi protocols it can exit today, and when each list was last checked.",
});

export default function RegistryPage() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-24">
      <div className="max-w-2xl">
        <span className="mkt-eyebrow inline-flex items-center gap-2 text-fg-muted">
          <span className="h-px w-5 bg-accent/60" />
          Registry
        </span>
        <h1 className="mkt-display mt-4 text-4xl font-bold text-white sm:text-5xl">
          What LumenWipe treats as an exchange.
        </h1>
        <p className="mt-5 text-body leading-relaxed text-white/70">
          A close into an exchange needs the memo type that exchange enforces, and most exchanges
          need the balance passed on through the shared relay account. This page lists the exchanges
          the app recognizes, the rule it applies to each, and which DeFi protocols it can exit
          today, each with the date it was last checked.
        </p>
        <p className="mt-4 text-body leading-relaxed text-white/70">
          The addresses below are the ones the app recognizes, not addresses to send to. Always take
          your deposit address and memo from your exchange.
        </p>
      </div>
      <RegistryClient />
    </section>
  );
}
