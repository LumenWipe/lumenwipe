import type { Locale } from "@/lib/i18n/locale";

const en = {
  /** Screen-reader text after a link that opens in a new tab. */
  newTab: " (opens in a new tab)",
};

export type CommonCopy = typeof en;

const es: CommonCopy = {
  newTab: " (se abre en una pestaña nueva)",
};

export const COMMON: Record<Locale, CommonCopy> = { en, es };
