export const LOCALES = ["en", "es"] as const;

export type Locale = (typeof LOCALES)[number];

/** The locale every marketing page renders in. A build-time value, never read from a request, so
 *  the pages stay prerendered (docs/contributing/localization.mdx). */
export const SITE_LOCALE: Locale = "en";

/** The request header proxy.ts sets to the locale of the requested path, so a page rendered per
 *  request, the global 404, can answer in the visitor's language. */
export const LOCALE_HEADER = "x-lumenwipe-locale";

/** The locale of the page at `pathname`: Spanish for `/es` and every path under it, English for
 *  anything else. Paths match case-sensitively, as the routes do, so `/ES` is an English path. */
export function localeOfPath(pathname: string): Locale {
  return pathname === "/es" || pathname.startsWith("/es/") ? "es" : "en";
}

/** The locale a `LOCALE_HEADER` value names, or the site's own for anything else. */
export function localeFromHeader(value: string | null): Locale {
  return LOCALES.find((locale) => locale === value) ?? SITE_LOCALE;
}

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
