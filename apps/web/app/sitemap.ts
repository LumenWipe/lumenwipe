import type { MetadataRoute } from "next";
import { getAllPostMetas } from "@/lib/blog";
import { INDEXED_PAGES, spanishIndexedPages } from "@/lib/site/pages";
import { siteUrl } from "@/lib/site/url";

export default function sitemap(): MetadataRoute.Sitemap {
  const pages: MetadataRoute.Sitemap = [...INDEXED_PAGES, ...spanishIndexedPages()].map((page) => ({
    url: siteUrl(page.path),
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }));

  const posts: MetadataRoute.Sitemap = getAllPostMetas().map((post) => ({
    url: siteUrl(`/blog/${post.slug}`),
    lastModified: new Date(post.updatedAt),
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  return [...pages, ...posts];
}
