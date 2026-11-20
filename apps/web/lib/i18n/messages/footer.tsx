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
    securityReports: "Security reports",
    statusPage: "Service status",
    contributing: "Contributing",
    license: "Apache 2.0 license",
  },
  copyright: (year: number): ReactNode => <>© {year} LumenWipe · Open source under Apache 2.0.</>,
  promise: "Non-custodial · Signed in your browser",
  buildLabel: "Build",
};

export type FooterCopy = typeof en;

const es: FooterCopy = {
  tagline:
    "Cierra cualquier cuenta de Stellar de forma limpia y recupera el XLM bloqueado en sus reservas. No custodial, firmado en tu navegador, de código abierto.",
  githubLabel: "GitHub",
  columns: {
    product: "Producto",
    guides: "Guías",
    developers: "Desarrolladores",
    openSource: "Código abierto",
  },
  links: {
    openApp: "Abrir la app",
    testnet: "Probar en testnet",
    faq: "Preguntas frecuentes",
    stats: "Estadísticas",
    registry: "Registro de exchanges",
    guidesAndVideos: "Guías y videos",
    blog: "Blog",
    architecture: "Arquitectura",
    securityPolicy: "Política de seguridad",
    securityReports: "Reportes de seguridad",
    statusPage: "Estado del servicio",
    contributing: "Cómo contribuir",
    license: "Licencia Apache 2.0",
  },
  copyright: (year: number): ReactNode => (
    <>© {year} LumenWipe · Código abierto bajo la licencia Apache 2.0.</>
  ),
  promise: "No custodial · Firmado en tu navegador",
  buildLabel: "Versión",
};

export const FOOTER: Record<Locale, FooterCopy> = { en, es };
