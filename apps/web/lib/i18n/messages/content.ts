import type { Locale } from "@/lib/i18n/locale";

const en = {
  metadata: {
    title: "Content",
    description:
      "Videos, guides, and technical deep dives on LumenWipe - closing Stellar accounts, recovering XLM reserves, and DeFi position unwinding.",
  },
  eyebrow: "Content",
  heading: "Videos & articles",
  lede: "Walkthroughs, deep dives, and guides on closing Stellar accounts and recovering locked reserves.",
  videos: "Videos",
  duration: (minutes: number): string => `${minutes} min`,
  fromBlog: "From the blog",
  statusHeading: "Article status",
  statusLede: "What is published and what is planned next.",
};

export type ContentCopy = typeof en;

export const CONTENT: Record<Locale, ContentCopy> = { en, es: en };
