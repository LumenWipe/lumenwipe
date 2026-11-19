import type { FaqItem } from "@/components/marketing/FaqAccordion";
import type { Post, PostMeta } from "@/lib/blog";
import { postTimestamp } from "@/lib/blog-date";
import { nodeText } from "@/lib/site/node-text";
import { GITHUB_URL } from "@/lib/site/navigation";
import { LOCALE_TAGS, type Locale } from "@/lib/i18n/locale";
import { SITE } from "@/lib/i18n/messages/site";
import { localePath, postShareImage, SITE_NAME } from "@/lib/site/pages";
import { FEATURES, LIVE_EXIT_PROTOCOLS } from "@/lib/site/status";
import { siteUrl } from "@/lib/site/url";

type Node = Record<string, unknown>;

/** A schema.org document: one `@graph` of nodes. */
export interface JsonLdDocument {
  "@context": "https://schema.org";
  "@graph": Node[];
}

const LOGO = { path: "/web-app-manifest-512x512.png", size: 512 };

const graph = (...nodes: Node[]): JsonLdDocument => ({
  "@context": "https://schema.org",
  "@graph": nodes,
});

const ORGANIZATION_ID = () => siteUrl("/#organization");

function organization(): Node {
  return {
    "@type": "Organization",
    "@id": ORGANIZATION_ID(),
    name: SITE_NAME,
    url: siteUrl("/"),
    logo: {
      "@type": "ImageObject",
      url: siteUrl(LOGO.path),
      width: LOGO.size,
      height: LOGO.size,
    },
    sameAs: [GITHUB_URL],
  };
}

const publisherRef = () => ({ "@id": ORGANIZATION_ID() });

/** The language a page's own content is written in. */
const inLanguage = (locale: Locale) => LOCALE_TAGS[locale].html;

/** What the app does on mainnet today, from the status registry: nothing testnet-only or soon. */
export function liveFeatureList(locale: Locale): string[] {
  const copy = SITE[locale];
  const features = FEATURES.filter((f) => f.status === "live").map(
    (f) => copy.features[f.id].title
  );
  if (LIVE_EXIT_PROTOCOLS.length === 0) return features;
  const exits = copy.list(LIVE_EXIT_PROTOCOLS.map((p) => p.name));
  return [...features, copy.structuredData.positionExits(exits)];
}

/** The home page: the organization, the site, and the app itself. */
export function homeJsonLd(description: string, locale: Locale): JsonLdDocument {
  const home = localePath(locale, "/");
  return graph(
    organization(),
    {
      "@type": "WebSite",
      "@id": siteUrl(`${home}#website`),
      name: SITE_NAME,
      url: siteUrl(home),
      inLanguage: inLanguage(locale),
      publisher: publisherRef(),
    },
    {
      "@type": "WebApplication",
      name: SITE_NAME,
      url: siteUrl(home),
      description,
      inLanguage: inLanguage(locale),
      applicationCategory: "FinanceApplication",
      operatingSystem: "Web Browser",
      isAccessibleForFree: true,
      featureList: liveFeatureList(locale),
      publisher: publisherRef(),
    }
  );
}

/** The FAQ page, from the same items the accordion renders. */
export function faqJsonLd(items: readonly FaqItem[], locale: Locale): JsonLdDocument {
  return graph({
    "@type": "FAQPage",
    url: siteUrl(localePath(locale, "/faq")),
    inLanguage: inLanguage(locale),
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: nodeText(item.a) },
    })),
  });
}

function breadcrumbs(trail: { name: string; path: string }[]): Node {
  return {
    "@type": "BreadcrumbList",
    itemListElement: trail.map((crumb, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: crumb.name,
      item: siteUrl(crumb.path),
    })),
  };
}

const blogTrail = (locale: Locale) => [
  { name: SITE[locale].structuredData.home, path: localePath(locale, "/") },
  { name: SITE[locale].structuredData.blog, path: localePath(locale, "/blog") },
];

/** The blog index: the blog and its posts, and where it sits. */
export function blogJsonLd(posts: readonly PostMeta[], locale: Locale): JsonLdDocument {
  return graph(
    {
      "@type": "Blog",
      name: SITE[locale].metadata.blogName(SITE_NAME),
      url: siteUrl(localePath(locale, "/blog")),
      inLanguage: inLanguage(locale),
      publisher: organization(),
      blogPost: posts.map((post) => ({
        "@type": "BlogPosting",
        headline: post.title,
        url: siteUrl(localePath(locale, `/blog/${post.slug}`)),
        datePublished: postTimestamp(post.publishedAt),
        dateModified: postTimestamp(post.updatedAt),
      })),
    },
    breadcrumbs(blogTrail(locale))
  );
}

/** One post: the article, complete enough for article rich results, and where it sits. */
export function postJsonLd(post: Post, locale: Locale): JsonLdDocument {
  const path = localePath(locale, `/blog/${post.slug}`);
  const url = siteUrl(path);
  return graph(
    {
      "@type": "Article",
      headline: post.title,
      description: post.description,
      inLanguage: inLanguage(locale),
      datePublished: postTimestamp(post.publishedAt),
      dateModified: postTimestamp(post.updatedAt),
      image: [siteUrl(postShareImage(post.slug, post.title, locale).url)],
      mainEntityOfPage: { "@type": "WebPage", "@id": url },
      url,
      author: { "@type": "Organization", name: SITE_NAME, url: siteUrl("/") },
      publisher: organization(),
      keywords: post.tags.join(", "),
    },
    breadcrumbs([...blogTrail(locale), { name: post.title, path }])
  );
}

const UNSAFE_IN_SCRIPT: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "/": "\\u002f",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

/** JSON safe to place inside a `<script>` element: nothing in it can close the element or break
 *  a line in a JavaScript parser. */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/[<>\/\u2028\u2029]/g, (c) => UNSAFE_IN_SCRIPT[c]!);
}
