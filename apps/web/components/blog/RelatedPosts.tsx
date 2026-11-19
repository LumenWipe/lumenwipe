import Link from "next/link";
import type { PostMeta } from "@/lib/blog";
import type { Locale } from "@/lib/i18n/locale";
import { BLOG } from "@/lib/i18n/messages/blog";
import { localePath } from "@/lib/site/pages";

/** Other posts on the same topics, or nothing when no post shares a tag. */
export default function RelatedPosts({
  posts,
  locale,
}: {
  posts: readonly PostMeta[];
  locale: Locale;
}) {
  if (posts.length === 0) return null;
  return (
    <section aria-labelledby="post-related" className="mt-10">
      <h2 id="post-related" className="mkt-display mb-4 text-lg font-bold text-white">
        {BLOG[locale].post.related}
      </h2>
      <ul className="grid gap-4 md:grid-cols-3">
        {posts.map((post) => (
          <li key={post.slug} className="mkt-panel rounded-2xl p-5">
            <Link
              href={localePath(locale, `/blog/${post.slug}`)}
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
