"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X, ArrowUpRight, Github } from "lucide-react";
import Logo from "./Logo";

type NavLink = { href: string; label: string; external?: boolean; section?: string };

const LINKS: NavLink[] = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/#security", label: "Security", section: "security" },
  { href: "/#faq", label: "FAQ", section: "faq" },
  { href: "/playground", label: "Playground" },
  { href: "https://docs.lumenwipe.com", label: "Docs", external: true },
  { href: "/blog", label: "Blog" },
];

// Landing sections the scroll-spy watches, in document order.
const SPY_SECTIONS = ["security", "faq"];

const GITHUB = "https://github.com/LumenWipe/lumenwipe";
const APP = "/mainnet";

export default function MarketingNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const visible = useRef<Set<string>>(new Set());

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

  // Scroll-spy: highlight the anchor link whose section sits in the middle band.
  useEffect(() => {
    if (pathname !== "/" || typeof IntersectionObserver === "undefined") {
      setActiveSection(null);
      return;
    }
    visible.current = new Set();
    const els = SPY_SECTIONS.map((id) => document.getElementById(id)).filter(
      (el): el is HTMLElement => el !== null
    );
    if (!els.length) return;

    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.current.add(entry.target.id);
          else visible.current.delete(entry.target.id);
        }
        // Prefer the section lowest in the page that's currently in view.
        const current = [...SPY_SECTIONS].reverse().find((id) => visible.current.has(id));
        setActiveSection(current ?? null);
      },
      { rootMargin: "-45% 0px -45% 0px", threshold: 0 }
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [pathname]);

  function isActive(l: NavLink): boolean {
    if (l.external) return false;
    if (l.section) return pathname === "/" && activeSection === l.section;
    if (l.href === "/blog") return pathname === "/blog" || pathname.startsWith("/blog/");
    return pathname === l.href;
  }

  return (
    <header
      className={`sticky top-0 z-50 transition-colors duration-300 ${
        scrolled
          ? "border-b border-white/10 bg-[#08080c]/80 backdrop-blur-xl"
          : "border-b border-transparent"
      }`}
    >
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 lg:px-8">
        <Link href="/" aria-label="LumenWipe home" className="shrink-0">
          <Logo />
        </Link>

        <div className="hidden items-center gap-7 lg:flex">
          {LINKS.map((l) => {
            const active = isActive(l);
            return (
              <Link
                key={l.href}
                href={l.href}
                target={l.external ? "_blank" : undefined}
                rel={l.external ? "noopener noreferrer" : undefined}
                aria-current={active ? "page" : undefined}
                className={`group relative inline-flex items-center gap-0.5 py-1 text-sm transition-colors ${
                  active ? "text-white" : "text-white/65 hover:text-white"
                }`}
              >
                {l.label}
                {l.external && (
                  <ArrowUpRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60" />
                )}
                <span
                  className={`pointer-events-none absolute -bottom-0.5 left-0 h-px w-full origin-left rounded-full bg-stellar shadow-[0_0_8px_hsl(var(--stellar)/0.7)] transition-transform duration-300 ${
                    active
                      ? "scale-x-100"
                      : "scale-x-0 group-hover:scale-x-50 group-hover:bg-white/40 group-hover:shadow-none"
                  }`}
                />
              </Link>
            );
          })}
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
            {LINKS.map((l) => {
              const active = isActive(l);
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  target={l.external ? "_blank" : undefined}
                  rel={l.external ? "noopener noreferrer" : undefined}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setOpen(false)}
                  className={`flex items-center justify-between rounded-lg px-3 py-2.5 text-sm transition-colors ${
                    active
                      ? "bg-white/5 text-white"
                      : "text-white/75 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <span className="inline-flex items-center gap-2">
                    {active && <span className="h-1.5 w-1.5 rounded-full bg-stellar" />}
                    {l.label}
                  </span>
                  {l.external && <ArrowUpRight className="h-3.5 w-3.5 opacity-50" />}
                </Link>
              );
            })}
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
