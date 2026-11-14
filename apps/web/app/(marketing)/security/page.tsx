import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  KeyRound,
  ScanLine,
  Building2,
  Server,
  Network,
  ShieldCheck,
} from "lucide-react";
import {
  CHECK_STATEMENT,
  KEY_STATEMENT,
  SERVER_KEYS,
  SERVER_KEYS_INTRO,
  serverKeyScope,
  VERIFY_SOURCE_URL,
} from "@/lib/site/trust";

export const metadata: Metadata = {
  title: "Security - LumenWipe",
  description:
    "How LumenWipe keeps your key in your browser, what its API builds, what your browser checks before you sign, and the two server keys and what each may sign.",
};

const LAYERS = [
  {
    label: "Your browser",
    sub: "Wallet · transaction check · signing · session",
    note: "your key stays here",
    key: true,
  },
  {
    label: "LumenWipe API",
    sub: "Account reads · DeFi adapters · builds unsigned transactions · relay and fee-sponsor keys",
    note: "never holds your key",
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
    body: "Never transmitted. It stays in your wallet, or in memory only for the duration of the close, never persisted and cleared when you finish, abort, or navigate away.",
  },
  {
    icon: ScanLine,
    title: "Every destructive step",
    body: "Reviewed as raw XDR and explicitly confirmed before signing. The full plan is shown up front and each step is simulated first.",
  },
  {
    icon: Building2,
    title: "Exchange memo",
    body: "Required and validated against a registry of known exchanges that enforces the memo type; a missing memo blocks submission so deposits don't go missing.",
  },
  {
    icon: Server,
    title: "API compromise",
    body: "It holds no key that can sign for your account, and your browser checks the operations and destination of every transaction it builds before you sign. Figures your browser can only take from the API's own reads, such as a conversion quote, are shown for you to accept.",
  },
  {
    icon: Network,
    title: "Strict CSP",
    body: "No inline scripts, no unsafe-eval. Dependencies are lockfile-pinned and audited in CI; the transaction builder is a pure, unit-tested module with zero network side effects.",
  },
];

export default function SecurityPage() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-24">
      <div className="max-w-2xl">
        <span className="mkt-eyebrow inline-flex items-center gap-2 text-fg-muted">
          <span className="h-px w-5 bg-accent/60" />
          Trust model
        </span>
        <h1 className="mkt-display mt-4 text-4xl font-bold text-white sm:text-5xl">
          The trust boundary is your browser.
        </h1>
        <p className="mt-5 text-body leading-relaxed text-white/70">
          LumenWipe builds transactions that drain accounts irreversibly, so the design starts from
          that fact. {KEY_STATEMENT} {CHECK_STATEMENT}
        </p>
        <p className="mt-4 text-body leading-relaxed text-white/70">
          The check is open source:{" "}
          <a
            href={VERIFY_SOURCE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline underline-offset-4"
          >
            read verify.ts on GitHub<span className="sr-only"> (opens in a new tab)</span>
          </a>
          .
        </p>
      </div>

      <div className="mt-12 grid gap-12 lg:grid-cols-2 lg:gap-16">
        <div className="space-y-2.5">
          {LAYERS.map((layer) => (
            <div
              key={layer.label}
              className={`flex items-center justify-between gap-3 rounded-xl border p-3.5 ${
                layer.key ? "border-value/40 bg-value/[0.06]" : "border-white/10 bg-white/[0.02]"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-white">{layer.label}</div>
                <div className="mkt-mono break-words text-caption leading-snug text-fg-subtle">
                  {layer.sub}
                </div>
              </div>
              <span
                className={`mkt-mono shrink-0 whitespace-nowrap text-caption uppercase tracking-wider ${
                  layer.key ? "text-value" : "text-fg-subtle"
                }`}
              >
                {layer.note}
              </span>
            </div>
          ))}
          <p className="mkt-mono flex items-center gap-2 pt-2 text-caption text-fg-subtle">
            <ShieldCheck className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
            Your key stays in your browser
          </p>
        </div>

        <ul className="overflow-hidden rounded-2xl border border-white/10">
          {GUARANTEES.map((row) => (
            <li
              key={row.title}
              className="flex gap-3.5 border-t border-white/[0.06] bg-white/[0.02] p-4 first:border-t-0"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-accent">
                <row.icon className="h-4 w-4" />
              </span>
              <div>
                <div className="text-sm font-semibold text-white">{row.title}</div>
                <div className="mt-0.5 text-sm leading-relaxed text-fg-muted">{row.body}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-12 max-w-3xl">
        <h2 className="mkt-display text-2xl font-bold text-white">Keys on the server</h2>
        <p className="mt-3 text-body leading-relaxed text-white/70">{SERVER_KEYS_INTRO}</p>
        <dl className="mt-5 space-y-4">
          {SERVER_KEYS.map((key) => (
            <div key={key.name} className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <dt className="text-sm font-semibold text-white">{key.name}</dt>
              <dd className="mt-1 text-sm leading-relaxed text-fg-muted">
                {key.statement} {serverKeyScope(key)}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="mt-12 flex flex-wrap items-center gap-3">
        <Link
          href="/mainnet"
          className="group inline-flex items-center gap-2 rounded-xl bg-value px-5 py-3 text-sm font-semibold text-value-fg transition-all hover:bg-value/90 hover:shadow-[0_12px_30px_-14px_hsl(var(--value)/0.7)]"
        >
          Open the app
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
        <a
          href="https://docs.lumenwipe.com/architecture"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.02] px-5 py-3 text-sm font-semibold text-white/85 transition-colors hover:border-white/30 hover:text-white"
        >
          Read the security model
        </a>
      </div>
    </section>
  );
}
