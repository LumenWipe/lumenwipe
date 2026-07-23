import type { MetadataRoute } from "next";
import { getAllPostMetas } from "@/lib/blog";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL!;

export default function sitemap(): MetadataRoute.Sitemap {
  const posts = getAllPostMetas();

  const blogEntries: MetadataRoute.Sitemap = posts.map((post) => ({
    url: `${APP_URL}/blog/${post.slug}`,
    lastModified: new Date(post.publishedAt),
    changeFrequency: "monthly" as const,
    priority: 0.7,
  }));

  return [
    {
      url: `${APP_URL}/mainnet`,
      changeFrequency: "monthly",
      priority: 1,
    },
    {
      url: `${APP_URL}/testnet`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${APP_URL}/blog`,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    ...blogEntries,
  ];
}
