import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  RefreshCw,
  Building2,
  Layers,
  Eye,
  ScanLine,
  Gauge,
  KeyRound,
  Server,
  Network,
} from "lucide-react";
import Faq from "@/components/marketing/Faq";
import Reveal from "@/components/marketing/Reveal";
import HeroConsole from "@/components/marketing/HeroConsole";

export const metadata: Metadata = {
  title: "LumenWipe: Recover the XLM locked in your Stellar account",
  description:
    "LumenWipe closes any Stellar account end to end and recovers the XLM locked in its reserves. Unwind trustlines, offers, data entries and Soroban DeFi positions, then merge out to your wallet or exchange. Non-custodial, open source.",
};

const APP = "/mainnet";
const TESTNET = "/testnet";

const STATS = [
  { n: "10M+", l: "accounts on Stellar mainnet" },
  { n: "1 + 0.5n", l: "XLM locked per account" },
  { n: "5", l: "DeFi protocols mapped" },
  { n: "0", l: "servers that can move your funds" },
];

const RESERVE = [
  { label: "Account minimum", xlm: "1.00", w: 20 },
  { label: "4 trustlines", xlm: "2.00", w: 40 },
  { label: "2 open offers", xlm: "1.00", w: 20 },
  { label: "1 data entry · 1 signer", xlm: "1.00", w: 20 },
];

const TRUTHS = [
  {
    icon: RefreshCw,
    title: "One mistake and it all reverts",
    body: "A single leftover subentry makes the final ACCOUNT_MERGE fail. Every offer, position, asset and entry must clear in the right order first.",
  },
  {
    icon: Building2,
    title: "Exchanges can't merge",
    body: "No major exchange supports ACCOUNT_MERGE. Send your XLM to a CEX address and the 1 XLM minimum stays frozen forever.",
  },
  {
    icon: Layers,
    title: "DeFi has no tool at all",
    body: "Any account with a Blend loan, an Aquarius LP or a Soroswap position simply cannot be closed with today's tools.",
  },
];

const FLOW = [
  { label: "Analyze", desc: "Enumerate every subentry and DeFi position." },
  { label: "Normalize signers", desc: "Remove extra keys, reset thresholds." },
  { label: "Clear data entries", desc: "Remove ManageData in batches." },
  { label: "Cancel offers", desc: "Close every open DEX order." },
  { label: "Exit DeFi & AMM", desc: "Withdraw from pools and protocols." },
  { label: "Convert to XLM", desc: "Best route across SDEX & Soroswap." },
  { label: "Remove trustlines", desc: "Release each 0.5 XLM reserve." },
  { label: "Merge", desc: "Direct, or via mediator for a CEX." },
];

const PROTOCOLS = [
  "Blend",
  "Aquarius",
  "Soroswap",
  "Phoenix",
  "FxDAO",
  "Classic DEX",
  "Classic AMM",
];

const FEATURES = [
  {
    icon: Building2,
    title: "Exchange-compatible merge",
    body: "A transparent, shared mediator bridges the merge to any CEX deposit address, with the right memo, validated.",
  },
  {
    icon: Eye,
    title: "Allowance inspector",
    body: "See every token approval your account granted to DeFi contracts, and revoke risky ones, even without closing.",
  },
  {
    icon: RefreshCw,
    title: "Resumable sessions",
    body: "An explicit state machine in IndexedDB. Close the tab mid-flow and resume exactly where you left off, reconciled on-chain.",
  },
  {
    icon: ScanLine,
    title: "Deterministic, auditable plan",
    body: "The same account state always produces the same ordered plan: testable, reviewable, never built on stale data.",
  },
  {
    icon: Gauge,
    title: "Simulated before you sign",
    body: "Every Soroban call runs through simulateTransaction first. You see the result before being asked for a signature.",
  },
];

