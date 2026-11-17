import type { PostMeta } from "@/lib/blog";
import { postTimestamp } from "@/lib/blog-date";
import { LOCALE_TAGS, SITE_LOCALE } from "@/lib/i18n/locale";
import { BLOG_DESCRIPTION, BLOG_FEED } from "@/lib/site/pages";
import { siteUrl } from "@/lib/site/url";

// Characters XML 1.0 does not allow anywhere in a document, even escaped.
const NOT_XML_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|\p{Cs}/gu;

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** `value` as XML text or attribute content. */
export function escapeXml(value: string): string {
  return value.replace(NOT_XML_CHAR, "").replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}

/** A `YYYY-MM-DD` post date as the RFC 822 date RSS expects. */
function rssDate(isoDate: string): string {
  return new Date(postTimestamp(isoDate)).toUTCString();
}

function element(name: string, value: string): string {
  return `<${name}>${escapeXml(value)}</${name}>`;
}

/** The blog as an RSS 2.0 feed, its posts in the order given: the blog index's, newest first. */
export function blogFeed(posts: readonly PostMeta[]): string {
  const lastUpdate = posts
    .map((p) => p.updatedAt)
    .sort()
    .at(-1);
  const items = posts.map((post) => {
    const url = siteUrl(`/blog/${post.slug}`);
    return [
      "<item>",
      element("title", post.title),
      element("link", url),
      `<guid isPermaLink="true">${escapeXml(url)}</guid>`,
      element("pubDate", rssDate(post.publishedAt)),
      element("category", post.category),
      element("description", post.description),
      "</item>",
    ].join("");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "<channel>",
    element("title", BLOG_FEED.title),
    element("link", siteUrl("/blog")),
    element("description", BLOG_DESCRIPTION),
    element("language", LOCALE_TAGS[SITE_LOCALE].html),
    `<atom:link href="${escapeXml(siteUrl(BLOG_FEED.path))}" rel="self" type="${escapeXml(BLOG_FEED.type)}"/>`,
    ...(lastUpdate === undefined ? [] : [element("lastBuildDate", rssDate(lastUpdate))]),
    ...items,
    "</channel>",
    "</rss>",
    "",
  ].join("\n");
}
