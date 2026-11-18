import type { Locale } from "@/lib/i18n/locale";

const en = {
  /** Screen-reader text after a link that opens in a new tab. */
  newTab: " (opens in a new tab)",
};

export type CommonCopy = typeof en;

export const COMMON: Record<Locale, CommonCopy> = { en, es: en };
