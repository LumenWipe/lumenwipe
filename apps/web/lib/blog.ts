import fs from "fs";
import path from "path";
import matter from "gray-matter";
import readingTime from "reading-time";
import { z } from "zod";

const CONTENT_DIR = path.join(process.cwd(), "content/blog");

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
  readingTime: string;
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

export type FrontMatter = Omit<PostMeta, "slug" | "readingTime"> & { cta?: string };

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

function readPublishedPosts(): Post[] {
  if (!fs.existsSync(CONTENT_DIR)) return [];
  return fs
    .readdirSync(CONTENT_DIR)
    .filter((f) => f.endsWith(".mdx"))
    .flatMap((file) => {
      const slug = file.replace(/\.mdx$/, "");
      const { data, content } = matter(fs.readFileSync(path.join(CONTENT_DIR, file), "utf8"));
      if (data.draft === true) return [];
      return [
        { slug, ...parseFrontMatter(slug, data), readingTime: readingTime(content).text, content },
      ];
    });
}

export function getAllPostMetas(): PostMeta[] {
  return readPublishedPosts()
    .map(({ content: _content, cta: _cta, ...meta }) => meta)
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
}

/** A published post by slug. The slug is matched against the posts on disk, never joined into a
 *  path. */
export function getPost(slug: string): Post {
  const post = readPublishedPosts().find((p) => p.slug === slug);
  if (!post) throw new PostNotFoundError(slug);
  return post;
}

export function getAllSlugs(): string[] {
  return readPublishedPosts().map((p) => p.slug);
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
