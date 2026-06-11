import type { Metadata } from "next";
import PlaygroundClient from "@/components/playground/PlaygroundClient";

export const metadata: Metadata = {
  title: "Playground - LumenWipe",
  description:
    "Watch LumenWipe work on a real testnet account: one click buries a demo account in junk trustlines, offers and data entries - then the demolition engine takes it all apart, live on-chain.",
};

export default function PlaygroundPage() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 pb-24 pt-16 sm:px-6">
      <div className="mb-10 max-w-2xl">
        <p className="mkt-eyebrow mb-3 text-stellar">Testnet playground</p>
        <h1 className="mkt-display text-4xl text-white sm:text-5xl">
          Trash an account. Then watch it vanish.
        </h1>
        <p className="mt-4 text-base leading-relaxed text-white/60">
          Everything here happens on the Stellar testnet with a throwaway custodial account - no
          wallet, no risk, real transactions. Every animation is backed by an on-chain transaction
          you can verify in the explorer.
        </p>
      </div>
      <PlaygroundClient />
    </section>
  );
}
