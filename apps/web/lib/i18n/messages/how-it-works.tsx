import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n/locale";

const en = {
  metadata: {
    title: "How it works",
    description:
      "How LumenWipe closes a Stellar account: a deterministic ordered plan, per-step simulation and confirmation, the CEX relay flow, and resumable sessions reconciled against on-chain state.",
  },
  hero: {
    eyebrow: "How it works",
    heading: "A deterministic plan for an irreversible action.",
    body: "Closing an account is several sequential transactions in the right order. LumenWipe shows the whole plan up front, then executes it one confirmed step at a time, re-reading live state and simulating before every signature, so nothing is ever signed on stale data.",
    openApp: "Open the app",
    faq: "Jump to FAQ",
  },
  loop: {
    eyebrow: "The execution loop",
    heading: "Every step runs the same safe loop.",
    body: "No step trusts a cached value. Each one reconciles against the live ledger, simulates, and waits for your explicit approval before a single byte is signed.",
    steps: {
      reread: { label: "Re-read live state", note: "getLedgerEntries" },
      simulate: { label: "Simulate", note: "simulateTransaction" },
      confirm: { label: "Confirm", note: "you approve" },
      sign: { label: "Sign in browser", note: "your wallet" },
      submit: { label: "Submit XDR", note: "to Stellar RPC" },
      poll: { label: "Poll & advance", note: "next step" },
    },
    repeats: "repeats for every step in the plan",
  },
  plan: {
    eyebrow: "The plan",
    heading: "Eight ordered steps, every reserve accounted for.",
    opLabel: "op",
    steps: {
      analyze: {
        title: "Analyze the account",
        body: "Enumerate every subentry (trustlines, offers, data entries, signers) and detect DeFi positions through OctoPos. The result is a single, ordered execution plan.",
        op: "Horizon + Stellar RPC",
      },
      signers: {
        title: "Normalize signers",
        body: "Remove extra signers and reset thresholds so a single key can authorize every remaining step without surprises mid-flow.",
        op: "SetOptions",
      },
      data: {
        title: "Remove data entries",
        body: "Clear every ManageData entry in batches, releasing 0.5 XLM of reserve each.",
        op: "ManageData (value = null)",
      },
      offers: {
        title: "Cancel DEX offers",
        body: "Close all open order-book offers, freeing the reserve each one holds.",
        op: "ManageSellOffer / ManageBuyOffer · amount = 0",
      },
      defi: {
        title: "Exit DeFi positions",
        body: "Exit every supported Soroban protocol position, repaying loans and unstaking first where needed, via each protocol's own adapter. Classic AMM pool shares are reported as a blocker to withdraw elsewhere first.",
        op: (protocols: readonly string[]): string =>
          `InvokeHostFunction · ${protocols.join(" · ")}`,
      },
      convert: {
        title: "Convert assets to XLM",
        body: "Swap every remaining token to XLM along the best available route across Soroban and classic venues.",
        op: "Soroswap API · SDEX path payments",
      },
      trustlines: {
        title: "Remove trustlines",
        body: "Once a balance is zero, remove its trustline and release the 0.5 XLM reserve.",
        op: "ChangeTrust · limit = 0",
      },
      merge: {
        title: "Merge the account",
        body: "Execute the final merge, directly to a wallet or through a relay account for an exchange destination. The base reserve comes back too.",
        op: "AccountMerge",
      },
    },
  },
  relay: {
    eyebrow: "Exchange destinations",
    heading: "The CEX relay flow.",
    body: (code: (text: string) => ReactNode): ReactNode => (
      <>
        {"Exchanges don't support"} {code("ACCOUNT_MERGE")}
        {
          ". LumenWipe bridges the gap with a transparent, single-use relay account, generated in your browser, used once, and cleared from memory."
        }
      </>
    ),
    nodes: {
      source: { label: "Source account", sub: "the account you're closing" },
      merge: "AccountMerge",
      relay: { label: "Relay account", sub: "single-use · generated in browser" },
      payment: "Payment + memo",
      exchange: { label: "Exchange deposit", sub: "validated address & memo" },
    },
    footnote:
      "The ~1 XLM that stays as the relay account's base reserve is disclosed upfront. Known exchanges are validated against a registry that enforces the correct memo type.",
  },
  resume: {
    eyebrow: "Resumable by design",
    heading: "Close the tab. Pick up where you left off.",
    body: "The close moves through these phases in your browser. Once you confirm the plan, the browser keeps a small record of the close, never your keys. On return, LumenWipe re-reads the account and builds a fresh plan for what is left, which you review and sign again, so confirmed work is not repeated.",
    phases: [
      "Idle",
      "Analyzing",
      "PreflightComplete",
      "StepExecuting",
      "StepConfirmed",
      "Complete",
    ],
  },
  architecture: {
    eyebrow: "Architecture",
    heading: "Three layers, one trust boundary.",
    body: "No bespoke indexer. Every read source sits behind an adapter, so any compatible provider can be swapped in without touching the rest of the system.",
    rows: {
      browser: {
        label: "Browser",
        sub: "UI · wallet · transaction check · signing · session",
        note: "your key stays here",
      },
      api: {
        label: "LumenWipe API",
        sub: "reads · DeFi adapters · routing · builds unsigned transactions",
        note: "never holds your key",
      },
      network: {
        label: "Stellar network",
        sub: "Stellar RPC · Horizon · Soroswap",
        note: "read · submit",
      },
    },
  },
  faq: {
    eyebrow: "FAQ",
    heading: "Questions, answered.",
  },
  ready: {
    heading: "Ready when you are.",
    openApp: "Open the app",
  },
};

export type HowItWorksCopy = typeof en;

export const HOW_IT_WORKS: Record<Locale, HowItWorksCopy> = { en, es: en };
