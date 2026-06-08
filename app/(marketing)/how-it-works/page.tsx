import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  ArrowDown,
  Search,
  KeyRound,
  Database,
  XCircle,
  Layers,
  ArrowLeftRight,
  Unlink,
  GitMerge,
  Eye,
  PenTool,
  Send,
  RefreshCw,
  CheckCircle2,
  Building2,
  Repeat,
} from "lucide-react";
import Reveal from "@/components/marketing/Reveal";
import Faq from "@/components/marketing/Faq";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "How LumenWipe closes a Stellar account: a deterministic ordered plan, per-step simulation and confirmation, the CEX mediator flow, and resumable sessions reconciled against on-chain state.",
};

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="mkt-eyebrow inline-flex items-center gap-2 text-stellar/90">
      <span className="h-px w-6 bg-stellar/50" />
      {children}
    </span>
  );
}

const LOOP = [
  { icon: RefreshCw, label: "Re-read live state", note: "getLedgerEntries" },
  { icon: Eye, label: "Simulate", note: "simulateTransaction" },
  { icon: CheckCircle2, label: "Confirm", note: "you approve" },
  { icon: PenTool, label: "Sign in browser", note: "your wallet" },
  { icon: Send, label: "Submit XDR", note: "to Stellar RPC" },
  { icon: ArrowRight, label: "Poll & advance", note: "next step" },
];

const STEPS = [
  {
    icon: Search,
    title: "Analyze the account",
    body: "Enumerate every subentry (trustlines, offers, data entries, signers) and detect DeFi positions through OctoPos with Orion as fallback. The result is a single, ordered execution plan.",
    op: "stellar.expert + Stellar RPC",
  },
  {
    icon: KeyRound,
    title: "Normalize signers",
    body: "Remove extra signers and reset thresholds so a single key can authorize every remaining step without surprises mid-flow.",
    op: "SetOptions",
  },
  {
    icon: Database,
    title: "Remove data entries",
    body: "Clear every ManageData entry in batches, releasing 0.5 XLM of reserve each.",
    op: "ManageData (value = null)",
  },
  {
    icon: XCircle,
    title: "Cancel DEX offers",
    body: "Close all open order-book offers, freeing the reserve each one holds.",
    op: "ManageSellOffer / ManageBuyOffer · amount = 0",
  },
  {
    icon: Layers,
    title: "Exit AMM & DeFi positions",
    body: "Withdraw from classic liquidity pools and every supported Soroban protocol, repaying loans and unstaking first where needed, via each protocol's own adapter.",
    op: "LiquidityPoolWithdraw · Blend · Aquarius · Soroswap · Phoenix · FxDAO",
  },
  {
    icon: ArrowLeftRight,
    title: "Convert assets to XLM",
    body: "Swap every remaining token to XLM along the best available route across Soroban and classic venues.",
    op: "Soroswap Aggregator · SDEX path payments",
  },
  {
    icon: Unlink,
    title: "Remove trustlines",
    body: "Once a balance is zero, remove its trustline and release the 0.5 XLM reserve.",
    op: "ChangeTrust · limit = 0",
  },
  {
    icon: GitMerge,
    title: "Merge the account",
    body: "Execute the final merge, directly to a wallet or through a mediator account for an exchange destination. The base reserve comes back too.",
    op: "AccountMerge",
  },
];

const MACHINE = [
  "Idle",
  "Analyzing",
  "PreflightComplete",
  "StepExecuting",
  "StepConfirmed",
  "Complete",
];

