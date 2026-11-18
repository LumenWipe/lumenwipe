import type { Metadata, MetadataRoute } from "next";
import { LOCALE_TAGS, SITE_LOCALE, type Locale } from "@/lib/i18n/locale";
import { SITE } from "@/lib/i18n/messages/site";
import { siteUrl } from "@/lib/site/url";

const COPY = SITE[SITE_LOCALE].metadata;

export const SITE_NAME = "LumenWipe";

/** The home page's title, the only one that names the brand itself: the root layout's template
 *  appends it to every other page's name. */
export const HOME_TITLE = COPY.homeTitle;

export interface ShareImage {
  url: string;
  width: number;
  height: number;
  alt: string;
}

/** The branded share image every page uses unless it has its own. */
export const SHARE_IMAGE: ShareImage = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  alt: COPY.shareImageAlt,
};

/** A blog post's own share image, generated from its title. */
export function postShareImage(slug: string, title: string): ShareImage {
  return { ...SHARE_IMAGE, url: `/blog/${slug}/share.png`, alt: title };
}

type ChangeFrequency = NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>;

export interface IndexedPage {
  path: string;
  priority: number;
  changeFrequency: ChangeFrequency;
}

/** Every indexable static page, in sitemap order. The home page, the main conversion page, ranks
 *  first; the app entry is listed below the pages that explain it, and testnet is left out. */
export const INDEXED_PAGES: readonly IndexedPage[] = [
  { path: "/", priority: 1, changeFrequency: "weekly" },
  { path: "/how-it-works", priority: 0.9, changeFrequency: "monthly" },
  { path: "/security", priority: 0.9, changeFrequency: "monthly" },
  { path: "/faq", priority: 0.8, changeFrequency: "monthly" },
  { path: "/blog", priority: 0.8, changeFrequency: "weekly" },
  { path: "/content", priority: 0.7, changeFrequency: "weekly" },
  { path: "/stats", priority: 0.6, changeFrequency: "daily" },
  { path: "/registry", priority: 0.6, changeFrequency: "monthly" },
  { path: "/playground", priority: 0.6, changeFrequency: "monthly" },
  { path: "/mainnet", priority: 0.5, changeFrequency: "monthly" },
];

/** The blog's RSS feed, which the blog pages advertise with a `<link rel="alternate">`. */
export const BLOG_FEED = {
  path: "/blog/feed.xml",
  type: "application/rss+xml",
  title: `${SITE_NAME} blog`,
} as const;

/** The blog's own description, for the blog index and its feed. */
export const BLOG_DESCRIPTION = COPY.blogDescription;

/** A page's path in `locale`: English at the site root, Spanish under `/es`. */
export function localePath(locale: Locale, path: string): string {
  if (locale === "en") return path;
  return path === "/" ? `/${locale}` : `/${locale}${path}`;
}

export interface SpanishPage {
  /** The English page's path. */
  path: string;
  /** Whether its Spanish version is translated. Until it is, the Spanish page is `noindex`, left
   *  out of the sitemap, and the language switch does not link the two. */
  translated: boolean;
}

/** The English pages that have a Spanish version under `/es` (docs/contributing/localization.mdx). */
export const SPANISH_PAGES: readonly SpanishPage[] = [{ path: "/", translated: false }];

/** The sitemap entries of the translated Spanish pages, ranked as their English page. */
export function spanishIndexedPages(pages: readonly SpanishPage[] = SPANISH_PAGES): IndexedPage[] {
  return pages
    .filter((page) => page.translated)
    .flatMap((page) =>
      INDEXED_PAGES.filter((indexed) => indexed.path === page.path).map((indexed) => ({
        ...indexed,
        path: localePath("es", page.path),
      }))
    );
}

/** The other locale's version of the page at `pathname`, when both exist and are translated. */
export function languageAlternate(
  locale: Locale,
  pathname: string,
  pages: readonly SpanishPage[] = SPANISH_PAGES
): { locale: Locale; path: string } | null {
  const page = pages.find((p) => p.translated && localePath(locale, p.path) === pathname);
  if (!page) return null;
  const other: Locale = locale === "en" ? "es" : "en";
  return { locale: other, path: localePath(other, page.path) };
}

/** Pages search engines must not index: kept out of the sitemap and marked `noindex`. */
export const NOINDEX_PAGES: readonly string[] = [
  "/api-keys",
  ...SPANISH_PAGES.filter((page) => !page.translated).map((page) => localePath("es", page.path)),
];

interface PageInput {
  path: string;
  locale?: Locale;
  /** The page's own name; the root layout's title template adds the brand. */
  title: string;
  description: string;
  shareImage?: ShareImage;
  /** Whether the page advertises the blog's feed. */
  blogFeed?: boolean;
  openGraph?:
    | { type: "website" }
    | { type: "article"; publishedTime: string; modifiedTime: string; tags: string[] };
}

/** The metadata every public page carries: its name, its own canonical URL, and a share image
 *  for both Open Graph and X. */
export function pageMetadata({
  path,
  locale = SITE_LOCALE,
  title,
  description,
  shareImage = SHARE_IMAGE,
  blogFeed = false,
  openGraph = { type: "website" },
}: PageInput): Metadata {
  const isHome = path === localePath(locale, "/");
  const homeTitle = SITE[locale].metadata.homeTitle;
  const fullTitle = isHome ? homeTitle : `${title} | ${SITE_NAME}`;
  const url = siteUrl(path);
  return {
    title: isHome ? { absolute: homeTitle } : title,
    description,
    alternates: {
      canonical: url,
      ...(blogFeed
        ? {
            types: { [BLOG_FEED.type]: [{ url: siteUrl(BLOG_FEED.path), title: BLOG_FEED.title }] },
          }
        : {}),
    },
    openGraph: {
      ...openGraph,
      title: fullTitle,
      description,
      url,
      siteName: SITE_NAME,
      locale: LOCALE_TAGS[locale].openGraph,
      images: [shareImage],
    },
    twitter: { card: "summary_large_image", title: fullTitle, description, images: [shareImage] },
    ...(NOINDEX_PAGES.includes(path) ? { robots: { index: false, follow: true } } : {}),
  };
}
