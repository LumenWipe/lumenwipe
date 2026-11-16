import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { GithubIcon } from "@/components/icons/GithubIcon";
import {
  APP_HREF,
  DEVELOPER_LINKS,
  DOCS_URL,
  GITHUB_URL,
  PRIMARY_LINKS,
  type SiteLink,
} from "@/lib/site/navigation";
import Logo from "./Logo";

const COLS: { title: string; links: readonly SiteLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Open the app", href: APP_HREF },
      { label: "Try on testnet", href: "/testnet" },
      ...PRIMARY_LINKS.filter((l) => l.href !== "/content"),
      { label: "FAQ", href: "/faq" },
      { label: "Stats", href: "/stats" },
      { label: "Exchange registry", href: "/registry" },
    ],
  },
  {
    title: "Guides",
    links: [
      { label: "Guides and videos", href: "/content" },
      { label: "Blog", href: "/blog" },
    ],
  },
  {
    title: "Developers",
    links: [
      ...DEVELOPER_LINKS,
      { label: "Architecture", href: `${DOCS_URL}/architecture`, external: true },
    ],
  },
  {
    title: "Open source",
    links: [
      { label: "Security policy", href: `${GITHUB_URL}/blob/main/SECURITY.md`, external: true },
      { label: "Contributing", href: `${GITHUB_URL}/blob/main/CONTRIBUTING.md`, external: true },
      { label: "Apache 2.0 license", href: `${GITHUB_URL}/blob/main/LICENSE`, external: true },
    ],
  },
];

export default function MarketingFooter() {
  return (
    <footer className="relative border-t border-white/10 bg-canvas">
      <div className="mx-auto max-w-6xl px-5 py-14 lg:px-8">
        <div className="grid gap-10 sm:grid-cols-2 md:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]">
          <div>
            <Logo />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-fg-muted">
              Close any Stellar account cleanly and recover the XLM locked in its reserves.
              Non-custodial, signed in your browser, open source.
            </p>
            <div className="mt-5 flex items-center gap-2">
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="GitHub"
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-fg-muted transition-colors hover:border-white/20 hover:text-white"
              >
                <GithubIcon className="h-4 w-4" />
              </a>
            </div>
          </div>

          {COLS.map((col) => (
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
          <p>© {new Date().getUTCFullYear()} LumenWipe · Open source under Apache 2.0.</p>
          <p className="mkt-mono">Non-custodial · Signed in your browser</p>
        </div>
      </div>
    </footer>
  );
}
