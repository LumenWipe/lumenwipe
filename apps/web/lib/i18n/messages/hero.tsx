import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n/locale";

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const en = {
  console: {
    account: "account · GABC…WXYZ",
    scanning: "scanning",
    complete: "complete",
    steps: {
      signers: "Normalize signers",
      data: "Clear data entries",
      offers: "Cancel open offers",
      convert: "Convert assets to XLM",
      trustlines: "Remove trustlines",
      merge: "Merge to destination",
    },
    recoverable: "Recoverable reserve",
    progress: (done: number, total: number, xlm: string): ReactNode => (
      <>
        Example account · {done} of {total} steps · {xlm} XLM total
      </>
    ),
  },
  input: {
    label: "Stellar account address",
    placeholder: "Paste a Stellar account address - G…",
    empty: "Enter a Stellar account address.",
    analyze: "Analyze account",
    reassurance: (estimate: ReactNode): ReactNode => (
      <>
        {"Analyzes on mainnet · read-only until you sign · no account needed ·"} {estimate}
      </>
    ),
    estimate: "Estimate recovery",
    playground: (link: ReactNode): ReactNode => (
      <>
        {"Not ready yet?"} {link} {"with a throwaway testnet account, no wallet needed."}
      </>
    ),
    playgroundLink: "Try the playground",
  },
  estimate: {
    heading: "Recovery estimate",
    caveat: "Estimate, not a promise: fees and market quotes change",
    reading: "Reading the account…",
    readingAnnouncement: "Reading the account.",
    about: (xlm: string): string => `About ${xlm} XLM`,
    range: (low: string, high: string): string => `${low} to ${high} XLM`,
    blockers: (n: number): string =>
      n === 0
        ? "No items found that would block a close."
        : `${count(n, "item", "items")} would block a close until resolved.`,
    assumptions: {
      low: "Low: the XLM balance less estimated network fees, with no conversions.",
      high: "High: adds the minimum quoted for converting other assets to XLM, and any XLM claimable balances. Quotes move with the market.",
      exchangeFee: "Fees include the extra network fee an exchange destination needs.",
      unquoted: (n: number): string =>
        `${count(n, "asset", "assets")} had no quote and count as zero.`,
      unconvertible: (n: number): string =>
        `${count(n, "asset has", "assets have")} no route to XLM and ${n === 1 ? "is" : "are"} not counted.`,
      defiExits: "XLM paid out by exiting DeFi positions is not counted.",
    },
    announcement: (range: string, blockers: string, caveat: string): string =>
      `Estimated recovery: ${range}. ${blockers} ${caveat}.`,
    readAt: (time: ReactNode): ReactNode => (
      <>
        Read at {time} {"from the public ledger. No wallet, no signing."}
      </>
    ),
    continue: "Continue to close",
  },
};

export type HeroCopy = typeof en;

export const HERO: Record<Locale, HeroCopy> = { en, es: en };
