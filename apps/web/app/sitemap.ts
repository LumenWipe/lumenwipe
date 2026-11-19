import type { MetadataRoute } from "next";
import { getAllPostMetas, type PostMeta } from "@/lib/blog";
import type { Locale } from "@/lib/i18n/locale";
import { languageAlternates, localePath, sitemapPages } from "@/lib/site/pages";
import { spanishPages } from "@/lib/site/spanish-pages";
import { siteUrl } from "@/lib/site/url";

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = spanishPages();
  const post = (locale: Locale) => (meta: PostMeta) => {
    const path = localePath(locale, `/blog/${meta.slug}`);
    const languages = languageAlternates(locale, path, pages);
    return {
      url: siteUrl(path),
      lastModified: new Date(meta.updatedAt),
      changeFrequency: "monthly" as const,
      priority: 0.7,
      ...(languages ? { alternates: { languages } } : {}),
    };
  };

  return [
    ...sitemapPages(pages),
    ...getAllPostMetas().map(post("en")),
    ...getAllPostMetas("es").map(post("es")),
  ];
}
