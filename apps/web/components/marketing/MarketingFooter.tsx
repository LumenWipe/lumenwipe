import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { GithubIcon } from "@/components/icons/GithubIcon";
import { APP_HREF, DOCS_URL, GITHUB_URL, siteLinks, type SiteLink } from "@/lib/site/navigation";
import type { Locale } from "@/lib/i18n/locale";
import { FOOTER } from "@/lib/i18n/messages/footer";
import { localeHref } from "@/lib/site/pages";
import LanguageSwitch from "./LanguageSwitch";
import Logo from "./Logo";

function columns(locale: Locale): { title: string; links: readonly SiteLink[] }[] {
  const T = FOOTER[locale];
  const L = T.links;
  const links = siteLinks(locale);
  return [
    {
      title: T.columns.product,
      links: [
        { label: L.openApp, href: APP_HREF },
        { label: L.testnet, href: "/testnet" },
        ...links.primary.filter((l) => l.href !== "/content"),
        { label: L.faq, href: localeHref(locale, "/faq") },
        { label: L.stats, href: "/stats" },
        { label: L.registry, href: "/registry" },
      ],
    },
    {
      title: T.columns.guides,
      links: [
        { label: L.guidesAndVideos, href: "/content" },
        { label: L.blog, href: "/blog" },
      ],
    },
    {
      title: T.columns.developers,
      links: [
        ...links.developer,
        { label: L.architecture, href: `${DOCS_URL}/architecture`, external: true },
      ],
    },
    {
      title: T.columns.openSource,
      links: [
        { label: L.securityPolicy, href: `${GITHUB_URL}/blob/main/SECURITY.md`, external: true },
        { label: L.contributing, href: `${GITHUB_URL}/blob/main/CONTRIBUTING.md`, external: true },
        { label: L.license, href: `${GITHUB_URL}/blob/main/LICENSE`, external: true },
      ],
    },
  ];
}

export default function MarketingFooter({ locale }: { locale: Locale }) {
  const T = FOOTER[locale];
  return (
    <footer className="relative border-t border-white/10 bg-canvas">
      <div className="mx-auto max-w-6xl px-5 py-14 lg:px-8">
        <div className="grid gap-10 sm:grid-cols-2 md:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]">
          <div>
            <Logo />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-fg-muted">{T.tagline}</p>
            <div className="mt-5 flex items-center gap-2">
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={T.githubLabel}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-fg-muted transition-colors hover:border-white/20 hover:text-white"
              >
                <GithubIcon className="h-4 w-4" />
              </a>
              <LanguageSwitch locale={locale} className="text-sm" />
            </div>
          </div>

          {columns(locale).map((col) => (
            <div key={col.title}>
              <p className="mkt-eyebrow text-fg-muted">{col.title}</p>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link
                      href={l.href}
                      target={l.external ? "_blank" : undefined}
                      rel={l.external ? "noopener noreferrer" : undefined}
                      className="group inline-flex items-center gap-1 text-sm text-fg-muted transition-colors hover:text-white"
                    >
                      {l.label}
                      {l.external && (
                        <ArrowUpRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-50" />
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-start justify-between gap-3 border-t border-white/8 pt-6 text-xs text-fg-muted sm:flex-row sm:items-center">
          <p>{T.copyright(new Date().getUTCFullYear())}</p>
          <p className="mkt-mono">{T.promise}</p>
        </div>
      </div>
    </footer>
  );
}
