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

const es: NavCopy = {
  links: {
    howItWorks: "Cómo funciona",
    security: "Seguridad",
    guides: "Guías",
    playground: "Playground",
    apiKeys: "Claves de API",
    docs: "Documentación",
    github: "GitHub",
  },
  mainLabel: "Principal",
  homeLabel: "Inicio de LumenWipe",
  developers: "Desarrolladores",
  openApp: "Abrir la app",
  openMenu: "Abrir el menú",
  closeMenu: "Cerrar el menú",
  skipToContent: "Saltar al contenido",
};

export const NAV: Record<Locale, NavCopy> = { en, es };
