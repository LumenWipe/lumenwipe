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

export const metadata: Metadata = {
  title: "Security — LumenWipe",
  description:
    "LumenWipe builds transactions that drain accounts irreversibly, so the design starts from that fact. Keys are created and used only in your browser; the read-only backend can never move your funds.",
};

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
    body: "Never transmitted. It stays in your wallet, or in memory only for the duration of the close, never persisted and wiped when you finish, abort, or navigate away.",
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
    title: "Backend compromise",
    body: "Its only key is the shared mediator, which can't sign for your account or divert funds (the forwarding payment is atomic and validated). Wrong read data is caught by simulation and confirmations.",
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
        <span className="mkt-eyebrow inline-flex items-center gap-2 text-white/55">
          <span className="h-px w-5 bg-stellar/60" />
          Trust model
        </span>
        <h1 className="mkt-display mt-4 text-4xl font-bold text-white sm:text-5xl">
          The trust boundary is your browser.
        </h1>
        <p className="mt-5 text-[1.05rem] leading-relaxed text-white/70">
          LumenWipe builds transactions that drain accounts irreversibly, so the design starts from
          that fact. Your keys are created and used only in your browser and never reach a server.
          The backend can&apos;t touch your account: its one signing key is the shared exchange
          mediator, which can only co-sign a forwarding payment you already authorized.
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
          <p className="mkt-mono flex items-center gap-2 pt-2 text-[0.72rem] text-white/45">
            <ShieldCheck className="h-3.5 w-3.5 text-stellar" />0 servers can move your funds
          </p>
        </div>

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
      </div>

      <div className="mt-12 flex flex-wrap items-center gap-3">
        <Link
          href="/mainnet"
          className="group inline-flex items-center gap-2 rounded-xl bg-value px-5 py-3 text-sm font-semibold text-[hsl(var(--value-foreground))] transition-all hover:bg-value/90 hover:shadow-[0_12px_30px_-14px_hsl(var(--value)/0.7)]"
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