const LAYERS = [
  {
    label: "Your browser",
    sub: "Wallet · transaction builder · signing · session",
    note: "keys live here",
    key: true,
  },
  {
    label: "Read-only backend",
    sub: "Account analysis · DeFi adapters · routing · cache",
    note: "co-sign only · no custody",
  },
  {
    label: "Stellar network & data",
    sub: "Stellar RPC · stellar.expert · Soroswap API",
    note: "read · simulate · submit",
  },
];

const GUARANTEES = [
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
    body: "Its only key is the shared mediator, which can't sign for your account or divert funds. Bad reads are caught by simulation and confirmations.",
  },
  {
    icon: Network,
    title: "Strict CSP",
    body: "No inline scripts, no unsafe-eval. Dependencies are lockfile-pinned and audited in CI.",
  },
];

const SOURCES = [
  {
    name: "OctoPos",
    body: "Discovers Soroban DeFi positions across Blend, Aquarius, Soroswap, Phoenix and FxDAO.",
  },
  {
    name: "stellar.expert",
    body: "Enumerates every subentry holding the account open before we re-read it live.",
  },
  {
    name: "Soroswap API + SDEX",
    body: "Finds the best conversion route for leftover assets into XLM.",
  },
  {
    name: "Stellar RPC",
    body: "Live state re-read, transaction simulation and submission, the source of truth.",
  },
];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="mkt-eyebrow inline-flex items-center gap-2 text-white/55">
      <span className="h-px w-5 bg-stellar/60" />
      {children}
    </span>
  );
}

const btnGold =
  "inline-flex items-center gap-2 rounded-xl bg-value px-5 py-3 text-sm font-semibold text-[hsl(var(--value-foreground))] transition-all hover:bg-value/90 hover:shadow-[0_12px_30px_-14px_hsl(var(--value)/0.7)]";
const btnGhost =
  "inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.02] px-5 py-3 text-sm font-semibold text-white/85 transition-colors hover:border-white/30 hover:text-white";

function Step({ index, label, desc }: { index: number; label: string; desc: string }) {
  const last = index === 3 || index === 7;
  const fin = index === 7;
  return (
    <div className="relative pb-7 pl-11">
      {!last && (
        <span className="absolute left-[13.5px] top-1 -bottom-1 w-px bg-white/10" aria-hidden />
      )}
      <span
        className={`mkt-node mkt-mono absolute left-0 top-0 grid place-items-center text-[10.5px] ${
          fin ? "mkt-node-fin" : ""
        }`}
      >
        {String(index + 1).padStart(2, "0")}
      </span>
      <h3 className="text-[0.95rem] font-semibold text-white">{label}</h3>
      <p className="mt-1 text-[0.82rem] leading-relaxed text-white/55">{desc}</p>
    </div>
  );
}

