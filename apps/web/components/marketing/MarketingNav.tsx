"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X, ArrowUpRight, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  APP_HREF,
  DEVELOPER_LINKS,
  isCurrent,
  PRIMARY_LINKS,
  type SiteLink,
} from "@/lib/site/navigation";
import Logo from "./Logo";

const DESKTOP = "(min-width: 1024px)";
const FOCUSABLE = "a[href], button:not([disabled])";

function linkProps(l: SiteLink) {
  return l.external ? { target: "_blank", rel: "noopener noreferrer" } : {};
}

function NewTab() {
  return <span className="sr-only"> (opens in a new tab)</span>;
}

function DevelopersMenu({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const current = DEVELOPER_LINKS.some((l) => isCurrent(l, pathname));

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
          current || open ? "text-white" : "text-fg-muted hover:text-white"
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
        className="absolute right-0 top-full mt-3 min-w-44 rounded-xl border border-white/10 bg-surface-raised p-1.5 shadow-lg"
      >
        {DEVELOPER_LINKS.map((l) => (
          <li key={l.href}>
            <Link
              href={l.href}
              {...linkProps(l)}
              aria-current={isCurrent(l, pathname) ? "page" : undefined}
              onClick={() => setOpen(false)}
              className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm text-white/85 transition-colors hover:bg-white/5 hover:text-white"
            >
              {l.label}
              {l.external && (
                <>
                  <NewTab />
                  <ArrowUpRight aria-hidden className="h-3.5 w-3.5 text-fg-muted" />
                </>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function MarketingNav() {
  const pathname = usePathname();
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
    setOpen(false);
  }, [pathname]);

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
          ? "border-b border-white/10 bg-canvas/80 backdrop-blur-xl"
          : "border-b border-transparent"
      }`}
    >
      <nav
        aria-label="Main"
        className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 lg:px-8"
      >
        <Link href="/" aria-label="LumenWipe home" className="shrink-0">
          <Logo />
        </Link>

        <div className="hidden items-center gap-7 lg:flex">
          {PRIMARY_LINKS.map((l) => {
            const active = isCurrent(l, pathname);
            return (
              <Link
                key={l.href}
                href={l.href}
                {...linkProps(l)}
                aria-current={active ? "page" : undefined}
                className={`group relative inline-flex items-center gap-0.5 py-1 text-sm transition-colors ${
                  active ? "text-white" : "text-fg-muted hover:text-white"
                }`}
              >
                {l.label}
                {l.external && (
                  <>
                    <NewTab />
                    <ArrowUpRight
                      aria-hidden
                      className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60"
                    />
                  </>
                )}
                <span
                  className={`pointer-events-none absolute -bottom-0.5 left-0 h-px w-full origin-left rounded-full bg-accent shadow-[0_0_8px_hsl(var(--accent)/0.7)] transition-transform duration-300 ${
                    active
                      ? "scale-x-100"
                      : "scale-x-0 group-hover:scale-x-50 group-hover:bg-white/40 group-hover:shadow-none"
                  }`}
                />
              </Link>
            );
          })}
          <DevelopersMenu pathname={pathname} />
        </div>

        <div className="flex items-center gap-2">
          <Button asChild variant="secondary" size="sm" className="hidden sm:inline-flex">
            <Link href={APP_HREF}>Open the app</Link>
          </Button>
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
        className="border-t border-white/10 bg-canvas/95 backdrop-blur-xl lg:hidden"
      >
        <div className="mx-auto flex max-w-6xl flex-col gap-1 px-5 py-4">
          <MobileLinks
            links={PRIMARY_LINKS}
            pathname={pathname}
            onNavigate={() => setOpen(false)}
          />
          <p className="mkt-eyebrow mt-3 px-3 pb-1 text-fg-muted">Developers</p>
          <MobileLinks
            links={DEVELOPER_LINKS}
            pathname={pathname}
            onNavigate={() => setOpen(false)}
          />
          <Button asChild variant="secondary" className="mt-2">
            <Link href={APP_HREF} onClick={() => setOpen(false)}>
              Open the app
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}

function MobileLinks({
  links,
  pathname,
  onNavigate,
}: {
  links: readonly SiteLink[];
  pathname: string;
  onNavigate: () => void;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {links.map((l) => {
        const active = isCurrent(l, pathname);
        return (
          <li key={l.href}>
            <Link
              href={l.href}
              {...linkProps(l)}
              aria-current={active ? "page" : undefined}
              onClick={onNavigate}
              className={`flex items-center justify-between rounded-lg px-3 py-2.5 text-sm transition-colors ${
                active ? "bg-white/5 text-white" : "text-white/75 hover:bg-white/5 hover:text-white"
              }`}
            >
              <span className="inline-flex items-center gap-2">
                {active && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />}
                {l.label}
              </span>
              {l.external && (
                <>
                  <NewTab />
                  <ArrowUpRight aria-hidden className="h-3.5 w-3.5 opacity-50" />
                </>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
