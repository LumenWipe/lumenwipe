import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n/locale";

const en = {
  description: (exchangeLive: boolean): string =>
    `LumenWipe closes a Stellar account end to end and recovers the XLM locked in its reserves. Unwind trustlines, offers, data entries and Soroban DeFi positions, then merge out to ${exchangeLive ? "your wallet or exchange" : "your wallet"}. Non-custodial, open source.`,
  hero: {
    label: "Recover your locked XLM",
    headline: (accent: (text: string) => ReactNode): ReactNode => (
      <>Close the account. Keep the {accent("lumens.")}</>
    ),
    openApp: "Open the app",
    howItWorks: "See how it works",
  },
  stats: {
    asOf: (date: string, source: ReactNode): ReactNode => (
      <>
        {"As of "}
        {date}
        {" ·"} {source}
      </>
    ),
    source: "Source: ",
    registry: "From the contract registry",
  },
  problem: {
    eyebrow: "The problem",
    heading: "Your lumens are locked, and the exit is a maze.",
    body: "Every Stellar account holds XLM in reserve: 1 XLM for the account, plus 0.5 for every trustline, offer, data entry and signer. That reserve is only recoverable by closing the account, and closing one cleanly is harder than it sounds.",
    reserve: "Locked reserve",
    example: "Example account",
    total: "Total locked",
    truths: {
      reverts: {
        title: "One mistake and it all reverts",
        body: "A single leftover entry makes the final merge fail. Every offer, position, asset and entry must clear in the right order first.",
      },
      exchanges: {
        title: "Exchanges can't merge",
        body: (minimum: number): string =>
          `No major exchange accepts an account merge as a deposit. Pay your XLM out to an exchange instead and the ${minimum} XLM minimum stays locked in the account.`,
      },
      defi: {
        title: "DeFi positions hide outside the account",
        body: "A Blend loan, Aquarius liquidity or a Soroswap position lives in the protocol's contract. Merge the account while one is open and the funds stay stranded there, so each has to be exited through its own contract first.",
      },
    },
  },
  capabilities: {
    eyebrow: "What you get",
    heading: "Built for the messy reality of real accounts.",
    liveExits: "Protocol exits live on mainnet",
  },
  faq: {
    stillCurious: (docs: ReactNode): ReactNode => (
      <>
        {"Still curious?"} {docs}.
      </>
    ),
    docs: "Read the full documentation",
  },
  cta: {
    heading: "Reclaim the XLM that's been sitting locked.",
    body: "Try the entire flow on testnet with no funds at risk, then switch to mainnet for the real close.",
    openApp: "Open the app",
    testnet: "Try on testnet",
    noSignup: "No signup",
    signedInBrowser: "Signed in your browser",
    openSource: "Open source",
  },
};

export type LandingCopy = typeof en;

export const LANDING: Record<Locale, LandingCopy> = { en };
