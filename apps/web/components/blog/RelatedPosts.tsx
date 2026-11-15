import Link from "next/link";
import type { PostMeta } from "@/lib/blog";

/** Other posts on the same topics, or nothing when no post shares a tag. */
export default function RelatedPosts({ posts }: { posts: readonly PostMeta[] }) {
  if (posts.length === 0) return null;
  return (
    <section aria-labelledby="post-related" className="mt-10">
      <h2 id="post-related" className="mkt-display mb-4 text-lg font-bold text-white">
        Related
      </h2>
      <ul className="grid gap-4 md:grid-cols-3">
        {posts.map((post) => (
          <li key={post.slug} className="mkt-panel rounded-2xl p-5">
            <Link
              href={`/blog/${post.slug}`}
              className="mkt-display text-sm font-semibold leading-snug text-accent hover:underline"
            >
              {post.title}
            </Link>
            <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-fg-muted">
              {post.description}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
