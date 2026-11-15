import type { FaqItem } from "@/components/marketing/FaqAccordion";
import type { Post, PostMeta } from "@/lib/blog";
import { nodeText } from "@/lib/site/node-text";
import { GITHUB_URL } from "@/lib/site/navigation";
import { postShareImage, SITE_NAME } from "@/lib/site/pages";
import { FEATURES, LIVE_EXIT_PROTOCOLS, listNames } from "@/lib/site/status";
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

/** What the app does on mainnet today, from the status registry: nothing testnet-only or soon. */
export function liveFeatureList(): string[] {
  const features = FEATURES.filter((f) => f.status === "live").map((f) => f.title);
  if (LIVE_EXIT_PROTOCOLS.length === 0) return features;
  return [...features, `Position exits: ${listNames(LIVE_EXIT_PROTOCOLS)}`];
}

/** The home page: the organization, the site, and the app itself. */
export function homeJsonLd(description: string): JsonLdDocument {
  return graph(
    organization(),
    {
      "@type": "WebSite",
      "@id": siteUrl("/#website"),
      name: SITE_NAME,
      url: siteUrl("/"),
      publisher: publisherRef(),
    },
    {
      "@type": "WebApplication",
      name: SITE_NAME,
      url: siteUrl("/"),
      description,
      applicationCategory: "FinanceApplication",
      operatingSystem: "Web Browser",
      isAccessibleForFree: true,
      featureList: liveFeatureList(),
      publisher: publisherRef(),
    }
  );
}

/** The FAQ page, from the same items the accordion renders. */
export function faqJsonLd(items: readonly FaqItem[]): JsonLdDocument {
  return graph({
    "@type": "FAQPage",
    url: siteUrl("/faq"),
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

const BLOG_TRAIL = [
  { name: "Home", path: "/" },
  { name: "Blog", path: "/blog" },
];

/** The blog index: the blog and its posts, and where it sits. */
export function blogJsonLd(posts: readonly PostMeta[]): JsonLdDocument {
  return graph(
    {
      "@type": "Blog",
      name: `${SITE_NAME} blog`,
      url: siteUrl("/blog"),
      publisher: organization(),
      blogPost: posts.map((post) => ({
        "@type": "BlogPosting",
        headline: post.title,
        url: siteUrl(`/blog/${post.slug}`),
        datePublished: post.publishedAt,
        dateModified: post.updatedAt,
      })),
    },
    breadcrumbs(BLOG_TRAIL)
  );
}

/** One post: the article, complete enough for article rich results, and where it sits. */
export function postJsonLd(post: Post): JsonLdDocument {
  const url = siteUrl(`/blog/${post.slug}`);
  return graph(
    {
      "@type": "Article",
      headline: post.title,
      description: post.description,
      datePublished: post.publishedAt,
      dateModified: post.updatedAt,
      image: [siteUrl(postShareImage(post.slug, post.title).url)],
      mainEntityOfPage: { "@type": "WebPage", "@id": url },
      url,
      author: { "@type": "Organization", name: SITE_NAME, url: siteUrl("/") },
      publisher: organization(),
      keywords: post.tags.join(", "),
    },
    breadcrumbs([...BLOG_TRAIL, { name: post.title, path: `/blog/${post.slug}` }])
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
