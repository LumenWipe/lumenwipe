import type { Metadata } from "next";
import Link from "next/link";
import { Home, ArrowRight, ArrowUpRight, GitMerge } from "lucide-react";
import { Button } from "@/components/ui/button";

export const NOT_FOUND_METADATA: Metadata = {
  title: "404 - Page Not Found",
  description: "This page doesn't exist on the ledger.",
  // Replaces the root layout's index, follow, which would otherwise sit beside Next's own noindex.
  robots: { index: false, follow: true },
};

export const REPORT_BROKEN_LINK_URL =
  "https://github.com/LumenWipe/lumenwipe/issues/new?title=Broken%20link%20on%20lumenwipe.com";

const STEPS = [
  { label: "Resolving route", ok: true },
  { label: "Querying ledger state", ok: true },
  { label: "Account found", ok: false },
];

const STATS = [
  { label: "Subentries", value: "0" },
  { label: "XLM balance", value: "0.0000000" },
  { label: "Status", value: "MERGED" },
];

const NEXT_STEPS = [
  { href: "/content", label: "Guides" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/playground", label: "Try the playground" },
];

export default function NotFoundView() {
  return (
    <div className="flex items-center justify-center px-5 py-16 lg:py-20">
      <div className="w-full max-w-md">
        <p className="mkt-eyebrow mb-7 text-fg-muted">ledger lookup · error_code: 404</p>

        <div className="mb-9 overflow-hidden rounded-2xl border border-white/[0.09] bg-surface/80 backdrop-blur-xs">
          <div className="flex items-center gap-1.5 border-b border-white/[0.07] bg-white/[0.02] px-4 py-3">
            <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/70" />
            <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/70" />
            <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#28c840]/30" />
            <span className="mkt-mono ml-3 text-xs text-fg-muted">lumenwipe · account-lookup</span>
          </div>

          <div className="space-y-4 px-5 py-5">
            <div className="mkt-mono text-sm">
              <span className="text-fg-muted">$ </span>
              <span className="text-fg-muted">lw analyze --network mainnet </span>
              <span className="text-white">this-page</span>
            </div>

            <ul className="mkt-mono space-y-2 text-sm">
              {STEPS.map((s) => (
                <li key={s.label} className="flex items-center gap-3">
                  <span aria-hidden className={s.ok ? "text-success" : "text-danger-fg"}>
                    {s.ok ? "✓" : "✗"}
                  </span>
                  <span className={s.ok ? "text-fg-muted" : "text-danger-fg"}>
                    {s.label}
                    {!s.ok && " - account_not_found"}
                  </span>
                </li>
              ))}
            </ul>

            <div className="border-t border-white/[0.07] pt-4">
              <div className="grid grid-cols-3 gap-2 text-center">
                {STATS.map((s) => (
                  <div key={s.label}>
                    <div className="mkt-mono text-base font-semibold text-fg-muted">{s.value}</div>
                    <div className="mkt-eyebrow mt-1 text-fg-muted">{s.label}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mkt-mono rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-xs text-fg-muted">
              <span className="text-fg-subtle">info </span>
              This account was merged out. Nothing remains on the ledger.
            </div>
          </div>
        </div>

        <h1 className="mkt-display mb-3 text-display font-bold leading-[1] text-white">
          This page has
          <br />
          been closed.
        </h1>
        <p className="mb-8 text-body leading-relaxed text-white/85">
          No trustlines. No balance. No subentries.
          <br />
          Looks like this route was already merged out.
        </p>

        <div className="flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/">
              <Home className="h-4 w-4" />
              Back to home
            </Link>
          </Button>
          <Button asChild size="lg" variant="secondary">
            <Link href="/mainnet">
              <GitMerge className="h-4 w-4" />
              Open the app
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>

        <nav aria-label="Where to go next" className="mt-8">
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {NEXT_STEPS.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="text-accent underline-offset-4 hover:underline">
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-fg-muted">
            Followed a link here?{" "}
            <a
              href={REPORT_BROKEN_LINK_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-accent underline underline-offset-4"
            >
              Report a broken link
              <span className="sr-only"> (opens in a new tab)</span>
              <ArrowUpRight aria-hidden className="h-3 w-3" />
            </a>
          </p>
        </nav>
      </div>
    </div>
  );
}
