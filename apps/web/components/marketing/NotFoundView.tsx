import type { Metadata } from "next";
import Link from "next/link";
import { Home, ArrowRight, ArrowUpRight, GitMerge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SITE_LOCALE, type Locale } from "@/lib/i18n/locale";
import { COMMON } from "@/lib/i18n/messages/common";
import { NOT_FOUND } from "@/lib/i18n/messages/not-found";
import { localeHref } from "@/lib/site/pages";

/** The 404's title and description in `locale`. */
export function notFoundMetadata(locale: Locale): Metadata {
  return NOT_FOUND[locale].metadata;
}

export const NOT_FOUND_METADATA: Metadata = notFoundMetadata(SITE_LOCALE);

export const REPORT_BROKEN_LINK_URL =
  "https://github.com/LumenWipe/lumenwipe/issues/new?title=Broken%20link%20on%20lumenwipe.com";

export default function NotFoundView({ locale = SITE_LOCALE }: { locale?: Locale }) {
  const T = NOT_FOUND[locale];
  const steps = [
    { label: T.steps.route, ok: true },
    { label: T.steps.ledger, ok: true },
    { label: T.steps.account, ok: false },
  ];
  const stats = [
    { label: T.stats.subentries, value: "0" },
    { label: T.stats.balance, value: "0.0000000" },
    { label: T.stats.statusLabel, value: T.stats.merged },
  ];
  const nextSteps = [
    { href: localeHref(locale, "/content"), label: T.next.guides },
    { href: localeHref(locale, "/how-it-works"), label: T.next.howItWorks },
    { href: localeHref(locale, "/playground"), label: T.next.playground },
  ];
  return (
    <div className="flex items-center justify-center px-5 py-16 lg:py-20">
      <div className="w-full max-w-md">
        <p className="mkt-eyebrow mb-7 text-fg-muted">{T.eyebrow}</p>

        <div className="mb-9 overflow-hidden rounded-2xl border border-white/[0.09] bg-surface/80 backdrop-blur-xs">
          <div className="flex items-center gap-1.5 border-b border-white/[0.07] bg-white/[0.02] px-4 py-3">
            <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/70" />
            <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/70" />
            <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#28c840]/30" />
            <span className="mkt-mono ml-3 text-xs text-fg-muted">{T.consoleTitle}</span>
          </div>

          <div className="space-y-4 px-5 py-5">
            <div className="mkt-mono text-sm">
              <span className="text-fg-muted">$ </span>
              <span className="text-fg-muted">{T.command}</span>
              <span className="text-white">{T.commandTarget}</span>
            </div>

            <ul className="mkt-mono space-y-2 text-sm">
              {steps.map((s) => (
                <li key={s.label} className="flex items-center gap-3">
                  <span aria-hidden className={s.ok ? "text-success" : "text-danger-fg"}>
                    {s.ok ? "✓" : "✗"}
                  </span>
                  <span className={s.ok ? "text-fg-muted" : "text-danger-fg"}>
                    {s.label}
                    {!s.ok && T.failure}
                  </span>
                </li>
              ))}
            </ul>

            <div className="border-t border-white/[0.07] pt-4">
              <div className="grid grid-cols-3 gap-2 text-center">
                {stats.map((s) => (
                  <div key={s.label}>
                    <div className="mkt-mono text-base font-semibold text-fg-muted">{s.value}</div>
                    <div className="mkt-eyebrow mt-1 text-fg-muted">{s.label}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mkt-mono rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-xs text-fg-muted">
              <span className="text-fg-subtle">{T.infoLabel}</span>
              {T.info}
            </div>
          </div>
        </div>

        <h1 className="mkt-display mb-3 text-display font-bold leading-[1] text-white">
          {T.title[0]}
          <br />
          {T.title[1]}
        </h1>
        <p className="mb-8 text-body leading-relaxed text-white/85">
          {T.lede[0]}
          <br />
          {T.lede[1]}
        </p>

        <div className="flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href={localeHref(locale, "/")}>
              <Home className="h-4 w-4" />
              {T.home}
            </Link>
          </Button>
          <Button asChild size="lg" variant="secondary">
            <Link href="/mainnet">
              <GitMerge className="h-4 w-4" />
              {T.openApp}
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>

        <nav aria-label={T.nextLabel} className="mt-8">
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {nextSteps.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="text-accent underline-offset-4 hover:underline">
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-fg-muted">
            {T.followedLink}{" "}
            <a
              href={REPORT_BROKEN_LINK_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-accent underline underline-offset-4"
            >
              {T.reportLink}
              <span className="sr-only">{COMMON[locale].newTab}</span>
              <ArrowUpRight aria-hidden className="h-3 w-3" />
            </a>
          </p>
        </nav>
      </div>
    </div>
  );
}
