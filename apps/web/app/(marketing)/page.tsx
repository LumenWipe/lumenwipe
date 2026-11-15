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
  type LucideIcon,
} from "lucide-react";
import Faq from "@/components/marketing/Faq";
import Reveal from "@/components/marketing/Reveal";
import HeroConsole from "@/components/marketing/HeroConsole";
import HeroAccountInput from "@/components/marketing/HeroAccountInput";
import { Button } from "@/components/ui/button";
import { BASE_RESERVE_XLM, MINIMUM_BALANCE_RESERVES } from "@/lib/site/reserve";
import { RESERVE_EXAMPLE, RESERVE_EXAMPLE_TOTAL, STATS, monthYear } from "@/lib/site/numbers";
import {
  feature,
  LIVE_EXIT_PROTOCOLS,
  listNames,
  protocolsWithStatus,
  STATUS_LABEL,
  type FeatureId,
} from "@/lib/site/status";

export const metadata: Metadata = {
  title: "LumenWipe: Recover the XLM locked in your Stellar account",
  description: `LumenWipe closes a Stellar account end to end and recovers the XLM locked in its reserves. Unwind trustlines, offers, data entries and Soroban DeFi positions, then merge out to ${feature("exchange-close").status === "live" ? "your wallet or exchange" : "your wallet"}. Non-custodial, open source.`,
};

const CARD_IDS = [
  "allowance-inspector",
  "exchange-close",
  "resumable-sessions",
  "deterministic-plan",
] as const satisfies readonly FeatureId[];

const FEATURE_ICONS: Record<(typeof CARD_IDS)[number], LucideIcon> = {
  "allowance-inspector": Eye,
  "exchange-close": Building2,
  "resumable-sessions": RefreshCw,
  "deterministic-plan": ScanLine,
};

const APP = "/mainnet";
const TESTNET = "/testnet";

const TRUTHS = [
  {
    icon: RefreshCw,
    title: "One mistake and it all reverts",
    body: "A single leftover entry makes the final merge fail. Every offer, position, asset and entry must clear in the right order first.",
  },
  {
    icon: Building2,
    title: "Exchanges can't merge",
    body: `No major exchange accepts an account merge as a deposit. Pay your XLM out to an exchange instead and the ${MINIMUM_BALANCE_RESERVES * BASE_RESERVE_XLM} XLM minimum stays locked in the account.`,
  },
  {
    icon: Layers,
    title: "DeFi positions hide outside the account",
    body: "A Blend loan, Aquarius liquidity or a Soroswap position lives in the protocol's contract. Merge the account while one is open and the funds stay stranded there, so each has to be exited through its own contract first.",
  },
];

const CARD_FEATURES = CARD_IDS.map((id) => ({ ...feature(id), icon: FEATURE_ICONS[id] }));

const DEFI = feature("defi-exits");
const TESTNET_ONLY_EXITS = protocolsWithStatus("testnet-only");

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="mkt-eyebrow inline-flex items-center gap-2 text-fg-muted">
      <span className="h-px w-5 bg-accent/60" />
      {children}
    </span>
  );
}

