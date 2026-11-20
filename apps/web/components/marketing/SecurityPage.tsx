import type { Metadata } from "next";
import type { ReactNode } from "react";
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
import { BASE_FEE_STROOPS } from "@/config/constants";
import type { Locale } from "@/lib/i18n/locale";
import { COMMON } from "@/lib/i18n/messages/common";
import { SECURITY } from "@/lib/i18n/messages/security";
import { commitUrl, deployedCommit, shortCommit } from "@/lib/site/build-info";
import { localeHref, localePath, pageMetadata } from "@/lib/site/pages";
import {
  FEE_EVIDENCE,
  fileName,
  GUARANTEE_EVIDENCE,
  repoFileUrl,
  type Evidence,
  type FeeId,
  type GuaranteeId,
} from "@/lib/site/security-evidence";
import {
  featureScope,
  SECURITY_EMAIL,
  SECURITY_POLICY_URL,
  SECURITY_TXT_PATH,
  serverKeys,
  serverKeyScope,
  trustStatements,
  VERIFY_SOURCE_URL,
} from "@/lib/site/trust";
import { stroopsToXlm } from "@/lib/utils/amounts";
import { statusPageUrl } from "@/lib/status/source";

/** A link to a page off the site, labelled for screen readers as opening a new tab. */
function ExternalLink({
  href,
  locale,
  className,
  children,
}: {
  href: string;
  locale: Locale;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className ?? "text-accent underline underline-offset-4"}
    >
      {children}
      <span className="sr-only">{COMMON[locale].newTab}</span>
    </a>
  );
}

/** The files that enforce a statement and the tests that prove it, each linked on GitHub. */
function EvidenceLinks({ evidence, locale }: { evidence: Evidence; locale: Locale }) {
  const T = SECURITY[locale].evidence;
  const rows = [
    { label: T.code, paths: evidence.code },
    { label: T.tests, paths: evidence.tests },
  ];
  return (
    <dl data-evidence className="mt-2 space-y-1 text-caption leading-snug text-fg-subtle">
      {rows.map((row) => (
        <div key={row.label} className="flex flex-wrap items-center gap-x-2">
          <dt>{row.label}</dt>
          <dd className="mkt-mono flex flex-wrap gap-x-2">
            {row.paths.map((path) => (
              <ExternalLink
                key={path}
                href={repoFileUrl(path)}
                locale={locale}
                className="inline-flex min-h-6 items-center break-all text-fg-muted underline underline-offset-2 hover:text-white"
              >
                {fileName(path)}
              </ExternalLink>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The fee table's rows in `locale`, each figure computed from the constant the code charges. */
function feeRows(locale: Locale): { id: FeeId; label: string; value: string }[] {
  const T = SECURITY[locale].fees;
  const withScope = (text: string, scope: string) => (scope ? `${text} ${scope}` : text);
  const base = String(BASE_FEE_STROOPS);
  return [
    { id: "network", label: T.labels.network, value: T.network(base, stroopsToXlm(base)) },
    { id: "service", label: T.labels.service, value: T.service },
    {
      id: "sponsored",
      label: T.labels.sponsored,
      value: withScope(T.sponsored, featureScope("sponsored-fees", locale)),
    },
    {
      id: "relay",
      label: T.labels.relay,
      value: withScope(
        T.relay(String(2 * BASE_FEE_STROOPS)),
        featureScope("exchange-close", locale)
      ),
    },
    { id: "conversion", label: T.labels.conversion, value: T.conversion },
  ];
}

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
  const guarantees: { id: GuaranteeId; icon: typeof KeyRound; title: string; body: string }[] = [
    { id: "key", icon: KeyRound, ...T.guarantees.key },
    { id: "steps", icon: ScanLine, ...T.guarantees.steps },
    { id: "memo", icon: Building2, ...T.guarantees.memo },
    { id: "api", icon: Server, ...T.guarantees.api },
    { id: "csp", icon: Network, ...T.guarantees.csp },
  ];
  const commit = deployedCommit();
  const status = statusPageUrl();
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
                <EvidenceLinks evidence={GUARANTEE_EVIDENCE[row.id]} locale={locale} />
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

      <div className="mt-12 max-w-3xl">
        <h2 className="mkt-display text-2xl font-bold text-white">{T.fees.heading}</h2>
        <p className="mt-3 text-body leading-relaxed text-white/70">{T.fees.intro}</p>
        <dl className="mt-5 space-y-4">
          {feeRows(locale).map((row) => (
            <div
              key={row.id}
              data-fee={row.id}
              className="rounded-xl border border-white/10 bg-white/[0.02] p-4"
            >
              <dt className="text-sm font-semibold text-white">{row.label}</dt>
              <dd className="mt-1 text-sm leading-relaxed text-fg-muted">
                {row.value}
                <EvidenceLinks evidence={FEE_EVIDENCE[row.id]} locale={locale} />
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="mt-12 max-w-3xl">
        <h2 className="mkt-display text-2xl font-bold text-white">{T.build.heading}</h2>
        <p className="mt-3 text-body leading-relaxed text-white/70">
          {commit
            ? T.build.deployed(
                <ExternalLink
                  href={commitUrl(commit)}
                  locale={locale}
                  className="mkt-mono text-accent underline underline-offset-4"
                >
                  {shortCommit(commit)}
                </ExternalLink>
              )
            : T.build.unknown}
        </p>
        <p className="mt-3 text-body leading-relaxed text-white/70">{T.build.untagged}</p>
      </div>

      <div className="mt-12 max-w-3xl">
        <h2 className="mkt-display text-2xl font-bold text-white">{T.disclosure.heading}</h2>
        <p className="mt-3 text-body leading-relaxed text-white/70">
          {T.disclosure.body(
            <a
              href={`mailto:${SECURITY_EMAIL}`}
              className="text-accent underline underline-offset-4"
            >
              {SECURITY_EMAIL}
            </a>,
            <ExternalLink href={SECURITY_POLICY_URL} locale={locale}>
              {T.disclosure.policyLink}
            </ExternalLink>,
            <a
              href={SECURITY_TXT_PATH}
              className="mkt-mono text-accent underline underline-offset-4"
            >
              {SECURITY_TXT_PATH}
            </a>
          )}
        </p>
      </div>

      <div className="mt-12 max-w-3xl">
        <h2 className="mkt-display text-2xl font-bold text-white">{T.reports.heading}</h2>
        <p className="mt-3 text-body leading-relaxed text-white/70">{T.reports.body}</p>
        <p className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-body">
          <Link
            href={localeHref(locale, "/security/reports")}
            className="text-accent underline underline-offset-4"
          >
            {T.reports.link}
          </Link>
          {status && (
            <ExternalLink href={status} locale={locale}>
              {T.statusLink}
            </ExternalLink>
          )}
        </p>
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
