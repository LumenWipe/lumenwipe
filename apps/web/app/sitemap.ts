import type { MetadataRoute } from "next";
import { getAllPostMetas } from "@/lib/blog";
import { sitemapPages } from "@/lib/site/pages";
import { siteUrl } from "@/lib/site/url";

export default function sitemap(): MetadataRoute.Sitemap {
  const posts: MetadataRoute.Sitemap = getAllPostMetas().map((post) => ({
    url: siteUrl(`/blog/${post.slug}`),
    lastModified: new Date(post.updatedAt),
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  return [...sitemapPages(), ...posts];
}
