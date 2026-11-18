import type { Locale } from "@/lib/i18n/locale";

const en = {
  links: {
    howItWorks: "How it works",
    security: "Security",
    guides: "Guides",
    playground: "Playground",
    apiKeys: "API keys",
    docs: "Docs",
    github: "GitHub",
  },
  mainLabel: "Main",
  homeLabel: "LumenWipe home",
  developers: "Developers",
  openApp: "Open the app",
  openMenu: "Open menu",
  closeMenu: "Close menu",
  skipToContent: "Skip to content",
};

export type NavCopy = typeof en;

export const NAV: Record<Locale, NavCopy> = { en, es: en };
