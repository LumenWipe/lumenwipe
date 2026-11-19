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

/** A page's `hreflang` set: each language's URL, and the one for any other reader. */
type HreflangSet = NonNullable<
  NonNullable<MetadataRoute.Sitemap[number]["alternates"]>["languages"]
>;

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
  title: COPY.blogName(SITE_NAME),
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

/** The English pages that have a Spanish version under `/es` (docs/contributing/localization.mdx).
 *  A translated post is not listed here: `spanishPages()` adds one for each post under
 *  `content/blog/es`. */
export const SPANISH_PAGES: readonly SpanishPage[] = [
  { path: "/", translated: true },
  { path: "/faq", translated: true },
  { path: "/security", translated: true },
  { path: "/how-it-works", translated: true },
  { path: "/blog", translated: true },
];

/** Whether the page at English `path` reads in `locale`: always in English, and in Spanish once
 *  its entry is translated. */
export function isTranslated(
  locale: Locale,
  path: string,
  pages: readonly SpanishPage[] = SPANISH_PAGES
): boolean {
  return locale === "en" || pages.some((page) => page.translated && page.path === path);
}

/** Where a link to English `path` leads from a page in `locale`: its version in that locale when
 *  it is translated, else the English page. */
export function localeHref(
  locale: Locale,
  path: string,
  pages: readonly SpanishPage[] = SPANISH_PAGES
): string {
  return isTranslated(locale, path, pages) ? localePath(locale, path) : path;
}

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

/** The `hreflang` set of the page at `pathname`: every version, itself included, and English as
 *  `x-default`, the same from either side. Only a translated pair has one, so no indexed page names
 *  a `noindex` page as its alternate. */
export function languageAlternates(
  locale: Locale,
  pathname: string,
  pages: readonly SpanishPage[] = SPANISH_PAGES
): HreflangSet | null {
  const alternate = languageAlternate(locale, pathname, pages);
  if (!alternate) return null;
  const english = locale === "en" ? pathname : alternate.path;
  const spanish = locale === "es" ? pathname : alternate.path;
  return {
    [LOCALE_TAGS.en.hreflang]: siteUrl(english),
    [LOCALE_TAGS.es.hreflang]: siteUrl(spanish),
    "x-default": siteUrl(english),
  };
}

/** The sitemap entries of the static pages: every indexed English page, then the translated
 *  Spanish ones, each with the `hreflang` set of its pair. */
export function sitemapPages(pages: readonly SpanishPage[] = SPANISH_PAGES): MetadataRoute.Sitemap {
  const entry = (locale: Locale) => (page: IndexedPage) => {
    const languages = languageAlternates(locale, page.path, pages);
    return {
      url: siteUrl(page.path),
      changeFrequency: page.changeFrequency,
      priority: page.priority,
      ...(languages ? { alternates: { languages } } : {}),
    };
  };
  return [...INDEXED_PAGES.map(entry("en")), ...spanishIndexedPages(pages).map(entry("es"))];
}

/** Pages search engines must not index: kept out of the sitemap and marked `noindex`. */
export function noindexPages(pages: readonly SpanishPage[] = SPANISH_PAGES): string[] {
  return [
    "/api-keys",
    ...pages.filter((page) => !page.translated).map((page) => localePath("es", page.path)),
  ];
}

export const NOINDEX_PAGES: readonly string[] = noindexPages();

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

/** The metadata every public page carries: its name, its own canonical URL, a share image for
 *  both Open Graph and X, and, for a translated pair, its other language. */
export function pageMetadata(
  {
    path,
    locale = SITE_LOCALE,
    title,
    description,
    shareImage = SHARE_IMAGE,
    blogFeed = false,
    openGraph = { type: "website" },
  }: PageInput,
  pages: readonly SpanishPage[] = SPANISH_PAGES
): Metadata {
  const isHome = path === localePath(locale, "/");
  const homeTitle = SITE[locale].metadata.homeTitle;
  const fullTitle = isHome ? homeTitle : `${title} | ${SITE_NAME}`;
  const url = siteUrl(path);
  const languages = languageAlternates(locale, path, pages);
  const other = languageAlternate(locale, path, pages);
  return {
    title: isHome ? { absolute: homeTitle } : title,
    description,
    alternates: {
      canonical: url,
      ...(languages ? { languages } : {}),
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
      ...(other ? { alternateLocale: [LOCALE_TAGS[other.locale].openGraph] } : {}),
      images: [shareImage],
    },
    twitter: { card: "summary_large_image", title: fullTitle, description, images: [shareImage] },
    ...(noindexPages(pages).includes(path) ? { robots: { index: false, follow: true } } : {}),
  };
}
