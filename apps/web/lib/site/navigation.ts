export interface SiteLink {
  href: string;
  label: string;
  external?: boolean;
}

export const GITHUB_URL = "https://github.com/LumenWipe/lumenwipe";
export const DOCS_URL = "https://docs.lumenwipe.com";
export const PLAYGROUND_URL = "https://playground.lumenwipe.com";
export const APP_HREF = "/mainnet";

/** The primary navigation, in the order a first-time visitor asks: what it does, whether it is
 *  safe, where to learn more, and where to try it. */
export const PRIMARY_LINKS: readonly SiteLink[] = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/security", label: "Security" },
  { href: "/content", label: "Guides" },
  { href: PLAYGROUND_URL, label: "Playground", external: true },
];

export const DEVELOPER_LINKS: readonly SiteLink[] = [
  { href: "/api-keys", label: "API keys" },
  { href: DOCS_URL, label: "Docs", external: true },
  { href: GITHUB_URL, label: "GitHub", external: true },
];

/** Whether `pathname` is the page `link` leads to. Guides covers the blog it lists. */
export function isCurrent(link: SiteLink, pathname: string): boolean {
  if (link.external) return false;
  if (link.href === "/content") {
    return pathname === "/content" || pathname === "/blog" || pathname.startsWith("/blog/");
  }
  return pathname === link.href;
}
