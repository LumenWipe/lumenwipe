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
import { Button } from "@/components/ui/button";
import type { Locale } from "@/lib/i18n/locale";
import { COMMON } from "@/lib/i18n/messages/common";
import { SECURITY } from "@/lib/i18n/messages/security";
import { localeHref, localePath, pageMetadata } from "@/lib/site/pages";
import { serverKeys, serverKeyScope, trustStatements, VERIFY_SOURCE_URL } from "@/lib/site/trust";

/** The security page's metadata in `locale`. */
export function securityMetadata(locale: Locale): Metadata {
  return pageMetadata({
    path: localePath(locale, "/security"),
    locale,
    title: SECURITY[locale].metadata.title,
    description: SECURITY[locale].metadata.description,
  });
}

/** The security page in `locale`. */
export default function SecurityPage({ locale }: { locale: Locale }) {
  const T = SECURITY[locale];
  const trust = trustStatements(locale);
  const layers = [
    { ...T.layers.browser, key: true },
    { ...T.layers.api, key: false },
    { ...T.layers.network, key: false },
  ];
  const guarantees = [
    { icon: KeyRound, ...T.guarantees.key },
    { icon: ScanLine, ...T.guarantees.steps },
    { icon: Building2, ...T.guarantees.memo },
    { icon: Server, ...T.guarantees.api },
    { icon: Network, ...T.guarantees.csp },
  ];
  return (
    <section className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-24">
      <div className="max-w-2xl">
        <span className="mkt-eyebrow inline-flex items-center gap-2 text-fg-muted">
          <span className="h-px w-5 bg-line-strong" />
          {T.eyebrow}
        </span>
        <h1 className="mkt-display mt-4 text-4xl font-bold text-white sm:text-5xl">{T.heading}</h1>
        <p className="mt-5 text-body leading-relaxed text-white/70">
          {T.lede(trust.key, trust.check)}
        </p>
        <p className="mt-4 text-body leading-relaxed text-white/70">
          {T.openSource(
            <a
              href={VERIFY_SOURCE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline underline-offset-4"
            >
              {T.verifyLink}
              <span className="sr-only">{COMMON[locale].newTab}</span>
            </a>,
            <Link
              href={localeHref(locale, "/registry")}
              className="text-accent underline underline-offset-4"
            >
              {T.registryLink}
            </Link>
          )}
        </p>
      </div>

      <div className="mt-12 grid gap-12 lg:grid-cols-2 lg:gap-16">
        <div className="space-y-2.5">
          {layers.map((layer) => (
            <div
              key={layer.label}
              className={`flex items-center justify-between gap-3 rounded-xl border p-3.5 ${
                layer.key ? "border-accent/40 bg-accent/[0.06]" : "border-white/10 bg-white/[0.02]"
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
                  layer.key ? "text-white" : "text-fg-subtle"
                }`}
              >
                {layer.note}
              </span>
            </div>
          ))}
          <p className="mkt-mono flex items-center gap-2 pt-2 text-caption text-fg-subtle">
            <ShieldCheck className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
            {T.keyStays}
          </p>
        </div>

        <ul className="overflow-hidden rounded-2xl border border-white/10">
          {guarantees.map((row) => (
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
        <h2 className="mkt-display text-2xl font-bold text-white">{T.serverKeysHeading}</h2>
        <p className="mt-3 text-body leading-relaxed text-white/70">{trust.serverKeysIntro}</p>
        <dl className="mt-5 space-y-4">
          {serverKeys(locale).map((key) => (
            <div key={key.name} className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <dt className="text-sm font-semibold text-white">{key.name}</dt>
              <dd className="mt-1 text-sm leading-relaxed text-fg-muted">
                {key.statement} {serverKeyScope(key, locale)}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="mt-12 flex flex-wrap items-center gap-3">
        <Button asChild size="lg" className="group">
          <Link href="/mainnet">
            {T.openApp}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </Button>
        <Button asChild size="lg" variant="secondary">
          <a
            href="https://docs.lumenwipe.com/architecture"
            target="_blank"
            rel="noopener noreferrer"
          >
            {T.securityModel}
          </a>
        </Button>
      </div>
    </section>
  );
}
