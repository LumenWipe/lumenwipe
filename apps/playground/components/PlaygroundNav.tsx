"use client";

import { useEffect, useState } from "react";
import { Menu, X, ArrowUpRight, Github } from "lucide-react";
import Logo from "./Logo";

type NavLink = { href: string; label: string; external?: boolean };

const MAIN_SITE = "https://lumenwipe.com";

// Exact copy of apps/web/components/marketing/MarketingNav.tsx's link set and
// layout (duplicated, not shared, per the app-isolation boundary - this app
// has no local routes of its own, so every entry is an absolute, external
// link back to the main site). Keep this in sync by hand if MarketingNav.tsx
// changes.
const LINKS: NavLink[] = [
  { href: `${MAIN_SITE}/how-it-works`, label: "How it works", external: true },
  { href: "https://playground.lumenwipe.com", label: "Playground", external: true },
  { href: `${MAIN_SITE}/security`, label: "Security", external: true },
  { href: `${MAIN_SITE}/faq`, label: "FAQ", external: true },
  { href: `${MAIN_SITE}/stats`, label: "Stats", external: true },
  { href: `${MAIN_SITE}/content`, label: "Content", external: true },
];

const DOCS: NavLink = { href: "https://docs.lumenwipe.com", label: "Docs", external: true };

const MOBILE_LINKS: NavLink[] = [...LINKS, DOCS];

const GITHUB = "https://github.com/LumenWipe/lumenwipe";
const APP = `${MAIN_SITE}/mainnet`;

export default function PlaygroundNav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header
      className={`sticky top-0 z-50 transition-colors duration-300 ${
        scrolled
          ? "border-b border-white/10 bg-[hsl(var(--mkt-bg)/0.8)] backdrop-blur-xl"
          : "border-b border-transparent"
      }`}
    >
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 lg:px-8">
        <a href={MAIN_SITE} aria-label="LumenWipe home" className="shrink-0">
          <Logo />
        </a>

        <div className="hidden items-center gap-7 lg:flex">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative inline-flex items-center gap-0.5 py-1 text-sm text-white/65 transition-colors hover:text-white"
            >
              {l.label}
              <ArrowUpRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60" />
              <span className="pointer-events-none absolute -bottom-0.5 left-0 h-px w-full origin-left scale-x-0 rounded-full bg-white/40 transition-transform duration-300 group-hover:scale-x-50" />
            </a>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <a
            href={DOCS.href}
            target="_blank"
            rel="noopener noreferrer"
            className="group mr-2 hidden items-center gap-0.5 py-1 text-sm text-white/65 transition-colors hover:text-white lg:inline-flex"
          >
            {DOCS.label}
            <ArrowUpRight className="h-3 w-3 opacity-40 transition-opacity group-hover:opacity-80" />
          </a>
          <a
            href={GITHUB}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub repository"
            className="hidden h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-white/65 transition-colors hover:border-white/20 hover:text-white sm:inline-flex"
          >
            <Github className="h-4 w-4" />
          </a>
          <a
            href={APP}
            className="hidden items-center gap-1.5 rounded-lg bg-value px-4 py-2 text-sm font-semibold text-[hsl(var(--value-foreground))] transition-all hover:bg-value/90 hover:shadow-[0_0_24px_-4px_hsl(var(--value)/0.6)] sm:inline-flex"
          >
            Open the app
          </a>
          <button
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle menu"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-white lg:hidden"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </nav>

      {open && (
        <div className="border-t border-white/10 bg-[hsl(var(--mkt-bg)/0.95)] backdrop-blur-xl lg:hidden">
          <div className="mx-auto flex max-w-6xl flex-col gap-1 px-5 py-4">
            {MOBILE_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className="flex items-center justify-between rounded-lg px-3 py-2.5 text-sm text-white/75 transition-colors hover:bg-white/5 hover:text-white"
              >
                <span className="inline-flex items-center gap-2">{l.label}</span>
                <ArrowUpRight className="h-3.5 w-3.5 opacity-50" />
              </a>
            ))}
            <a
              href={APP}
              onClick={() => setOpen(false)}
              className="mt-2 flex items-center justify-center gap-1.5 rounded-lg bg-value px-4 py-2.5 text-sm font-semibold text-[hsl(var(--value-foreground))]"
            >
              Open the app
            </a>
          </div>
        </div>
      )}
    </header>
  );
}
