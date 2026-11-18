import type { Category } from "@/lib/blog";
import type { Locale } from "@/lib/i18n/locale";

const en = {
  title: "Blog",
  eyebrow: "Blog",
  heading: "Field notes on closing Stellar accounts",
  lede: "Technical deep dives, project updates, and guides on Stellar account management, reserve recovery, and non-custodial tooling.",
  noPosts: "No articles published yet.",
  noPostsBody:
    "The first guides are on the way. Until then, watch the walkthrough videos or read how a close works, step by step.",
  watchVideos: "Watch the videos",
  howItWorks: "How it works",
  categories: {
    Technical: "Technical",
    Updates: "Updates",
    Guides: "Guides",
  } satisfies Record<Category, string>,
  readingTime: (minutes: number): string => `${minutes} min read`,
  /** Precedes the date a post last changed. */
  updated: "Updated ",
  playVideo: (title: string): string => `Play video: ${title}`,
  status: {
    caption: "Published and planned articles",
    article: "Article",
    statusColumn: "Status",
    published: "Published",
    planned: "Planned",
    notYet: "Not yet",
  },
};

export type BlogCopy = typeof en;

export const BLOG: Record<Locale, BlogCopy> = { en, es: en };