export default function LandingPage() {
  return (
    <>
      {/* ============================ HERO ============================ */}
      <section className="mx-auto max-w-6xl px-5 pb-10 pt-16 text-center lg:px-8 lg:pt-20">
        {/* Label - typographic, not a status pill */}
        <div className="mb-8 flex items-center justify-center gap-4">
          <span className="hidden h-px w-12 bg-white/15 sm:block" />
          <span className="mkt-mono text-caption uppercase tracking-[0.18em] text-fg-subtle">
            Recover your locked XLM
          </span>
          <span className="hidden h-px w-12 bg-white/15 sm:block" />
        </div>

        <h1 className="mkt-display mx-auto max-w-[15ch] text-display font-extrabold leading-[0.95] text-white sm:text-6xl lg:text-hero">
          Close the account. Keep the <span className="text-value">lumens.</span>
        </h1>

        <p className="mx-auto mt-6 max-w-xl text-body leading-relaxed text-white/70">
          Get back the {MINIMUM_BALANCE_RESERVES * BASE_RESERVE_XLM} XLM every account must hold,
          plus {BASE_RESERVE_XLM} XLM for each trustline, offer, data entry and signer. LumenWipe
          clears them, exits your DeFi positions, converts what is left to XLM and sends it all to
          your wallet. You sign every transaction in your browser.
        </p>

        {/* Inline account analyzer */}
        <div className="mt-8">
          <HeroAccountInput />
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm">
          <Link
            href={APP}
            className="group inline-flex items-center gap-1 font-semibold text-accent underline-offset-4 hover:underline"
          >
            Open the app
            <ArrowRight
              aria-hidden
              className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
            />
          </Link>
          <Link href="/how-it-works" className="text-accent underline-offset-4 hover:underline">
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
        <dl className="mx-auto grid max-w-6xl grid-cols-1 divide-white/[0.07] px-5 sm:grid-cols-3 sm:divide-x lg:px-8">
          {STATS.map((s, i) => (
            <div
              key={s.label}
              className={`flex flex-col px-4 py-6 ${i > 0 ? "border-t border-white/[0.07] sm:border-t-0" : ""}`}
            >
              <dt className="order-2 mt-1 text-label leading-snug text-fg-muted">{s.label}</dt>
              <dd className="order-1 mkt-display text-2xl font-bold text-white sm:text-3xl">
                {s.value}
              </dd>
              <dd className="order-3 mt-2 mkt-mono text-caption text-fg-muted">
                {s.source.kind === "external" ? (
                  <>
                    As of {monthYear(s.source.asOf)} ·{" "}
                    <a
                      href={s.source.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-4 hover:text-white"
                    >
                      Source: {s.source.label}
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </>
                ) : (
                  "From the contract registry"
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {/* ============================ PROBLEM ============================ */}
      <section className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-24">
        <Reveal>
          <Eyebrow>The problem</Eyebrow>
          <h2 className="mkt-display mt-4 max-w-2xl text-3xl font-bold text-white sm:text-display sm:leading-[1.05]">
            Your lumens are locked, and the exit is a maze.
          </h2>
          <p className="mt-5 max-w-2xl text-body leading-relaxed text-white/70">
            Every Stellar account holds XLM in reserve: 1 XLM for the account, plus 0.5 for every
            trustline, offer, data entry and signer. That reserve is only recoverable by closing the
            account, and closing one cleanly is harder than it sounds.
          </p>
        </Reveal>

        <div className="mt-11 grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
          <Reveal className="mkt-card p-6">
            <div className="flex items-center justify-between">
              <span className="mkt-eyebrow text-fg-subtle">Locked reserve</span>
              <span className="mkt-mono text-caption text-fg-muted">Example account</span>
            </div>
            <div className="mt-5 space-y-3.5">
              {RESERVE_EXAMPLE.map((r) => (
                <div key={r.label}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-white/75">{r.label}</span>
                    <span className="mkt-mono text-value tabular-nums">{r.xlm.toFixed(2)}</span>
                  </div>
                  <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/[0.08]">
                    <div
                      className="h-full rounded-full bg-value"
                      style={{ width: `${(r.xlm / RESERVE_EXAMPLE_TOTAL) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-5 flex items-baseline justify-between border-t border-white/10 pt-4">
              <span className="text-sm font-semibold text-white">Total locked</span>
              <span className="mkt-display text-2xl font-bold text-value tabular-nums">
                {RESERVE_EXAMPLE_TOTAL.toFixed(2)}{" "}
                <span className="text-sm font-normal text-fg-muted">XLM</span>
              </span>
            </div>
          </Reveal>

          <div className="grid gap-5">
            {TRUTHS.map((t) => (
              <Reveal key={t.title} className="mkt-card flex gap-4 p-5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-accent">
                  <t.icon className="h-5 w-5" />
                </span>
                <div>
                  <h3 className="text-body font-semibold text-white">{t.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-white/70">{t.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ============================ CAPABILITIES ============================ */}
      <section className="mx-auto max-w-6xl border-t border-white/[0.07] px-5 py-20 lg:px-8 lg:py-24">
        <Reveal className="max-w-2xl">
          <Eyebrow>What you get</Eyebrow>
          <h2 className="mkt-display mt-4 text-3xl font-bold text-white sm:text-display sm:leading-[1.05]">
            Built for the messy reality of real accounts.
          </h2>
        </Reveal>

        <div className="mt-11 grid gap-4 lg:grid-cols-3">
          <Reveal className="lg:col-span-2">
            <div className="mkt-card h-full p-6 [border-color:hsl(var(--accent)/0.25)]">
              <div className="flex items-start justify-between gap-4">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-accent">
                  <Layers className="h-5 w-5" />
                </span>
                <span className="rounded-full border border-accent/40 px-2.5 py-1 mkt-mono text-caption uppercase tracking-wider text-accent">
                  {STATUS_LABEL[DEFI.status]}
                </span>
              </div>
              <h3 className="mt-4 text-lg font-semibold text-white">{DEFI.title}</h3>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-white/70">{DEFI.summary}</p>
              <ul
                aria-label="Protocol exits live on mainnet"
                className="mt-5 flex flex-wrap gap-2"
                data-site-status="live"
              >
                {LIVE_EXIT_PROTOCOLS.map((p) => (
                  <li
                    key={p.id}
                    className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 mkt-mono text-xs text-white/70"
                  >
                    {p.name}
                  </li>
                ))}
              </ul>
              {TESTNET_ONLY_EXITS.length > 0 && (
                <p className="mt-3 text-sm text-fg-muted" data-site-status="testnet-only">
                  {STATUS_LABEL["testnet-only"]}: {listNames(TESTNET_ONLY_EXITS)}
                </p>
              )}
            </div>
          </Reveal>

          {CARD_FEATURES.map((f) => (
            <Reveal key={f.title}>
              <div className="mkt-card flex h-full flex-col p-5">
                <div className="flex items-center justify-between">
                  <span
                    className={`flex h-10 w-10 items-center justify-center rounded-lg border ${
                      f.status === "live"
                        ? "border-white/10 bg-white/[0.03] text-accent"
                        : "border-white/10 bg-white/[0.03] text-fg-muted"
                    }`}
                  >
                    <f.icon className="h-5 w-5" />
                  </span>
                  <span
                    className={`mkt-mono rounded-full border px-2.5 py-1 text-caption uppercase tracking-wider ${
                      f.status === "live"
                        ? "border-accent/40 text-accent"
                        : "border-line-strong text-fg-muted"
                    }`}
                  >
                    {STATUS_LABEL[f.status]}
                  </span>
                </div>
                <h3 className="mt-4 text-body font-semibold text-white">{f.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-white/70">{f.summary}</p>
                {f.link && (
                  <Link
                    href={f.link.href}
                    className="mt-auto inline-flex items-center gap-1.5 pt-4 text-sm font-semibold text-accent underline-offset-4 hover:underline"
                  >
                    {f.link.label}
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                )}
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ============================ FAQ ============================ */}
      <section
        id="faq"
        className="mx-auto max-w-3xl scroll-mt-20 border-t border-white/[0.07] px-5 py-20 lg:px-8 lg:py-24"
      >
        <Reveal className="text-center">
          <Eyebrow>FAQ</Eyebrow>
          <h2 className="mkt-display mt-4 text-3xl font-bold text-white sm:text-display">
            Questions, answered.
          </h2>
          <p className="mt-4 text-white/70">
            Closing an account is irreversible. Here&apos;s exactly how LumenWipe keeps it safe.
          </p>
        </Reveal>
        <div className="mt-10">
          <Faq />
        </div>
        <p className="mt-6 text-center text-sm text-fg-muted">
          Still curious?{" "}
          <a
            href="https://docs.lumenwipe.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline-offset-4 hover:underline"
          >
            Read the full documentation
          </a>
          .
        </p>
      </section>

      {/* ============================ FINAL CTA ============================ */}
      <section className="mx-auto max-w-6xl px-5 pb-24 lg:px-8">
        <Reveal>
          <div className="mkt-card px-6 py-14 text-center sm:px-12 sm:py-20">
            <h2 className="mkt-display mx-auto max-w-2xl text-3xl font-bold leading-[1.05] text-white sm:text-5xl">
              Reclaim the XLM that&apos;s been sitting locked.
            </h2>
            <p className="mx-auto mt-5 max-w-lg text-body text-white/70">
              Try the entire flow on testnet with no funds at risk, then switch to mainnet for the
              real close.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button asChild size="lg" className="group">
                <Link href={APP}>
                  Open the app
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="secondary">
                <Link href={TESTNET}>Try on testnet</Link>
              </Button>
            </div>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 mkt-mono text-caption text-fg-muted">
              <span className="inline-flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5 text-accent" /> No signup
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5 text-accent" /> Signed in your browser
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5 text-accent" /> Open source
              </span>
            </div>
          </div>
        </Reveal>
      </section>
    </>
  );
}
