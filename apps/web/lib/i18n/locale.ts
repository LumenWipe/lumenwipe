export const LOCALES = ["en"] as const;

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
}

export const LOCALE_TAGS: Record<Locale, LocaleTags> = {
  en: { html: "en", intl: "en-US", openGraph: "en_US" },
};