export default function HowItWorksPage() {
  return (
    <>
      {/* hero */}
      <section className="mx-auto max-w-4xl px-5 pb-14 pt-16 text-center lg:px-8 lg:pt-24">
        <Reveal>
          <Eyebrow>How it works</Eyebrow>
          <h1 className="mkt-display mx-auto mt-5 max-w-3xl text-[2.4rem] font-extrabold leading-[1.02] text-white sm:text-6xl">
            A deterministic plan for an irreversible action.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-[1.05rem] leading-relaxed text-white/60">
            Closing an account is several sequential transactions in the right order. LumenWipe
            shows the whole plan up front, then executes it one confirmed step at a time, re-reading
            live state and simulating before every signature, so nothing is ever signed on stale
            data.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/mainnet"
              className="group inline-flex items-center gap-2 rounded-xl bg-stellar px-5 py-3 text-sm font-semibold text-black transition-all hover:bg-stellar/90 hover:shadow-[0_0_32px_-6px_hsl(var(--stellar)/0.7)]"
            >
              Open the app
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/#faq"
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.02] px-5 py-3 text-sm font-semibold text-white/85 transition-colors hover:border-white/30 hover:text-white"
            >
              Jump to FAQ
            </Link>
          </div>
        </Reveal>
      </section>

      {/* execution loop */}
      <section className="border-y border-white/8 bg-white/[0.012]">
        <div className="mx-auto max-w-6xl px-5 py-16 lg:px-8 lg:py-20">
          <Reveal className="max-w-2xl">
            <Eyebrow>The execution loop</Eyebrow>
            <h2 className="mkt-display mt-4 text-2xl font-bold text-white sm:text-4xl">
              Every step runs the same safe loop.
            </h2>
            <p className="mt-4 leading-relaxed text-white/55">
              No step trusts a cached value. Each one reconciles against the live ledger, simulates,
              and waits for your explicit approval before a single byte is signed.
            </p>
          </Reveal>

          <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {LOOP.map((s, i) => (
              <Reveal key={s.label} delay={i * 60}>
                <div className="relative flex h-full flex-col items-start rounded-xl border border-white/10 bg-[#0b0b11]/70 p-4">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-stellar/10 text-stellar">
                    <s.icon className="h-4 w-4" />
                  </span>
                  <h3 className="mt-3 text-sm font-semibold text-white">{s.label}</h3>
                  <p className="mt-0.5 mkt-mono text-[0.66rem] text-white/40">{s.note}</p>
                </div>
              </Reveal>
            ))}
          </div>
          <p className="mt-5 inline-flex items-center gap-2 mkt-mono text-xs text-white/40">
            <Repeat className="h-3.5 w-3.5 text-stellar" />
            repeats for every step in the plan
          </p>
        </div>
      </section>

      {/* the eight steps */}
      <section className="mx-auto max-w-4xl px-5 py-20 lg:px-8 lg:py-28">
        <Reveal className="max-w-2xl">
          <Eyebrow>The plan</Eyebrow>
          <h2 className="mkt-display mt-4 text-3xl font-bold text-white sm:text-[2.6rem] sm:leading-[1.05]">
            Eight ordered steps, every reserve accounted for.
          </h2>
        </Reveal>

        <ol className="mt-12 space-y-3">
          {STEPS.map((s, i) => (
            <Reveal as="li" key={s.title} delay={i * 40}>
              <div className="group relative flex gap-5 rounded-2xl border border-white/10 bg-white/[0.02] p-5 transition-colors hover:border-stellar/30 sm:p-6">
                <div className="flex flex-col items-center">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-stellar/10 text-stellar">
                    <s.icon className="h-5 w-5" />
                  </span>
                  {i < STEPS.length - 1 && (
                    <span className="mt-2 w-px flex-1 bg-gradient-to-b from-white/15 to-transparent" />
                  )}
                </div>
                <div className="min-w-0 pb-1">
                  <div className="flex items-center gap-3">
                    <span className="mkt-mono text-xs text-white/30">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <h3 className="text-base font-semibold text-white">{s.title}</h3>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-white/55">{s.body}</p>
                  <div className="mt-3 inline-flex items-center gap-2 rounded-lg border border-white/8 bg-black/30 px-2.5 py-1 mkt-mono text-[0.68rem] text-white/55">
                    <span className="text-stellar/70">op</span>
                    {s.op}
                  </div>
                </div>
              </div>
            </Reveal>
          ))}
        </ol>
      </section>

      {/* mediator flow */}
      <section className="border-y border-white/8 bg-white/[0.012]">
        <div className="mx-auto max-w-5xl px-5 py-20 lg:px-8 lg:py-28">
          <Reveal className="max-w-2xl">
            <Eyebrow>Exchange destinations</Eyebrow>
            <h2 className="mkt-display mt-4 text-3xl font-bold text-white sm:text-[2.6rem] sm:leading-[1.05]">
              The CEX mediator flow.
            </h2>
            <p className="mt-5 leading-relaxed text-white/55">
              Exchanges don&apos;t support{" "}
              <span className="mkt-mono text-white/80">ACCOUNT_MERGE</span>. LumenWipe bridges the
              gap with a transparent, single-use mediator account, generated in your browser, used
              once, and cleared from memory.
            </p>
          </Reveal>

          <Reveal delay={100}>
            <div className="mkt-panel mt-10 rounded-2xl p-6 sm:p-8">
              <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
                {[
                  { label: "Source account", sub: "the account you're closing", tone: "white" },
                  { op: "AccountMerge" },
                  {
                    label: "Mediator account",
                    sub: "single-use · generated in browser",
                    tone: "stellar",
                  },
                  { op: "Payment + memo" },
                  { label: "Exchange deposit", sub: "validated address & memo", tone: "value" },
                ].map((node, i) =>
                  "op" in node ? (
                    <div
                      key={i}
                      className="flex flex-row items-center justify-center gap-2 text-white/35 sm:flex-col"
                    >
                      <ArrowRight className="hidden h-4 w-4 sm:block" />
                      <ArrowDown className="h-4 w-4 sm:hidden" />
                      <span className="mkt-mono text-[0.62rem] uppercase tracking-wider text-stellar/70">
                        {node.op}
                      </span>
                    </div>
                  ) : (
                    <div
                      key={i}
                      className={`flex-1 rounded-xl border p-4 text-center ${
                        node.tone === "stellar"
                          ? "border-stellar/40 bg-stellar/[0.06]"
                          : node.tone === "value"
                            ? "border-value/30 bg-value/[0.05]"
                            : "border-white/12 bg-white/[0.03]"
                      }`}
                    >
                      <div className="text-sm font-semibold text-white">{node.label}</div>
                      <div className="mt-1 text-[0.72rem] text-white/45">{node.sub}</div>
                    </div>
                  )
                )}
              </div>
              <p className="mt-6 text-center text-sm text-white/45">
                The ~1 XLM that stays as the mediator&apos;s base reserve is disclosed upfront.
                Known exchanges are validated against a registry that enforces the correct memo
                type.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* state machine + architecture */}
      <section className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-28">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
          <Reveal>
            <Eyebrow>Resumable by design</Eyebrow>
            <h2 className="mkt-display mt-4 text-2xl font-bold text-white sm:text-3xl">
              Close the tab. Pick up where you left off.
            </h2>
            <p className="mt-4 leading-relaxed text-white/55">
              The entire wind-down is an explicit state machine, persisted in IndexedDB, never your
              keys. On return, the session is reconciled against on-chain state, and any completed
              step is skipped, so nothing double-executes.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-2">
              {MACHINE.map((s, i) => (
                <span key={s} className="inline-flex items-center gap-2">
                  <span className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 mkt-mono text-xs text-white/70">
                    {s}
                  </span>
                  {i < MACHINE.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-white/25" />}
                </span>
              ))}
            </div>
          </Reveal>

          <Reveal delay={100}>
            <Eyebrow>Architecture</Eyebrow>
            <h2 className="mkt-display mt-4 text-2xl font-bold text-white sm:text-3xl">
              Three layers, one trust boundary.
            </h2>
            <p className="mt-4 leading-relaxed text-white/55">
              No bespoke indexer, no Horizon dependency. Every read source sits behind an adapter,
              so any compatible provider can be swapped in without touching the rest of the system.
            </p>
            <div className="mt-7 space-y-2.5">
              {[
                {
                  l: "Browser",
                  s: "UI · wallet · tx builder · session",
                  note: "keys never leave",
                  tone: true,
                },
                {
                  l: "Read-only backend",
                  s: "analysis · DeFi adapters · routing · cache",
                  note: "no custody",
                },
                {
                  l: "Stellar network",
                  s: "Stellar RPC · stellar.expert · Soroswap",
                  note: "read-only",
                },
              ].map((row) => (
                <div
                  key={row.l}
                  className={`flex items-center justify-between gap-3 rounded-xl border p-3.5 ${
                    row.tone
                      ? "border-stellar/40 bg-stellar/[0.06] mkt-glow-cyan"
                      : "border-white/10 bg-white/[0.02]"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white">{row.l}</div>
                    <div className="truncate mkt-mono text-[0.66rem] text-white/40">{row.s}</div>
                  </div>
                  <span
                    className={`shrink-0 mkt-mono text-[0.58rem] uppercase tracking-wider ${
                      row.tone ? "text-stellar" : "text-white/35"
                    }`}
                  >
                    {row.note}
                  </span>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* faq */}
      <section id="faq" className="mx-auto max-w-3xl scroll-mt-20 px-5 pb-24 lg:px-8">
        <Reveal className="text-center">
          <Eyebrow>FAQ</Eyebrow>
          <h2 className="mkt-display mt-4 text-3xl font-bold text-white sm:text-4xl">
            Questions, answered.
          </h2>
        </Reveal>
        <div className="mt-10">
          <Faq />
        </div>
        <div className="mt-12 flex flex-col items-center gap-4 rounded-2xl border border-white/10 bg-[#0a0a12] p-8 text-center">
          <h3 className="mkt-display text-xl font-bold text-white">Ready when you are.</h3>
          <Link
            href="/public"
            className="group inline-flex items-center gap-2 rounded-xl bg-stellar px-5 py-3 text-sm font-semibold text-black transition-all hover:bg-stellar/90 hover:shadow-[0_0_32px_-6px_hsl(var(--stellar)/0.7)]"
          >
            Open the app
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </section>
    </>
  );
}
