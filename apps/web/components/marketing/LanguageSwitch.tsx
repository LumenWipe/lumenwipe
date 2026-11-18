"use client";

import { usePathname } from "next/navigation";
import { LOCALE_NAMES, LOCALE_TAGS, type Locale } from "@/lib/i18n/locale";
import { languageAlternate, SPANISH_PAGES, type SpanishPage } from "@/lib/site/pages";

/** A link to this page in the other locale, shown only when both versions are translated. A plain
 *  anchor: each locale has its own root layout, so the switch reloads the page anyway. */
export default function LanguageSwitch({
  locale,
  className = "",
  pages = SPANISH_PAGES,
}: {
  locale: Locale;
  className?: string;
  pages?: readonly SpanishPage[];
}) {
  const alternate = languageAlternate(locale, usePathname(), pages);
  if (!alternate) return null;
  const tag = LOCALE_TAGS[alternate.locale].html;
  return (
    <a
      href={alternate.path}
      hrefLang={tag}
      lang={tag}
      className={`items-center text-fg-muted underline-offset-4 transition-colors hover:text-white hover:underline ${className}`}
    >
      {LOCALE_NAMES[alternate.locale]}
    </a>
  );
}
