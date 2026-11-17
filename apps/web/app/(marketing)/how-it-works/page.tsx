import type { Metadata } from "next";
import { pageMetadata } from "@/lib/site/pages";
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
import { LIVE_EXIT_PROTOCOLS } from "@/lib/site/status";
import { Button } from "@/components/ui/button";
import { SITE_LOCALE } from "@/lib/i18n/locale";
import { HOW_IT_WORKS } from "@/lib/i18n/messages/how-it-works";

const T = HOW_IT_WORKS[SITE_LOCALE];

export const metadata: Metadata = pageMetadata({
  path: "/how-it-works",
  title: T.metadata.title,
  description: T.metadata.description,
});

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="mkt-eyebrow inline-flex items-center gap-2 text-fg-muted">
      <span className="h-px w-6 bg-line-strong" />
      {children}
    </span>
  );
}

const LOOP = [
  { icon: RefreshCw, ...T.loop.steps.reread },
  { icon: Eye, ...T.loop.steps.simulate },
  { icon: CheckCircle2, ...T.loop.steps.confirm },
  { icon: PenTool, ...T.loop.steps.sign },
  { icon: Send, ...T.loop.steps.submit },
  { icon: ArrowRight, ...T.loop.steps.poll },
];

const STEPS = [
  { icon: Search, ...T.plan.steps.analyze },
  { icon: KeyRound, ...T.plan.steps.signers },
  { icon: Database, ...T.plan.steps.data },
  { icon: XCircle, ...T.plan.steps.offers },
  {
    icon: Layers,
    ...T.plan.steps.defi,
    op: T.plan.steps.defi.op(LIVE_EXIT_PROTOCOLS.map((p) => p.name)),
  },
  { icon: ArrowLeftRight, ...T.plan.steps.convert },
  { icon: Unlink, ...T.plan.steps.trustlines },
  { icon: GitMerge, ...T.plan.steps.merge },
];

const MACHINE = T.resume.phases;

