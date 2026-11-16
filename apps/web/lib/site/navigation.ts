import { SITE_LOCALE } from "@/lib/i18n/locale";
import { NAV } from "@/lib/i18n/messages/nav";
import { DOCS_URL } from "@/config/discovery-links.mjs";

export interface SiteLink {
  href: string;
  label: string;
  external?: boolean;
}

export const GITHUB_URL = "https://github.com/LumenWipe/lumenwipe";
export { DOCS_URL };
export const PLAYGROUND_URL = "https://playground.lumenwipe.com";
export const APP_HREF = "/mainnet";

const LABEL = NAV[SITE_LOCALE].links;

/** The primary navigation, in the order a first-time visitor asks: what it does, whether it is
 *  safe, where to learn more, and where to try it. */
export const PRIMARY_LINKS: readonly SiteLink[] = [
  { href: "/how-it-works", label: LABEL.howItWorks },
  { href: "/security", label: LABEL.security },
  { href: "/content", label: LABEL.guides },
  { href: PLAYGROUND_URL, label: LABEL.playground, external: true },
];

export const DEVELOPER_LINKS: readonly SiteLink[] = [
  { href: "/api-keys", label: LABEL.apiKeys },
  { href: DOCS_URL, label: LABEL.docs, external: true },
  { href: GITHUB_URL, label: LABEL.github, external: true },
];

/** Whether `pathname` is the page `link` leads to. Guides covers the blog it lists. */
export function isCurrent(link: SiteLink, pathname: string): boolean {
  if (link.external) return false;
  if (link.href === "/content") {
    return pathname === "/content" || pathname === "/blog" || pathname.startsWith("/blog/");
  }
  return pathname === link.href;
}
