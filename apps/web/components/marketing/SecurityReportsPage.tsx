import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { Locale } from "@/lib/i18n/locale";
import { COMMON } from "@/lib/i18n/messages/common";
import { SECURITY_REPORTS } from "@/lib/i18n/messages/security-reports";
import { commitUrl, shortCommit } from "@/lib/site/build-info";
import { DOCS_URL } from "@/lib/site/navigation";
import { localeHref, localePath, pageMetadata } from "@/lib/site/pages";
import {
  securityReports,
  SEVERITIES,
  severityCounts,
  type SecurityReport,
} from "@/lib/security-reports";

/** The self-assessed documents that stand in for a report until one is published. */
const SELF_ASSESSED = [
  { id: "threatModel", href: `${DOCS_URL}/threat-model` },
  { id: "remediationPlan", href: `${DOCS_URL}/security-remediation-plan` },
] as const;

/** The security reports page's metadata in `locale`. */
export function securityReportsMetadata(locale: Locale): Metadata {
  return pageMetadata({
    path: localePath(locale, "/security/reports"),
    locale,
    title: SECURITY_REPORTS[locale].metadata.title,
    description: SECURITY_REPORTS[locale].metadata.description,
  });
}

function EmptyState({ locale }: { locale: Locale }) {
  const T = SECURITY_REPORTS[locale].empty;
  return (
    <div data-reports-empty className="mt-12 max-w-3xl">
      <h2 className="mkt-display text-2xl font-bold text-white">{T.heading}</h2>
      <p className="mt-3 text-body leading-relaxed text-white/70">{T.body}</p>
      <ul className="mt-5 space-y-4">
        {SELF_ASSESSED.map((doc) => (
          <li key={doc.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <span className="mkt-mono text-caption uppercase tracking-wider text-fg-subtle">
              {T.selfAssessed}
            </span>
            <a
              href={doc.href}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 flex items-center gap-1 text-sm font-semibold text-white underline underline-offset-4"
            >
              {T.documents[doc.id].title}
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">{COMMON[locale].newTab}</span>
            </a>
            <p className="mt-1 text-sm leading-relaxed text-fg-muted">{T.documents[doc.id].body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReportEntry({ report, locale }: { report: SecurityReport; locale: Locale }) {
  const T = SECURITY_REPORTS[locale];
  const counts = severityCounts(report);
  // Report entries are written once, in English: a Spanish page marks them as such.
  const lang = locale === "en" ? undefined : "en";
  return (
    <article
      id={report.id}
      data-report={report.id}
      className="rounded-2xl border border-white/10 bg-white/[0.02] p-5"
    >
      <h2 lang={lang} className="mkt-display text-xl font-bold text-white">
        {report.title}
      </h2>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-fg-subtle">{T.report.scope}</dt>
          <dd lang={lang} className="text-fg-muted">
            {report.scope}
          </dd>
        </div>
        <div>
          <dt className="text-fg-subtle">{T.report.date}</dt>
          <dd className="text-fg-muted">
            <time dateTime={report.date}>{report.date}</time>
          </dd>
        </div>
        <div>
          <dt className="text-fg-subtle">{T.report.performedBy}</dt>
          <dd lang={lang} className="text-fg-muted">
            {report.performedBy}
          </dd>
        </div>
        <div>
          <dt className="text-fg-subtle">{T.report.commit}</dt>
          <dd>
            <a
              href={commitUrl(report.commit)}
              target="_blank"
              rel="noopener noreferrer"
              className="mkt-mono text-accent underline underline-offset-4"
            >
              {shortCommit(report.commit)}
              <span className="sr-only">{COMMON[locale].newTab}</span>
            </a>
          </dd>
        </div>
      </dl>

      <h3 className="mt-5 text-sm font-semibold text-white">{T.report.summary}</h3>
      <dl className="mt-2 flex flex-wrap gap-2 text-sm">
        {SEVERITIES.map((severity) => (
          <div
            key={severity}
            data-severity={severity}
            className="flex gap-1.5 rounded-lg border border-white/10 px-2.5 py-1"
          >
            <dt className="text-fg-subtle">{T.severity[severity]}</dt>
            <dd className="mkt-mono text-white">{counts[severity]}</dd>
          </div>
        ))}
      </dl>

      <h3 className="mt-5 text-sm font-semibold text-white">{T.report.findings}</h3>
      {report.findings.length === 0 ? (
        <p className="mt-2 text-sm text-fg-muted">{T.report.noFindings}</p>
      ) : (
        <ul className="mt-2 space-y-1.5 text-sm">
          {report.findings.map((finding) => (
            <li key={finding.id} data-finding={finding.id} className="flex flex-wrap gap-x-3">
              <span className="mkt-mono text-fg-subtle">{finding.id}</span>
              <span lang={lang} className="text-fg-muted">
                {finding.title}
              </span>
              <span className="text-fg-subtle">{T.severity[finding.severity]}</span>
              <span className="text-white">{T.status[finding.status]}</span>
            </li>
          ))}
        </ul>
      )}

      <a
        href={report.reportUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-5 inline-flex text-sm text-accent underline underline-offset-4"
      >
        {T.report.fullReport}
        <span className="sr-only">{COMMON[locale].newTab}</span>
      </a>
    </article>
  );
}

/** The security reports page in `locale`: every published report, or what exists until one is. */
export default function SecurityReportsPage({
  locale,
  reports = securityReports(),
}: {
  locale: Locale;
  reports?: readonly SecurityReport[];
}) {
  const T = SECURITY_REPORTS[locale];
  return (
    <section className="mx-auto max-w-6xl px-5 py-20 lg:px-8 lg:py-24">
      <div className="max-w-2xl">
        <span className="mkt-eyebrow inline-flex items-center gap-2 text-fg-muted">
          <span className="h-px w-5 bg-line-strong" />
          {T.eyebrow}
        </span>
        <h1 className="mkt-display mt-4 text-4xl font-bold text-white sm:text-5xl">{T.heading}</h1>
        <p className="mt-5 text-body leading-relaxed text-white/70">{T.lede}</p>
      </div>

      {reports.length === 0 ? (
        <EmptyState locale={locale} />
      ) : (
        <div className="mt-12 max-w-3xl space-y-6">
          {reports.map((report) => (
            <ReportEntry key={report.id} report={report} locale={locale} />
          ))}
        </div>
      )}

      <p className="mt-12 text-body">
        <Link
          href={localeHref(locale, "/security")}
          className="text-accent underline underline-offset-4"
        >
          {T.backToSecurity}
        </Link>
      </p>
    </section>
  );
}
