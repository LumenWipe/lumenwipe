import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Playground - LumenWipe",
  description: "The interactive testnet playground is being rebuilt on the LumenWipe API.",
};

export default function PlaygroundPage() {
  return (
    <section className="mx-auto w-full max-w-2xl px-4 pb-24 pt-24 text-center sm:px-6">
      <p className="mkt-eyebrow mb-3 text-stellar">Testnet playground</p>
      <h1 className="mkt-display text-4xl text-white sm:text-5xl">Coming back soon</h1>
      <p className="mt-4 text-base leading-relaxed text-white/70">
        We&apos;re rebuilding the interactive playground on top of the LumenWipe API so it runs the
        exact same close flow as the app - no separate account-closing logic in the browser. It will
        be back shortly.
      </p>
      <Link
        href="/testnet"
        className="mt-8 inline-block text-sm text-stellar underline-offset-2 hover:underline"
      >
        Try the tool on testnet →
      </Link>
    </section>
  );
}
