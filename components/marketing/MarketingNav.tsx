"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Menu, X, ArrowUpRight, Github } from "lucide-react";
import Logo from "./Logo";

const LINKS = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/#security", label: "Security" },
  { href: "/#faq", label: "FAQ" },
  { href: "https://docs.lumenwipe.com", label: "Docs", external: true },
  { href: "/blog", label: "Blog" },
];

const GITHUB = "https://github.com/LumenWipe/lumenwipe";
const APP = "/public";

export default function MarketingNav() {
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
        scrolled ? "border-b border-white/10 bg-[#08080c]/80 backdrop-blur-xl" : "border-b border-transparent"
      }`}
    >
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 lg:px-8">
        <Link href="/" aria-label="LumenWipe home" className="shrink-0">
          <Logo />
        </Link>

        <div className="hidden items-center gap-7 lg:flex">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              target={l.external ? "_blank" : undefined}
              rel={l.external ? "noopener noreferrer" : undefined}
              className="group inline-flex items-center gap-0.5 text-sm text-white/65 transition-colors hover:text-white"
            >
              {l.label}
              {l.external && (
                <ArrowUpRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60" />
              )}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <a
            href={GITHUB}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub repository"
            className="hidden h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-white/65 transition-colors hover:border-white/20 hover:text-white sm:inline-flex"
          >
            <Github className="h-4 w-4" />
          </a>
          <Link
            href={APP}
            className="hidden items-center gap-1.5 rounded-lg bg-stellar px-4 py-2 text-sm font-semibold text-black transition-all hover:bg-stellar/90 hover:shadow-[0_0_24px_-4px_hsl(var(--stellar)/0.6)] sm:inline-flex"
          >
            Open the app
          </Link>
          <button
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle menu"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-white lg:hidden"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </nav>

      {/* mobile sheet */}
      {open && (
        <div className="border-t border-white/10 bg-[#08080c]/95 backdrop-blur-xl lg:hidden">
          <div className="mx-auto flex max-w-6xl flex-col gap-1 px-5 py-4">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                target={l.external ? "_blank" : undefined}
                rel={l.external ? "noopener noreferrer" : undefined}
                onClick={() => setOpen(false)}
                className="flex items-center justify-between rounded-lg px-3 py-2.5 text-sm text-white/75 transition-colors hover:bg-white/5 hover:text-white"
              >
                {l.label}
                {l.external && <ArrowUpRight className="h-3.5 w-3.5 opacity-50" />}
              </Link>
            ))}
            <Link
              href={APP}
              onClick={() => setOpen(false)}
              className="mt-2 flex items-center justify-center gap-1.5 rounded-lg bg-stellar px-4 py-2.5 text-sm font-semibold text-black"
            >
              Open the app
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