export default function HowItWorksPage() {
  return (
    <>
      {/* hero */}
      <section className="mx-auto max-w-4xl px-5 pb-14 pt-16 text-center lg:px-8 lg:pt-24">
        <Reveal>
          <Eyebrow>{T.hero.eyebrow}</Eyebrow>
          <h1 className="mkt-display mx-auto mt-5 max-w-3xl text-display font-extrabold leading-[1.02] text-white sm:text-6xl">
            {T.hero.heading}
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-body leading-relaxed text-white/85">
            {T.hero.body}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg" className="group">
              <Link href="/mainnet">
                {T.hero.openApp}
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="secondary">
              <Link href="/faq">{T.hero.faq}</Link>
            </Button>
          </div>
        </Reveal>
      </section>

      {/* execution loop */}
      <section className="border-y border-white/8 bg-white/[0.012]">
        <div className="mx-auto max-w-6xl px-5 py-16 lg:px-8 lg:py-20">
          <Reveal className="max-w-2xl">
            <Eyebrow>{T.loop.eyebrow}</Eyebrow>
            <h2 className="mkt-display mt-4 text-2xl font-bold text-white sm:text-4xl">
              {T.loop.heading}
            </h2>
            <p className="mt-4 leading-relaxed text-white/85">{T.loop.body}</p>
          </Reveal>

          <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {LOOP.map((s, i) => (
              <Reveal key={s.label} delay={i * 60}>
                <div className="relative flex h-full flex-col items-start rounded-xl border border-white/10 bg-surface/70 p-4">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
                    <s.icon className="h-4 w-4" />
                  </span>
                  <h3 className="mt-3 text-sm font-semibold text-white">{s.label}</h3>
                  <p className="mt-0.5 mkt-mono text-caption text-fg-muted">{s.note}</p>
                </div>
              </Reveal>
            ))}
          </div>
          <p className="mt-5 inline-flex items-center gap-2 mkt-mono text-xs text-fg-muted">
            <Repeat className="h-3.5 w-3.5 text-accent" />
            {T.loop.repeats}
          </p>
        </div>
      </section>

      {/* the eight steps */}
      <section className="mx-auto max-w-4xl px-5 py-20 lg:px-8 lg:py-28">
        <Reveal className="max-w-2xl">
          <Eyebrow>{T.plan.eyebrow}</Eyebrow>
          <h2 className="mkt-display mt-4 text-3xl font-bold text-white sm:text-display sm:leading-[1.05]">
            {T.plan.heading}
          </h2>
        </Reveal>

        <ol className="mt-12 space-y-3">
          {STEPS.map((s, i) => (
            <Reveal as="li" key={s.title} delay={i * 40}>
              <div className="group relative flex gap-5 rounded-2xl border border-white/10 bg-white/[0.02] p-5 transition-colors hover:border-accent/30 sm:p-6">
                <div className="flex flex-col items-center">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                    <s.icon className="h-5 w-5" />
                  </span>
                  {i < STEPS.length - 1 && (
                    <span className="mt-2 w-px flex-1 bg-gradient-to-b from-white/15 to-transparent" />
                  )}
                </div>
                <div className="min-w-0 pb-1">
                  <div className="flex items-center gap-3">
                    <span className="mkt-mono text-xs text-fg-subtle">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <h3 className="text-base font-semibold text-white">{s.title}</h3>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-white/85">{s.body}</p>
                  <div className="mt-3 inline-flex items-center gap-2 rounded-lg border border-white/8 bg-black/30 px-2.5 py-1 mkt-mono text-caption text-fg-muted">
                    <span className="text-fg-muted">{T.plan.opLabel}</span>
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
            <Eyebrow>{T.relay.eyebrow}</Eyebrow>
            <h2 className="mkt-display mt-4 text-3xl font-bold text-white sm:text-display sm:leading-[1.05]">
              {T.relay.heading}
            </h2>
            <p className="mt-5 leading-relaxed text-white/85">
              {T.relay.body((text) => (
                <span className="mkt-mono text-white/80">{text}</span>
              ))}
            </p>
          </Reveal>

          <Reveal delay={100}>
            <div className="mkt-panel mt-10 rounded-2xl p-6 sm:p-8">
              <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
                {[
                  { ...T.relay.nodes.source, tone: "white" },
                  { op: T.relay.nodes.merge },
                  { ...T.relay.nodes.relay, tone: "accent" },
                  { op: T.relay.nodes.payment },
                  { ...T.relay.nodes.exchange, tone: "white" },
                ].map((node, i) =>
                  "op" in node ? (
                    <div
                      key={i}
                      className="flex flex-row items-center justify-center gap-2 text-fg-muted sm:flex-col"
                    >
                      <ArrowRight className="hidden h-4 w-4 sm:block" />
                      <ArrowDown className="h-4 w-4 sm:hidden" />
                      <span className="mkt-mono text-caption uppercase tracking-wider text-fg-muted">
                        {node.op}
                      </span>
                    </div>
                  ) : (
                    <div
                      key={i}
                      className={`flex-1 rounded-xl border p-4 text-center ${
                        node.tone === "accent"
                          ? "border-accent/40 bg-accent/[0.06]"
                          : "border-white/12 bg-white/[0.03]"
                      }`}
                    >
                      <div className="text-sm font-semibold text-white">{node.label}</div>
                      <div className="mt-1 text-caption text-fg-muted">{node.sub}</div>
                    </div>
                  )
                )}
              </div>
              <p className="mt-6 text-center text-sm text-fg-muted">{T.relay.footnote}</p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* state machine + architecture */}
      <section className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-28">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
          <Reveal>
            <Eyebrow>{T.resume.eyebrow}</Eyebrow>
            <h2 className="mkt-display mt-4 text-2xl font-bold text-white sm:text-3xl">
              {T.resume.heading}
            </h2>
            <p className="mt-4 leading-relaxed text-white/85">{T.resume.body}</p>
            <div className="mt-7 flex flex-wrap items-center gap-2">
              {MACHINE.map((s, i) => (
                <span key={s} className="inline-flex items-center gap-2">
                  <span className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 mkt-mono text-xs text-white/70">
                    {s}
                  </span>
                  {i < MACHINE.length - 1 && (
                    <ArrowRight className="h-3.5 w-3.5 text-fg-disabled" />
                  )}
                </span>
              ))}
            </div>
          </Reveal>

          <Reveal delay={100}>
            <Eyebrow>{T.architecture.eyebrow}</Eyebrow>
            <h2 className="mkt-display mt-4 text-2xl font-bold text-white sm:text-3xl">
              {T.architecture.heading}
            </h2>
            <p className="mt-4 leading-relaxed text-white/85">{T.architecture.body}</p>
            <div className="mt-7 space-y-2.5">
              {[
                { ...T.architecture.rows.browser, tone: true },
                { ...T.architecture.rows.api, tone: false },
                { ...T.architecture.rows.network, tone: false },
              ].map((row) => (
                <div
                  key={row.label}
                  className={`flex items-center justify-between gap-3 rounded-xl border p-3.5 ${
                    row.tone
                      ? "border-accent/40 bg-accent/[0.06]"
                      : "border-white/10 bg-white/[0.02]"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white">{row.label}</div>
                    <div className="truncate mkt-mono text-caption text-fg-muted">{row.sub}</div>
                  </div>
                  <span
                    className={`shrink-0 mkt-mono text-caption uppercase tracking-wider ${
                      row.tone ? "text-white" : "text-fg-muted"
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
          <Eyebrow>{T.faq.eyebrow}</Eyebrow>
          <h2 className="mkt-display mt-4 text-3xl font-bold text-white sm:text-4xl">
            {T.faq.heading}
          </h2>
        </Reveal>
        <div className="mt-10">
          <Faq />
        </div>
        <div className="mt-12 flex flex-col items-center gap-4 rounded-2xl border border-white/10 bg-surface p-8 text-center">
          <h3 className="mkt-display text-xl font-bold text-white">{T.ready.heading}</h3>
          <Button asChild size="lg" className="group">
            <Link href="/mainnet">
              {T.ready.openApp}
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Button>
        </div>
      </section>
    </>
  );
}