export default function LandingPage() {
  return (
    <>
      {/* ============================ HERO ============================ */}
      <section className="mx-auto max-w-5xl px-5 pb-10 pt-16 text-center lg:px-8 lg:pt-20">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 mkt-mono text-[0.68rem] uppercase tracking-wider text-white/65">
          <span className="h-1.5 w-1.5 rounded-full bg-stellar mkt-pulse" />
          Stellar Account Demolisher
        </div>

        <h1 className="mkt-display mx-auto max-w-[15ch] text-[2.7rem] font-extrabold leading-[0.95] text-white sm:text-6xl lg:text-[4.2rem]">
          Close the account. Keep the <span className="text-value">lumens.</span>
        </h1>

        <p className="mx-auto mt-6 max-w-xl text-[1.05rem] leading-relaxed text-white/70">
          Unwind every trustline, offer, data entry, signer and Soroban position, convert the
          leftovers, and merge out. Signed entirely in your browser.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link href={APP} className={`group ${btnGold}`}>
            Open the app
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <Link href="/how-it-works" className={btnGhost}>
            See how it works
          </Link>
        </div>

        {/* animated scan console */}
        <Reveal delay={120} className="mt-12">
          <HeroConsole />
        </Reveal>
      </section>

      {/* ============================ STAT BAND ============================ */}
      <div className="border-y border-white/[0.07]">
        <div className="mx-auto grid max-w-5xl grid-cols-2 divide-white/[0.07] px-5 lg:grid-cols-4 lg:divide-x lg:px-8">
          {STATS.map((s, i) => (
            <div
              key={s.l}
              className={`px-4 py-6 ${i >= 2 ? "border-t border-white/[0.07] lg:border-t-0" : ""}`}
            >
              <div className="mkt-display text-2xl font-bold text-value sm:text-3xl">{s.n}</div>
              <div className="mt-1 text-[0.78rem] leading-snug text-white/55">{s.l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ============================ PROBLEM ============================ */}
      <section className="mx-auto max-w-5xl px-5 py-20 lg:px-8 lg:py-24">
        <Reveal>
          <Eyebrow>The problem</Eyebrow>
          <h2 className="mkt-display mt-4 max-w-2xl text-3xl font-bold text-white sm:text-[2.4rem] sm:leading-[1.05]">
            Your lumens are locked, and the exit is a maze.
          </h2>
          <p className="mt-5 max-w-2xl text-[1.02rem] leading-relaxed text-white/70">
            Every Stellar account holds XLM in reserve: 1 XLM for the account, plus 0.5 for every
            trustline, offer, data entry and signer. That reserve is only recoverable by closing the
            account, and closing one cleanly is harder than it sounds.
          </p>
        </Reveal>

        <div className="mt-11 grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
          <Reveal className="mkt-card p-6">
            <div className="flex items-center justify-between">
              <span className="mkt-eyebrow text-white/45">Locked reserve</span>
              <span className="mkt-mono text-xs text-white/45">example account</span>
            </div>
            <div className="mt-5 space-y-3.5">
              {RESERVE.map((r) => (
                <div key={r.label}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-white/75">{r.label}</span>
                    <span className="mkt-mono text-value tabular-nums">{r.xlm}</span>
                  </div>
                  <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/[0.08]">
                    <div
                      className="h-full rounded-full bg-value"
                      style={{ width: `${r.w * 2}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-5 flex items-baseline justify-between border-t border-white/10 pt-4">
              <span className="text-sm font-semibold text-white">Total locked</span>
              <span className="mkt-display text-2xl font-bold text-value tabular-nums">
                5.00 <span className="text-sm font-normal text-white/45">XLM</span>
              </span>
            </div>
          </Reveal>

          <div className="grid gap-5">
            {TRUTHS.map((t) => (
              <Reveal key={t.title} className="mkt-card flex gap-4 p-5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-stellar">
                  <t.icon className="h-5 w-5" />
                </span>
                <div>
                  <h3 className="text-[0.98rem] font-semibold text-white">{t.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-white/70">{t.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ============================ THE FLOW ============================ */}
      <section className="border-t border-white/[0.07]">
        <div className="mx-auto max-w-5xl px-5 py-20 lg:px-8 lg:py-24">
          <Reveal className="max-w-2xl">
            <Eyebrow>The fix</Eyebrow>
            <h2 className="mkt-display mt-4 text-3xl font-bold text-white sm:text-[2.4rem] sm:leading-[1.05]">
              One guided flow. Eight steps. Everything recovered.
            </h2>
            <p className="mt-5 text-[1.02rem] leading-relaxed text-white/70">
              LumenWipe reads the whole account, builds a deterministic ordered plan, and executes
              it step by step, re-reading live state and simulating before every signature. You
              confirm each move; nothing happens without you.
            </p>
          </Reveal>

          <Reveal className="mt-11 grid gap-x-14 sm:grid-cols-2">
            <div>
              {FLOW.slice(0, 4).map((s, i) => (
                <Step key={s.label} index={i} label={s.label} desc={s.desc} />
              ))}
            </div>
            <div>
              {FLOW.slice(4).map((s, i) => (
                <Step key={s.label} index={i + 4} label={s.label} desc={s.desc} />
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* ============================ CAPABILITIES ============================ */}
      <section className="mx-auto max-w-5xl px-5 py-20 lg:px-8 lg:py-24">
        <Reveal className="max-w-2xl">
          <Eyebrow>What you get</Eyebrow>
          <h2 className="mkt-display mt-4 text-3xl font-bold text-white sm:text-[2.4rem] sm:leading-[1.05]">
            Built for the messy reality of real accounts.
          </h2>
        </Reveal>

        <div className="mt-11 grid gap-4 lg:grid-cols-3">
          <Reveal className="lg:col-span-2">
            <div className="mkt-card h-full p-6 [border-color:hsl(var(--value)/0.25)]">
              <div className="flex items-start justify-between gap-4">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-value/30 bg-value/10 text-value">
                  <Layers className="h-5 w-5" />
                </span>
                <span className="rounded-full border border-value/40 px-2.5 py-1 mkt-mono text-[0.62rem] uppercase tracking-wider text-value">
                  Coming soon
                </span>
              </div>
              <h3 className="mt-4 text-lg font-semibold text-white">Full Soroban DeFi coverage</h3>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-white/70">
                The piece the original demolisher lacks. LumenWipe detects positions through
                OctoPos, then exits each one with its own protocol adapter, repaying loans,
                withdrawing liquidity, and unstaking, before it removes the trustline.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {PROTOCOLS.map((p) => (
                  <span
                    key={p}
                    className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 mkt-mono text-xs text-white/65"
                  >
                    {p}
                  </span>
                ))}
              </div>
            </div>
          </Reveal>

          {FEATURES.map((f) => (
            <Reveal key={f.title}>
              <div className="mkt-card flex h-full flex-col p-5">
                <div className="flex items-center justify-between">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-stellar">
                    <f.icon className="h-5 w-5" />
                  </span>
                  <span className="mkt-mono text-[0.6rem] uppercase tracking-wider text-stellar/80">
                    Live
                  </span>
                </div>
                <h3 className="mt-4 text-[0.98rem] font-semibold text-white">{f.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-white/70">{f.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ============================ TRUST ============================ */}
      <section id="security" className="scroll-mt-20 border-t border-white/[0.07]">
        <div className="mx-auto max-w-5xl px-5 py-20 lg:px-8 lg:py-24">
          <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
            <Reveal>
              <Eyebrow>Trust model</Eyebrow>
              <h2 className="mkt-display mt-4 text-3xl font-bold text-white sm:text-[2.4rem] sm:leading-[1.05]">
                The trust boundary is your browser.
              </h2>
              <p className="mt-5 text-[1.02rem] leading-relaxed text-white/70">
                Your keys are created and used only in your browser and never reach a server. The
                backend can&apos;t touch your account: its one signing key is the shared exchange
                mediator, which can only co-sign a forwarding payment you already authorized.
              </p>
              <div className="mt-8 space-y-2.5">
                {LAYERS.map((layer) => (
                  <div
                    key={layer.label}
                    className={`flex items-center justify-between gap-3 rounded-xl border p-3.5 ${
                      layer.key
                        ? "border-value/40 bg-value/[0.06]"
                        : "border-white/10 bg-white/[0.02]"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-white">{layer.label}</div>
                      <div className="mkt-mono break-words text-[0.68rem] leading-snug text-white/45">
                        {layer.sub}
                      </div>
                    </div>
                    <span
                      className={`mkt-mono shrink-0 whitespace-nowrap text-[0.6rem] uppercase tracking-wider ${
                        layer.key ? "text-value" : "text-white/45"
                      }`}
                    >
                      {layer.note}
                    </span>
                  </div>
                ))}
              </div>
            </Reveal>

            <Reveal delay={100} className="lg:pt-2">
              <ul className="overflow-hidden rounded-2xl border border-white/10">
                {GUARANTEES.map((row) => (
                  <li
                    key={row.title}
                    className="flex gap-3.5 border-t border-white/[0.06] bg-white/[0.02] p-4 first:border-t-0"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-stellar">
                      <row.icon className="h-4 w-4" />
                    </span>
                    <div>
                      <div className="text-sm font-semibold text-white">{row.title}</div>
                      <div className="mt-0.5 text-sm leading-relaxed text-white/55">{row.body}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ============================ DATA LAYER ============================ */}
      <section className="mx-auto max-w-5xl px-5 py-20 lg:px-8 lg:py-24">
        <Reveal className="max-w-2xl">
          <Eyebrow>Data layer</Eyebrow>
          <h2 className="mkt-display mt-4 text-3xl font-bold text-white sm:text-[2.4rem] sm:leading-[1.05]">
            We read the whole account, from sources others skip.
          </h2>
          <p className="mt-5 text-[1.02rem] leading-relaxed text-white/70">
            Indexers lag and miss Soroban state. LumenWipe re-reads exact live state on-chain and
            detects DeFi positions other tools can&apos;t see, so the plan is never built on stale
            data.
          </p>
        </Reveal>

        <div className="mt-11 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {SOURCES.map((s) => (
            <Reveal key={s.name} className="mkt-card p-5">
              <div className="mkt-mono flex items-center gap-2 text-[0.82rem] text-white">
                <span className="h-1.5 w-1.5 rounded-full bg-value" />
                {s.name}
              </div>
              <p className="mt-2.5 text-[0.82rem] leading-relaxed text-white/55">{s.body}</p>
            </Reveal>
          ))}
        </div>
        <p className="mt-5 mkt-mono text-[0.8rem] text-white/45">
          Works with <span className="text-white/75">Freighter, xBull, Albedo, LOBSTR, Hana</span>{" "}
          and <span className="text-white/75">WalletConnect</span>.
        </p>
      </section>

      {/* ============================ FAQ ============================ */}
      <section
        id="faq"
        className="mx-auto max-w-3xl scroll-mt-20 border-t border-white/[0.07] px-5 py-20 lg:px-8 lg:py-24"
      >
        <Reveal className="text-center">
          <Eyebrow>FAQ</Eyebrow>
          <h2 className="mkt-display mt-4 text-3xl font-bold text-white sm:text-[2.4rem]">
            Questions, answered.
          </h2>
          <p className="mt-4 text-white/70">
            Closing an account is irreversible. Here&apos;s exactly how LumenWipe keeps it safe.
          </p>
        </Reveal>
        <div className="mt-10">
          <Faq />
        </div>
        <p className="mt-6 text-center text-sm text-white/55">
          Still curious?{" "}
          <a
            href="https://docs.lumenwipe.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-value underline-offset-4 hover:underline"
          >
            Read the full documentation
          </a>
          .
        </p>
      </section>

      {/* ============================ FINAL CTA ============================ */}
      <section className="mx-auto max-w-5xl px-5 pb-24 lg:px-8">
        <Reveal>
          <div className="mkt-card px-6 py-14 text-center sm:px-12 sm:py-20">
            <h2 className="mkt-display mx-auto max-w-2xl text-3xl font-bold leading-[1.05] text-white sm:text-5xl">
              Reclaim the XLM that&apos;s been sitting locked.
            </h2>
            <p className="mx-auto mt-5 max-w-lg text-[1.02rem] text-white/70">
              Try the entire flow on testnet with no funds at risk, then switch to mainnet for the
              real close.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link href={APP} className={`group ${btnGold}`}>
                Open the app
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link href={TESTNET} className={btnGhost}>
                Try on testnet
              </Link>
            </div>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 mkt-mono text-[0.7rem] text-white/55">
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
        </Reveal>
      </section>
    </>
  );
}
