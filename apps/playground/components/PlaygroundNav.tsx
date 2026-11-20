"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Menu, X, ArrowUpRight, ChevronDown } from "lucide-react";
import Logo from "./Logo";

type NavLink = { href: string; label: string; external?: boolean; current?: boolean };

const MAIN_SITE = "https://lumenwipe.com";
const DESKTOP = "(min-width: 1024px)";
const FOCUSABLE = "a[href], button:not([disabled])";
const NEW_TAB = " (opens in a new tab)";

// A copy of apps/web/components/marketing/MarketingNav.tsx and the English links in
// apps/web/lib/site/navigation.ts (duplicated, not shared, per the app-isolation boundary). This
// app has no routes of its own, so every link is absolute; the main site's pages open in place, as
// they do from the site's own header, and Playground is the current page. Keep it in sync by hand
// when MarketingNav.tsx or navigation.ts changes.
const PRIMARY: readonly NavLink[] = [
  { href: `${MAIN_SITE}/how-it-works`, label: "How it works" },
  { href: `${MAIN_SITE}/security`, label: "Security" },
  { href: `${MAIN_SITE}/content`, label: "Guides" },
  { href: "https://playground.lumenwipe.com", label: "Playground", current: true },
];

const DEVELOPER: readonly NavLink[] = [
  { href: `${MAIN_SITE}/api-keys`, label: "API keys" },
  { href: "https://docs.lumenwipe.com", label: "Docs", external: true },
  { href: "https://github.com/LumenWipe/lumenwipe", label: "GitHub", external: true },
];

const APP = `${MAIN_SITE}/mainnet`;

function linkProps(l: NavLink) {
  return {
    ...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {}),
    "aria-current": l.current ? ("page" as const) : undefined,
  };
}

function NewTab() {
  return <span className="sr-only">{NEW_TAB}</span>;
}

function DevelopersMenu() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
      toggle.current?.focus();
    }
  }

  return (
    <div
      ref={root}
      className="relative"
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        if (!root.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={toggle}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1 py-1 text-sm transition-colors ${
          open ? "text-white" : "text-[hsl(var(--fg-muted))] hover:text-white"
        }`}
      >
        Developers
        <ChevronDown
          aria-hidden
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      <ul
        id={panelId}
        hidden={!open}
        className="absolute right-0 top-full mt-3 min-w-44 rounded-xl border border-white/10 bg-[hsl(var(--surface-raised))] p-1.5 shadow-lg"
      >
        {DEVELOPER.map((l) => (
          <li key={l.href}>
            <a
              href={l.href}
              {...linkProps(l)}
              onClick={() => setOpen(false)}
              className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm text-white/85 transition-colors hover:bg-white/5 hover:text-white"
            >
              {l.label}
              {l.external && (
                <>
                  <NewTab />
                  <ArrowUpRight aria-hidden className="h-3.5 w-3.5 text-[hsl(var(--fg-muted))]" />
                </>
              )}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function PlaygroundNav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const sheetId = useId();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    sheet.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    // The sheet is hidden from the lg breakpoint up, so a resize past it would leave the page
    // locked under a menu nobody can see.
    const desktop = window.matchMedia?.(DESKTOP);
    const onDesktop = (e: MediaQueryListEvent) => {
      if (e.matches) setOpen(false);
    };
    desktop?.addEventListener("change", onDesktop);
    return () => {
      document.body.style.overflow = "";
      desktop?.removeEventListener("change", onDesktop);
    };
  }, [open]);

  function close() {
    setOpen(false);
    toggle.current?.focus();
  }

  function onMenuKeyDown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [
      toggle.current,
      ...(sheet.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
    ].filter((el): el is HTMLElement => el !== null);
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <header
      onKeyDown={onMenuKeyDown}
      className={`sticky top-0 z-50 transition-colors duration-300 ${
        scrolled || open
          ? "border-b border-white/10 bg-[hsl(var(--mkt-bg)/0.8)] backdrop-blur-xl"
          : "border-b border-transparent"
      }`}
    >
      <nav
        aria-label="Main"
        className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 lg:px-8"
      >
        <a href={MAIN_SITE} aria-label="LumenWipe home" className="shrink-0">
          <Logo wordClassName="max-[359px]:sr-only" />
        </a>

        <div className="hidden items-center gap-7 lg:flex">
          {PRIMARY.map((l) => (
            <a
              key={l.href}
              href={l.href}
              {...linkProps(l)}
              className={`group relative inline-flex items-center gap-0.5 py-1 text-sm transition-colors ${
                l.current ? "text-white" : "text-[hsl(var(--fg-muted))] hover:text-white"
              }`}
            >
              {l.label}
              <span
                className={`pointer-events-none absolute -bottom-0.5 left-0 h-px w-full origin-left rounded-full bg-stellar shadow-[0_0_8px_hsl(var(--stellar)/0.7)] transition-transform duration-300 ${
                  l.current
                    ? "scale-x-100"
                    : "scale-x-0 group-hover:scale-x-50 group-hover:bg-white/40 group-hover:shadow-none"
                }`}
              />
            </a>
          ))}
          <DevelopersMenu />
        </div>

        <div className="flex items-center gap-2">
          <a
            href={APP}
            className="inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-[hsl(var(--line-strong))] px-3 text-xs font-semibold text-white transition-colors hover:bg-[hsl(var(--surface-raised))] md:min-h-9"
          >
            Open the app
          </a>
          <button
            ref={toggle}
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls={sheetId}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-white/10 text-white lg:hidden"
          >
            {open ? (
              <X aria-hidden className="h-5 w-5" />
            ) : (
              <Menu aria-hidden className="h-5 w-5" />
            )}
          </button>
        </div>
      </nav>

      <div
        ref={sheet}
        id={sheetId}
        hidden={!open}
        className="border-t border-white/10 bg-[hsl(var(--mkt-bg)/0.95)] backdrop-blur-xl lg:hidden"
      >
        <div className="mx-auto flex max-w-6xl flex-col gap-1 px-5 py-4">
          <MobileLinks links={PRIMARY} onNavigate={() => setOpen(false)} />
          <p className="mkt-eyebrow mt-3 px-3 pb-1 text-[hsl(var(--fg-muted))]">Developers</p>
          <MobileLinks links={DEVELOPER} onNavigate={() => setOpen(false)} />
        </div>
      </div>
    </header>
  );
}

function MobileLinks({ links, onNavigate }: { links: readonly NavLink[]; onNavigate: () => void }) {
  return (
    <ul className="flex flex-col gap-1">
      {links.map((l) => (
        <li key={l.href}>
          <a
            href={l.href}
            {...linkProps(l)}
            onClick={onNavigate}
            className={`flex items-center justify-between rounded-lg px-3 py-2.5 text-sm transition-colors ${
              l.current
                ? "bg-white/5 text-white"
                : "text-white/75 hover:bg-white/5 hover:text-white"
            }`}
          >
            <span className="inline-flex items-center gap-2">
              {l.current && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-stellar" />}
              {l.label}
            </span>
            {l.external && (
              <>
                <NewTab />
                <ArrowUpRight aria-hidden className="h-3.5 w-3.5 opacity-50" />
              </>
            )}
          </a>
        </li>
      ))}
    </ul>
  );
}
