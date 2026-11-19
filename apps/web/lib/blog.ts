import fs from "fs";
import path from "path";
import matter from "gray-matter";
import readingTime from "reading-time";
import { z } from "zod";
import type { Locale } from "@/lib/i18n/locale";

const CONTENT_DIR = path.join(process.cwd(), "content/blog");

/** Where the posts in `locale` live: English at the root of the blog's content, each translation
 *  in a folder named after its locale, under its English post's slug. */
function contentDir(locale: Locale): string {
  return locale === "en" ? CONTENT_DIR : path.join(CONTENT_DIR, locale);
}

export const CATEGORIES = ["Technical", "Updates", "Guides"] as const;

export type Category = (typeof CATEGORIES)[number];

export interface PostMeta {
  slug: string;
  title: string;
  description: string;
  publishedAt: string;
  /** The last content change: the `updatedAt` front matter, or `publishedAt` when it was never
   *  edited after publishing. */
  updatedAt: string;
  category: Category;
  tags: string[];
  /** Minutes to read, rounded up as `reading-time` rounds them. */
  readingMinutes: number;
}

export interface Post extends PostMeta {
  /** The post's own lead for the next-step block, when it has one. */
  cta?: string;
  content: string;
}

export interface TocEntry {
  id: string;
  text: string;
  level: 2 | 3;
}

/** Thrown for a slug with no published post, so a caller can tell it from a broken post. */
export class PostNotFoundError extends Error {
  constructor(slug: string) {
    super(`No published post "${slug}"`);
    this.name = "PostNotFoundError";
  }
}

export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function extractToc(content: string): TocEntry[] {
  const headings = content.match(/^#{2,3}\s+.+/gm) ?? [];
  return headings.map((h) => {
    const level = (h.match(/^#+/)?.[0].length ?? 2) as 2 | 3;
    const text = h.replace(/^#+\s+/, "").trim();
    return { id: slugify(text), text, level };
  });
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** The post's `updatedAt`: a `YYYY-MM-DD` date no earlier than `publishedAt`, which it defaults to. */
export function resolveUpdatedAt(slug: string, publishedAt: string, updatedAt: unknown): string {
  if (updatedAt === undefined) return publishedAt;
  if (typeof updatedAt !== "string" || !isCalendarDate(updatedAt) || updatedAt < publishedAt) {
    throw new Error(
      `Post "${slug}" has an invalid updatedAt: use a YYYY-MM-DD date no earlier than publishedAt`
    );
  }
  return updatedAt;
}

const text = z.string().trim().min(1, "must not be empty");

const FRONT_MATTER = z.strictObject({
  title: text,
  description: text,
  publishedAt: z.string().refine(isCalendarDate, "must be a real date written as YYYY-MM-DD"),
  updatedAt: z.unknown().optional(),
  category: z.enum(CATEGORIES),
  tags: z.array(text).min(1, "must list at least one tag"),
  cta: text.optional(),
  draft: z.boolean().optional(),
});

export type FrontMatter = Omit<PostMeta, "slug" | "readingMinutes"> & { cta?: string };

/** Validates a published post's front matter, failing the build with the post and field named. */
export function parseFrontMatter(slug: string, data: unknown): FrontMatter {
  const result = FRONT_MATTER.safeParse(data);
  if (!result.success) {
    throw new Error(`Post "${slug}" has invalid front matter:\n${z.prettifyError(result.error)}`);
  }
  const { title, description, publishedAt, updatedAt, category, tags, cta } = result.data;
  return {
    title,
    description,
    publishedAt,
    updatedAt: resolveUpdatedAt(slug, publishedAt, updatedAt),
    category,
    tags,
    ...(cta === undefined ? {} : { cta }),
  };
}

/** Minutes to read `content`, rounded the way `reading-time` rounds its own text. */
export function minutesToRead(content: string): number {
  return Math.ceil(Number(readingTime(content).minutes.toFixed(2)));
}

function readPublishedPosts(locale: Locale = "en"): Post[] {
  const dir = contentDir(locale);
  if (!fs.existsSync(dir)) return [];
  const posts = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".mdx"))
    .sort()
    .flatMap((file) => {
      const slug = file.replace(/\.mdx$/, "");
      const { data, content } = matter(fs.readFileSync(path.join(dir, file), "utf8"));
      if (data.draft === true) return [];
      const name = locale === "en" ? slug : `${locale}/${slug}`;
      return [
        { slug, ...parseFrontMatter(name, data), readingMinutes: minutesToRead(content), content },
      ];
    });
  if (locale !== "en") {
    const english = new Set(readPublishedPosts().map((p) => p.slug));
    const orphan = posts.find((p) => !english.has(p.slug));
    if (orphan) {
      throw new Error(
        `Post "${locale}/${orphan.slug}" has no published English post: a translation keeps its English post's slug`
      );
    }
  }
  return posts;
}

export function getAllPostMetas(locale: Locale = "en"): PostMeta[] {
  return readPublishedPosts(locale)
    .map(({ content: _content, cta: _cta, ...meta }) => meta)
    .sort(
      (a, b) =>
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime() ||
        a.slug.localeCompare(b.slug)
    );
}

/** A published post in `locale` by slug. The slug is matched against the posts on disk, never
 *  joined into a path. */
export function getPost(slug: string, locale: Locale = "en"): Post {
  const post = readPublishedPosts(locale).find((p) => p.slug === slug);
  if (!post) throw new PostNotFoundError(slug);
  return post;
}

/** The slugs of the posts published in `locale`, in one order whatever order the directory
 *  lists them in. */
export function getAllSlugs(locale: Locale = "en"): string[] {
  return readPublishedPosts(locale).map((p) => p.slug);
}

/** Up to `limit` other posts sharing a tag with `post`, the most shared tags first, then newest. */
export function relatedPosts(
  post: Pick<PostMeta, "slug" | "tags">,
  posts: readonly PostMeta[],
  limit = 3
): PostMeta[] {
  const tags = new Set(post.tags);
  return posts
    .filter((p) => p.slug !== post.slug)
    .map((p) => ({ post: p, shared: p.tags.filter((t) => tags.has(t)).length }))
    .filter(({ shared }) => shared > 0)
    .sort(
      (a, b) =>
        b.shared - a.shared ||
        b.post.publishedAt.localeCompare(a.post.publishedAt) ||
        a.post.slug.localeCompare(b.post.slug)
    )
    .slice(0, limit)
    .map(({ post: p }) => p);
}
