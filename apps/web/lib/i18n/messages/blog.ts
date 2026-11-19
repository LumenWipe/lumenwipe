import type { Category } from "@/lib/blog";
import type { Locale } from "@/lib/i18n/locale";

const en = {
  title: "Blog",
  eyebrow: "Blog",
  heading: "Field notes on closing Stellar accounts",
  lede: "Technical deep dives, project updates, and guides on Stellar account management, reserve recovery, and non-custodial tooling.",
  noPosts: "No articles published yet.",
  noPostsBody:
    "The first guides are on the way. Until then, watch the walkthrough videos or read how a close works, step by step.",
  watchVideos: "Watch the videos",
  howItWorks: "How it works",
  categories: {
    Technical: "Technical",
    Updates: "Updates",
    Guides: "Guides",
  } satisfies Record<Category, string>,
  readingTime: (minutes: number): string => `${minutes} min read`,
  /** Precedes the date a post last changed. */
  updated: "Updated ",
  playVideo: (title: string): string => `Play video: ${title}`,
  post: {
    allArticles: "All articles",
    onThisPage: "On this page",
    related: "Related",
    nextStep: "Next step",
    nextStepLead:
      "Connect a wallet or paste the account address. LumenWipe lists what is keeping the account open and shows the full plan before you sign anything.",
    analyzeAccount: "Analyze an account",
  },
  status: {
    caption: "Published and planned articles",
    article: "Article",
    statusColumn: "Status",
    published: "Published",
    planned: "Planned",
    notYet: "Not yet",
  },
};

export type BlogCopy = typeof en;

const es: BlogCopy = {
  title: "Blog",
  eyebrow: "Blog",
  heading: "Notas de campo sobre cerrar cuentas de Stellar",
  lede: "Guías, análisis técnicos y novedades del proyecto sobre cómo gestionar cuentas de Stellar, recuperar la reserva y usar herramientas no custodiales.",
  noPosts: "Todavía no hay artículos publicados.",
  noPostsBody:
    "Las primeras guías están en camino. Mientras tanto, mira los videos o lee cómo funciona un cierre, paso a paso.",
  watchVideos: "Ver los videos",
  howItWorks: "Cómo funciona",
  categories: {
    Technical: "Técnico",
    Updates: "Novedades",
    Guides: "Guías",
  },
  readingTime: (minutes: number): string => `${minutes} min de lectura`,
  updated: "Actualizado el ",
  playVideo: (title: string): string => `Reproducir video: ${title}`,
  post: {
    allArticles: "Todos los artículos",
    onThisPage: "En esta página",
    related: "Relacionados",
    nextStep: "Siguiente paso",
    nextStepLead:
      "Conecta una billetera o pega la dirección de la cuenta. LumenWipe muestra qué mantiene abierta la cuenta y el plan completo antes de que firmes nada.",
    analyzeAccount: "Analizar una cuenta",
  },
  status: {
    caption: "Artículos publicados y previstos",
    article: "Artículo",
    statusColumn: "Estado",
    published: "Publicado",
    planned: "Previsto",
    notYet: "Todavía no",
  },
};

export const BLOG: Record<Locale, BlogCopy> = { en, es };
