import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n/locale";

const en = {
  tagline:
    "Close any Stellar account cleanly and recover the XLM locked in its reserves. Non-custodial, signed in your browser, open source.",
  githubLabel: "GitHub",
  columns: {
    product: "Product",
    guides: "Guides",
    developers: "Developers",
    openSource: "Open source",
  },
  links: {
    openApp: "Open the app",
    testnet: "Try on testnet",
    faq: "FAQ",
    stats: "Stats",
    registry: "Exchange registry",
    guidesAndVideos: "Guides and videos",
    blog: "Blog",
    architecture: "Architecture",
    securityPolicy: "Security policy",
    contributing: "Contributing",
    license: "Apache 2.0 license",
  },
  copyright: (year: number): ReactNode => <>© {year} LumenWipe · Open source under Apache 2.0.</>,
  promise: "Non-custodial · Signed in your browser",
};

export type FooterCopy = typeof en;

export const FOOTER: Record<Locale, FooterCopy> = { en, es: en };
