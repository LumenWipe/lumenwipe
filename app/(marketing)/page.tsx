import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  ShieldCheck,
  KeyRound,
  Eye,
  GitMerge,
  RefreshCw,
  Layers,
  Coins,
  Building2,
  Search,
  Database,
  XCircle,
  ArrowLeftRight,
  Unlink,
  Lock,
  ScanLine,
  Server,
  Network,
  Boxes,
  Gauge,
  Check,
} from "lucide-react";
import ExecutionPlanDemo from "@/components/marketing/ExecutionPlanDemo";
import Faq from "@/components/marketing/Faq";
import LiveStats from "@/components/marketing/LiveStats";
import Reveal from "@/components/marketing/Reveal";

export const metadata: Metadata = {
  title: "LumenWipe: Recover the XLM locked in your Stellar account",
  description:
    "LumenWipe closes any Stellar account end to end and recovers the XLM locked in its reserves. Unwind trustlines, offers, data entries and Soroban DeFi positions, then merge out to your wallet or exchange. Non-custodial, open source.",
};

const APP = "/mainnet";
const TESTNET = "/testnet";

const STEPS = [
  { icon: Search, label: "Analyze", desc: "Enumerate every subentry and DeFi position" },
  { icon: KeyRound, label: "Normalize signers", desc: "Remove extra keys, reset thresholds" },
  { icon: Database, label: "Clear data entries", desc: "Remove ManageData in batches" },
  { icon: XCircle, label: "Cancel offers", desc: "Close every open DEX order" },
  { icon: Layers, label: "Exit DeFi & AMM", desc: "Withdraw from pools and protocols" },
  { icon: ArrowLeftRight, label: "Convert to XLM", desc: "Best route across SDEX & Soroswap" },
  { icon: Unlink, label: "Remove trustlines", desc: "Release each 0.5 XLM reserve" },
  { icon: GitMerge, label: "Merge", desc: "Direct, or via mediator for a CEX" },
];

const RESERVE = [
  { label: "Base reserve", count: "account", xlm: 1.0, w: 20 },
  { label: "4 trustlines", count: "0.5 each", xlm: 2.0, w: 40 },
  { label: "2 open offers", count: "0.5 each", xlm: 1.0, w: 20 },
  { label: "1 data entry", count: "0.5 each", xlm: 0.5, w: 10 },
  { label: "1 extra signer", count: "0.5 each", xlm: 0.5, w: 10 },
];

const PROTOCOLS = ["Blend", "Aquarius", "Soroswap", "Phoenix", "FxDAO", "Classic DEX", "Classic AMM"];

const ECOSYSTEM = [
  "Freighter",
  "xBull",
  "Albedo",
  "LOBSTR",
  "Hana",
  "WalletConnect",
  "Blend",
  "Aquarius",
  "Soroswap",
  "Phoenix",
  "FxDAO",
  "Stellar RPC",
  "stellar.expert",
  "Soroswap Aggregator",
  "OctoPos",
  "Orion",
];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="mkt-eyebrow inline-flex items-center gap-2 text-stellar/90">
      <span className="h-px w-6 bg-stellar/50" />
      {children}
    </span>
  );
}

