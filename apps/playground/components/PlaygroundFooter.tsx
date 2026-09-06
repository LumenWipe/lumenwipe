import { Github, ArrowUpRight } from "lucide-react";
import Logo from "./Logo";

const MAIN_SITE = "https://lumenwipe.com";

// Exact copy of apps/web/components/marketing/MarketingFooter.tsx's column
// structure and content (duplicated, not shared, per the app-isolation
// boundary - every link is an absolute, external link back to the main site,
// since this app has no local routes of its own). Keep this in sync by hand
// if MarketingFooter.tsx changes.
const COLS: { title: string; links: { label: string; href: string }[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Open the app", href: `${MAIN_SITE}/mainnet` },
      { label: "Try on testnet", href: `${MAIN_SITE}/testnet` },
      { label: "How it works", href: `${MAIN_SITE}/how-it-works` },
      { label: "FAQ", href: `${MAIN_SITE}/faq` },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Documentation", href: "https://docs.lumenwipe.com" },
      { label: "Architecture", href: "https://docs.lumenwipe.com/architecture" },
      { label: "Security", href: `${MAIN_SITE}/security` },
      { label: "Content", href: `${MAIN_SITE}/content` },
    ],
  },
  {
    title: "Open source",
    links: [
      { label: "GitHub", href: "https://github.com/LumenWipe/lumenwipe" },
      {
        label: "Security policy",
        href: "https://github.com/LumenWipe/lumenwipe/blob/main/SECURITY.md",
      },
      {
        label: "Contributing",
        href: "https://github.com/LumenWipe/lumenwipe/blob/main/CONTRIBUTING.md",
      },
      {
        label: "Apache 2.0 license",
        href: "https://github.com/LumenWipe/lumenwipe/blob/main/LICENSE",
      },
    ],
  },
];

export default function PlaygroundFooter() {
  return (
    <footer className="relative border-t border-white/10 bg-[hsl(var(--mkt-bg))]">
      <div className="mx-auto max-w-6xl px-5 py-14 lg:px-8">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <a href={MAIN_SITE}>
              <Logo />
            </a>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-white/65">
              Close any Stellar account cleanly and recover the XLM locked in its reserves.
              Non-custodial, client-side, open source.
            </p>
            <div className="mt-5 flex items-center gap-2">
              <a
                href="https://github.com/LumenWipe/lumenwipe"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="GitHub"
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-white/65 transition-colors hover:border-white/20 hover:text-white"
              >
                <Github className="h-4 w-4" />
              </a>
            </div>
          </div>

          {COLS.map((col) => (
            <div key={col.title}>
              <p className="mkt-eyebrow text-white/55">{col.title}</p>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <a
                      href={l.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group inline-flex items-center gap-1 text-sm text-white/65 transition-colors hover:text-white"
                    >
                      {l.label}
                      <ArrowUpRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-50" />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-start justify-between gap-3 border-t border-white/8 pt-6 text-xs text-white/55 sm:flex-row sm:items-center">
          <p>© {2026} LumenWipe · Open source under Apache 2.0.</p>
          <p className="mkt-mono">Non-custodial · Client-side signing</p>
        </div>
      </div>
    </footer>
  );
}
