import type { PostMeta } from "@/lib/blog";

export interface PlannedArticle {
  /** The slug the article will publish under, which retires its row here. */
  slug: string;
  title: string;
}

export const PLANNED_ARTICLES: readonly PlannedArticle[] = [
  {
    slug: "multisig-weights-and-thresholds",
    title: "Multisig on Stellar: what signer weights and thresholds mean",
  },
  {
    slug: "sponsored-reserves",
    title: "Sponsored reserves on Stellar: sponsoring an entry and being sponsored",
  },
  {
    slug: "reuse-a-merged-stellar-address",
    title: "Can you reuse a Stellar address after merging the account?",
  },
  {
    slug: "why-closing-a-stellar-account-costs-xlm",
    title: "Why does closing a Stellar account cost XLM?",
  },
];

export type ContentStatus = "published" | "planned";

export interface ContentStatusRow {
  title: string;
  status: ContentStatus;
  /** The post's page and publication date; planned rows have neither. */
  href?: string;
  publishedAt?: string;
}

/** Every published post, newest first, then every planned article. Fails when a planned article
 *  has already been published, so the list cannot go stale. */
export function contentStatusRows(
  posts: readonly PostMeta[],
  planned: readonly PlannedArticle[] = PLANNED_ARTICLES
): ContentStatusRow[] {
  const published = new Set(posts.map((p) => p.slug));
  for (const article of planned) {
    if (published.has(article.slug)) {
      throw new Error(
        `Planned article "${article.slug}" is already published: remove it from PLANNED_ARTICLES`
      );
    }
  }
  return [
    ...posts.map((p) => ({
      title: p.title,
      status: "published" as const,
      href: `/blog/${p.slug}`,
      publishedAt: p.publishedAt,
    })),
    ...planned.map((a) => ({ title: a.title, status: "planned" as const })),
  ];
}