export default function LandingPage() {
  return (
    <>
      {/* ============================ HERO ============================ */}
      <section className="relative">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-16 pt-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10 lg:px-8 lg:pb-24 lg:pt-24">
          <div>
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 mkt-mono text-[0.68rem] uppercase tracking-wider text-white/65">
              <span className="h-1.5 w-1.5 rounded-full bg-stellar mkt-pulse" />
              Stellar Account Demolisher
            </div>

            <h1 className="mkt-display text-[2.6rem] font-extrabold leading-[0.98] text-white sm:text-6xl">
              Get back the XLM{" "}
              <span className="relative whitespace-nowrap text-value">
                locked
                <svg
                  className="absolute -bottom-1 left-0 w-full text-value/50"
                  viewBox="0 0 120 8"
                  fill="none"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <path
                    d="M1 5.5c30-4 88-4 118 0"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </span>{" "}
              in your Stellar account.
            </h1>

            <p className="mt-6 max-w-xl text-[1.05rem] leading-relaxed text-white/60">
              LumenWipe walks you through closing a Stellar account from start to finish: trustlines,
              offers, data entries, signers, even Soroban DeFi positions. It converts what&apos;s left
              to XLM and merges it out to your wallet or exchange. One guided flow, signed entirely
              in your browser.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href={APP}
                className="group inline-flex items-center gap-2 rounded-xl bg-stellar px-5 py-3 text-sm font-semibold text-black transition-all hover:bg-stellar/90 hover:shadow-[0_0_32px_-6px_hsl(var(--stellar)/0.7)]"
              >
                Open the app
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link
                href="/how-it-works"
                className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.02] px-5 py-3 text-sm font-semibold text-white/85 transition-colors hover:border-white/30 hover:text-white"
              >
                See how it works
              </Link>
            </div>

            <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-2 mkt-mono text-[0.72rem] text-white/45">
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-stellar" />
                Keys never leave your browser
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Boxes className="h-3.5 w-3.5 text-stellar" />
                Open source · Apache 2.0
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Lock className="h-3.5 w-3.5 text-stellar" />
                Audit committed
              </span>
            </div>

            <div className="mt-6">
              <LiveStats />
            </div>
          </div>

          {/* instrument */}
          <Reveal delay={120} className="relative">
            <div className="pointer-events-none absolute -inset-6 -z-10 mkt-aura blur-2xl" />
            <ExecutionPlanDemo />
          </Reveal>
        </div>

        {/* stat band */}
        <div className="border-y border-white/8 bg-white/[0.015]">
          <div className="mx-auto grid max-w-6xl grid-cols-2 divide-x divide-white/8 px-5 lg:grid-cols-4 lg:px-8">
            {[
              { n: "10M+", l: "accounts on Stellar mainnet" },
              { n: "1 + 0.5n", l: "XLM locked per account" },
              { n: "7", l: "DeFi protocols covered" },
              { n: "0", l: "servers that can move your funds" },
            ].map((s, i) => (
              <div key={s.l} className={`px-4 py-6 ${i >= 2 ? "border-t border-white/8 lg:border-t-0" : ""}`}>
                <div className="mkt-display text-2xl font-bold text-white sm:text-3xl">{s.n}</div>
                <div className="mt-1 text-[0.78rem] leading-snug text-white/45">{s.l}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============================ PROBLEM ============================ */}
      <section className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-28">
        <Reveal>
          <Eyebrow>The problem</Eyebrow>
          <h2 className="mkt-display mt-4 max-w-2xl text-3xl font-bold text-white sm:text-[2.6rem] sm:leading-[1.05]">
            Your lumens are locked, and the exit is a maze.
          </h2>
          <p className="mt-5 max-w-2xl text-[1.02rem] leading-relaxed text-white/55">
            Every Stellar account holds XLM in reserve: 1 XLM for the account itself, plus 0.5 XLM
            for every trustline, offer, data entry, and signer. That reserve is only recoverable by
            closing the account, and closing one cleanly is harder than it sounds.
          </p>
        </Reveal>

        <div className="mt-12 grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
          {/* reserve breakdown */}
          <Reveal className="mkt-panel rounded-2xl p-6">
            <div className="flex items-center justify-between">
              <span className="mkt-eyebrow text-white/45">Locked reserve</span>
              <span className="mkt-mono text-xs text-white/40">example account</span>
            </div>
            <div className="mt-5 space-y-3.5">
              {RESERVE.map((r) => (
                <div key={r.label}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-white/75">{r.label}</span>
                    <span className="mkt-mono text-value tabular-nums">{r.xlm.toFixed(2)}</span>
                  </div>
                  <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/8">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-value/60 to-value"
                      style={{ width: `${r.w * 2.2}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-5 flex items-baseline justify-between border-t border-white/10 pt-4">
              <span className="text-sm font-semibold text-white">Total locked</span>
              <span className="mkt-display text-2xl font-bold text-value tabular-nums">
                5.00 <span className="text-sm font-normal text-white/50">XLM</span>
              </span>
            </div>
          </Reveal>

          {/* hard truths */}
          <div className="grid gap-5">
            {[
              {
                icon: RefreshCw,
                title: "One mistake and it all reverts",
                body: "A single leftover subentry makes the final ACCOUNT_MERGE fail. You have to cancel every offer, exit every position, sell every asset, and clear every entry, in the right order, before the merge will go through.",
              },
              {
                icon: Building2,
                title: "Exchanges can't merge",
                body: "No major exchange supports ACCOUNT_MERGE. Send your remaining XLM to a CEX deposit address and the 1 XLM base reserve stays frozen forever.",
              },
              {
                icon: Layers,
                title: "DeFi has no tool at all",
                body: "The existing demolisher has no Soroban support. Any account with a Blend loan, an Aquarius LP, or a Soroswap position simply cannot be closed with today's tools.",
              },
            ].map((t) => (
              <Reveal key={t.title} className="group flex gap-4 rounded-2xl border border-white/10 bg-white/[0.02] p-5 transition-colors hover:border-white/20">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-stellar">
                  <t.icon className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-[0.98rem] font-semibold text-white">{t.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-white/50">{t.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ============================ THE FLOW ============================ */}
      <section className="relative border-y border-white/8 bg-white/[0.012]">
        <div className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-28">
          <Reveal className="max-w-2xl">
            <Eyebrow>The fix</Eyebrow>
            <h2 className="mkt-display mt-4 text-3xl font-bold text-white sm:text-[2.6rem] sm:leading-[1.05]">
              One guided flow. Eight steps. Everything recovered.
            </h2>
            <p className="mt-5 text-[1.02rem] leading-relaxed text-white/55">
              LumenWipe reads the whole account, builds a deterministic ordered plan, and executes it
              step by step, re-reading live state and simulating before every signature. You confirm
              each move; nothing happens without you.
            </p>
          </Reveal>

          <div className="mt-12 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <Reveal key={s.label} delay={i * 60} className="relative h-full">
                <div className="flex h-full flex-col rounded-xl border border-white/10 bg-[#0b0b11]/70 p-4 transition-colors hover:border-stellar/30">
                  <div className="flex items-center justify-between">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-stellar/10 text-stellar">
                      <s.icon className="h-4 w-4" />
                    </span>
                    <span className="mkt-mono text-xs text-white/25">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                  </div>
                  <h3 className="mt-3.5 text-sm font-semibold text-white">{s.label}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-white/45">{s.desc}</p>
                </div>
              </Reveal>
            ))}
          </div>

          <div className="mt-9">
            <Link
              href="/how-it-works"
              className="group inline-flex items-center gap-2 text-sm font-semibold text-stellar transition-colors hover:text-stellar/80"
            >
              See the full flow, step by step
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
        </div>
      </section>

      {/* ============================ CAPABILITIES ============================ */}
      <section className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-28">
        <Reveal className="max-w-2xl">
          <Eyebrow>What you get</Eyebrow>
          <h2 className="mkt-display mt-4 text-3xl font-bold text-white sm:text-[2.6rem] sm:leading-[1.05]">
            Built for the messy reality of real accounts.
          </h2>
        </Reveal>

        <div className="mt-12 grid gap-4 lg:grid-cols-3">
          {/* DeFi: wide feature */}
          <Reveal className="lg:col-span-2">
            <div className="relative h-full overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-stellar/[0.07] via-transparent to-transparent p-6 sm:p-7">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-stellar/12 text-stellar">
                    <Layers className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 text-lg font-semibold text-white">Full Soroban DeFi coverage</h3>
                  <p className="mt-2 max-w-md text-sm leading-relaxed text-white/55">
                    The piece the original demolisher lacks. LumenWipe detects positions through
                    OctoPos and Orion, then exits each one with its own protocol adapter, repaying
                    loans, withdrawing liquidity, and unstaking before it removes the trustline.
                  </p>
                </div>
                <span className="shrink-0 rounded-full border border-stellar/30 bg-stellar/10 px-2.5 py-1 mkt-mono text-[0.62rem] uppercase tracking-wider text-stellar/90">
                  Coming soon
                </span>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                {PROTOCOLS.map((p) => (
                  <span
                    key={p}
                    className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 mkt-mono text-xs text-white/70"
                  >
                    {p}
                  </span>
                ))}
              </div>
            </div>
          </Reveal>

          {[
            {
              icon: Building2,
              title: "Exchange-compatible merge",
              body: "A transparent, single-use mediator account bridges the merge to any CEX deposit address, with the right memo, validated.",
            },
            {
              icon: Eye,
              title: "Allowance inspector",
              body: "See every token approval your account has granted to DeFi contracts, and revoke risky ones, even without closing.",
            },
            {
              icon: RefreshCw,
              title: "Resumable sessions",
              body: "An explicit state machine in IndexedDB. Close the tab mid-flow and pick up exactly where you left off, reconciled on-chain.",
            },
            {
              icon: ScanLine,
              title: "Deterministic, auditable plan",
              body: "The same account state always produces the same ordered plan: testable, reviewable, and never built on stale data.",
            },
            {
              icon: Gauge,
              title: "Simulated before you sign",
              body: "Every Soroban call runs through simulateTransaction first. You see the result before being asked for a signature.",
            },
          ].map((f) => (
            <Reveal key={f.title}>
              <div className="flex h-full flex-col rounded-2xl border border-white/10 bg-white/[0.02] p-5 transition-colors hover:border-white/20">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-stellar">
                  <f.icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-[0.98rem] font-semibold text-white">{f.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-white/50">{f.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ============================ SECURITY ============================ */}
      <section id="security" className="relative scroll-mt-20 border-y border-white/8 bg-white/[0.012]">
        <div className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-28">
          <div className="grid gap-12 lg:grid-cols-[1fr_1fr] lg:gap-16">
            <Reveal>
              <Eyebrow>Trust model</Eyebrow>
              <h2 className="mkt-display mt-4 text-3xl font-bold text-white sm:text-[2.6rem] sm:leading-[1.05]">
                The trust boundary is your browser.
              </h2>
              <p className="mt-5 text-[1.02rem] leading-relaxed text-white/55">
                LumenWipe builds transactions that drain accounts irreversibly, so the design starts
                from that fact. Keys are created and used only in your browser. The backend is
                read-only and stateless. Even a fully compromised server cannot move a single lumen.
              </p>

              {/* layered diagram */}
              <div className="mt-8 space-y-2.5">
                {[
                  {
                    label: "Your browser",
                    sub: "Wallet · transaction builder · signing · session",
                    tone: "stellar",
                    note: "keys live here",
                  },
                  {
                    label: "Read-only backend",
                    sub: "Account analysis · DeFi adapters · routing · cache",
                    tone: "muted",
                    note: "no keys · no custody",
                  },
                  {
                    label: "Stellar network & data",
                    sub: "Stellar RPC · stellar.expert · Soroswap Aggregator",
                    tone: "muted",
                    note: "read · simulate · submit",
                  },
                ].map((layer) => (
                  <div
                    key={layer.label}
                    className={`flex items-center justify-between gap-3 rounded-xl border p-3.5 ${
                      layer.tone === "stellar"
                        ? "border-stellar/40 bg-stellar/[0.06] mkt-glow-cyan"
                        : "border-white/10 bg-white/[0.02]"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-white">{layer.label}</div>
                      <div className="truncate mkt-mono text-[0.68rem] text-white/40">{layer.sub}</div>
                    </div>
                    <span
                      className={`shrink-0 mkt-mono text-[0.6rem] uppercase tracking-wider ${
                        layer.tone === "stellar" ? "text-stellar" : "text-white/35"
                      }`}
                    >
                      {layer.note}
                    </span>
                  </div>
                ))}
              </div>
            </Reveal>

            <Reveal delay={100} className="lg:pt-2">
              <ul className="space-y-px overflow-hidden rounded-2xl border border-white/10">
                {[
                  {
                    icon: KeyRound,
                    title: "Private key",
                    body: "Never transmitted. Stays in your wallet, or in memory only and cleared after each signing.",
                  },
                  {
                    icon: ScanLine,
                    title: "Every destructive step",
                    body: "Reviewed as raw XDR and explicitly confirmed before signing.",
                  },
                  {
                    icon: Building2,
                    title: "Exchange memo",
                    body: "Required and validated for known exchanges; a missing memo blocks submission.",
                  },
                  {
                    icon: Server,
                    title: "Backend compromise",
                    body: "Cannot move funds. Wrong read data is caught by on-chain simulation and confirmations.",
                  },
                  {
                    icon: Network,
                    title: "Strict CSP",
                    body: "No inline scripts, no unsafe-eval. Dependencies are lockfile-pinned and audited in CI.",
                  },
                ].map((row) => (
                  <li
                    key={row.title}
                    className="flex gap-3.5 bg-white/[0.02] p-4 transition-colors hover:bg-white/[0.04]"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-stellar/10 text-stellar">
                      <row.icon className="h-4 w-4" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-white">{row.title}</div>
                      <div className="mt-0.5 text-sm leading-relaxed text-white/50">{row.body}</div>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex items-center gap-2.5 rounded-xl border border-value/20 bg-value/[0.05] p-3.5 text-sm text-white/65">
                <ShieldCheck className="h-4 w-4 shrink-0 text-value" />
                A third-party audit through Stellar&apos;s Audit Bank is committed before any mainnet
                release.
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ============================ ECOSYSTEM MARQUEE ============================ */}
      <section className="py-14">
        <p className="mb-6 text-center mkt-eyebrow text-white/35">
          Wallets, protocols & data sources it speaks to
        </p>
        <div className="mkt-marquee-track relative flex overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_12%,#000_88%,transparent)]">
          <div className="mkt-marquee flex shrink-0 items-center gap-3 pr-3">
            {[...ECOSYSTEM, ...ECOSYSTEM].map((name, i) => (
              <span
                key={`${name}-${i}`}
                className="shrink-0 rounded-lg border border-white/8 bg-white/[0.02] px-4 py-2 mkt-mono text-sm text-white/55"
              >
                {name}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ============================ FAQ ============================ */}
      <section id="faq" className="mx-auto max-w-3xl scroll-mt-20 px-5 py-20 lg:px-8 lg:py-28">
        <Reveal className="text-center">
          <Eyebrow>FAQ</Eyebrow>
          <h2 className="mkt-display mt-4 text-3xl font-bold text-white sm:text-[2.6rem]">
            Questions, answered.
          </h2>
          <p className="mt-4 text-white/55">
            Closing an account is irreversible. Here&apos;s exactly how LumenWipe keeps it safe.
          </p>
        </Reveal>
        <div className="mt-10">
          <Faq />
        </div>
        <p className="mt-6 text-center text-sm text-white/45">
          Still curious?{" "}
          <a
            href="https://docs.lumenwipe.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-stellar underline-offset-4 hover:underline"
          >
            Read the full documentation
          </a>
          .
        </p>
      </section>

      {/* ============================ FINAL CTA ============================ */}
      <section className="mx-auto max-w-6xl px-5 pb-24 lg:px-8">
        <Reveal>
          <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#0a0a12] px-6 py-14 text-center sm:px-12 sm:py-20">
            <div aria-hidden className="pointer-events-none absolute inset-0 mkt-aura" />
            <div aria-hidden className="pointer-events-none absolute inset-0 mkt-dots opacity-40" />
            <div className="relative">
              <h2 className="mkt-display mx-auto max-w-2xl text-3xl font-bold leading-[1.05] text-white sm:text-5xl">
                Reclaim the XLM that&apos;s been sitting locked.
              </h2>
              <p className="mx-auto mt-5 max-w-lg text-[1.02rem] text-white/60">
                Try the entire flow on testnet with no funds at risk, then switch to mainnet for the
                real close.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <Link
                  href={APP}
                  className="group inline-flex items-center gap-2 rounded-xl bg-stellar px-6 py-3.5 text-sm font-semibold text-black transition-all hover:bg-stellar/90 hover:shadow-[0_0_36px_-6px_hsl(var(--stellar)/0.7)]"
                >
                  Open the app
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
                <Link
                  href={TESTNET}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.02] px-6 py-3.5 text-sm font-semibold text-white/85 transition-colors hover:border-white/30 hover:text-white"
                >
                  Try on testnet
                </Link>
              </div>
              <div className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 mkt-mono text-[0.7rem] text-white/40">
                <span className="inline-flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5 text-stellar" /> No signup
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5 text-stellar" /> No custody
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5 text-stellar" /> Open source
                </span>
              </div>
            </div>
          </div>
        </Reveal>
      </section>
    </>
  );
}
