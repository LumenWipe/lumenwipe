import type { Locale } from "@/lib/i18n/locale";
import { NAV } from "@/lib/i18n/messages/nav";
import { DOCS_URL } from "@/config/discovery-links.mjs";
import { localeHref } from "@/lib/site/pages";

export interface SiteLink {
  href: string;
  label: string;
  external?: boolean;
}

export const GITHUB_URL = "https://github.com/LumenWipe/lumenwipe";
export { DOCS_URL };
export const PLAYGROUND_URL = "https://playground.lumenwipe.com";
export const APP_HREF = "/mainnet";

export interface SiteLinks {
  /** The primary navigation, in the order a first-time visitor asks: what it does, whether it is
   *  safe, where to learn more, and where to try it. */
  primary: readonly SiteLink[];
  developer: readonly SiteLink[];
}

export function siteLinks(locale: Locale): SiteLinks {
  const label = NAV[locale].links;
  return {
    primary: [
      { href: localeHref(locale, "/how-it-works"), label: label.howItWorks },
      { href: localeHref(locale, "/security"), label: label.security },
      { href: "/content", label: label.guides },
      { href: PLAYGROUND_URL, label: label.playground, external: true },
    ],
    developer: [
      { href: "/api-keys", label: label.apiKeys },
      { href: DOCS_URL, label: label.docs, external: true },
      { href: GITHUB_URL, label: label.github, external: true },
    ],
  };
}

/** Whether `pathname` is the page `link` leads to. Guides covers the blog it lists, in
 *  either language. */
export function isCurrent(link: SiteLink, pathname: string): boolean {
  if (link.external) return false;
  if (link.href === "/content") {
    return pathname === "/content" || /^(?:\/es)?\/blog(?:\/|$)/.test(pathname);
  }
  return pathname === link.href;
}
