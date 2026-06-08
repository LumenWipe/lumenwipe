import Link from "next/link";
import { Github, ArrowUpRight } from "lucide-react";
import Logo from "./Logo";

const COLS: { title: string; links: { label: string; href: string; external?: boolean }[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Open the app", href: "/mainnet" },
      { label: "Try on testnet", href: "/testnet" },
      { label: "How it works", href: "/how-it-works" },
      { label: "FAQ", href: "/#faq" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Documentation", href: "https://docs.lumenwipe.com", external: true },
      { label: "Architecture", href: "https://docs.lumenwipe.com/architecture", external: true },
      { label: "Security", href: "/#security" },
      { label: "Blog", href: "/blog" },
    ],
  },
  {
    title: "Open source",
    links: [
      { label: "GitHub", href: "https://github.com/LumenWipe/lumenwipe", external: true },
      {
        label: "Security policy",
        href: "https://github.com/LumenWipe/lumenwipe/blob/main/SECURITY.md",
        external: true,
      },
      {
        label: "Contributing",
        href: "https://github.com/LumenWipe/lumenwipe/blob/main/CONTRIBUTING.md",
        external: true,
      },
      {
        label: "Apache 2.0 license",
        href: "https://github.com/LumenWipe/lumenwipe/blob/main/LICENSE",
        external: true,
      },
    ],
  },
];

export default function MarketingFooter() {
  return (
    <footer className="relative border-t border-white/10 bg-[#08080c]">
      <div className="mx-auto max-w-6xl px-5 py-14 lg:px-8">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Logo />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-white/50">
              Close any Stellar account cleanly and recover the XLM locked in its reserves.
              Non-custodial, client-side, open source.
            </p>
            <div className="mt-5 flex items-center gap-2">
              <a
                href="https://github.com/LumenWipe/lumenwipe"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="GitHub"
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-white/60 transition-colors hover:border-white/20 hover:text-white"
              >
                <Github className="h-4 w-4" />
              </a>
            </div>
          </div>

          {COLS.map((col) => (
            <div key={col.title}>
              <p className="mkt-eyebrow text-white/40">{col.title}</p>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link
                      href={l.href}
                      target={l.external ? "_blank" : undefined}
                      rel={l.external ? "noopener noreferrer" : undefined}
                      className="group inline-flex items-center gap-1 text-sm text-white/55 transition-colors hover:text-white"
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

        <div className="mt-12 flex flex-col items-start justify-between gap-3 border-t border-white/8 pt-6 text-xs text-white/40 sm:flex-row sm:items-center">
          <p>© {2026} LumenWipe · Open source under Apache 2.0.</p>
          <p className="mkt-mono">Non-custodial · Client-side signing</p>
        </div>
      </div>
    </footer>
  );
}
