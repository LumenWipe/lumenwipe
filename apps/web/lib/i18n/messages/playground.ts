import type { Locale } from "@/lib/i18n/locale";

const en = {
  metadata: {
    title: "Playground",
    description:
      "Try the exact same close flow as the app on a disposable Stellar testnet account - no wallet, no real funds.",
  },
  eyebrow: "Testnet playground",
  heading: "Try the exact same close, risk-free",
  body: "The playground runs on the LumenWipe API and walks the identical close flow as the app - trustlines, offers, data entries, signers, the merge - against a disposable testnet account we hand you. No wallet, no real funds, nothing to lose.",
  open: "Open the playground",
  ownAccount: "Or close your own testnet account →",
};

export type PlaygroundCopy = typeof en;

export const PLAYGROUND: Record<Locale, PlaygroundCopy> = { en };
