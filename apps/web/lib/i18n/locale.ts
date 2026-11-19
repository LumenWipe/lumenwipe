export const LOCALES = ["en", "es"] as const;

export type Locale = (typeof LOCALES)[number];

/** The locale every marketing page renders in. A build-time value, never read from a request, so
 *  the pages stay prerendered (docs/contributing/localization.mdx). */
export const SITE_LOCALE: Locale = "en";

export interface LocaleTags {
  /** The `lang` attribute on `<html>`. */
  html: string;
  /** The tag dates and numbers are formatted with. */
  intl: string;
  /** The Open Graph `og:locale` value. */
  openGraph: string;
  /** The `hreflang` value search engines read, a language Google supports. */
  hreflang: "en" | "es";
}

export const LOCALE_TAGS: Record<Locale, LocaleTags> = {
  en: { html: "en", intl: "en-US", openGraph: "en_US", hreflang: "en" },
  es: { html: "es-419", intl: "es-419", openGraph: "es_LA", hreflang: "es" },
};

/** Each locale's name in its own language, as the language switch shows it. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", es: "Español" };
