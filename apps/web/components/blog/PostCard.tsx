import Link from "next/link";
import { Calendar, Clock } from "lucide-react";
import type { PostMeta } from "@/lib/blog";
import { formatPostDate } from "@/lib/blog-date";
import type { Locale } from "@/lib/i18n/locale";
import { BLOG } from "@/lib/i18n/messages/blog";
import { localePath } from "@/lib/site/pages";
import CategoryBadge from "./CategoryBadge";

export default function PostCard({ post, locale }: { post: PostMeta; locale: Locale }) {
  return (
    <Link
      href={localePath(locale, `/blog/${post.slug}`)}
      className="group flex flex-col mkt-panel rounded-2xl p-6 hover:border-accent/40 transition-colors duration-200"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <CategoryBadge category={post.category} locale={locale} />
      </div>

      <h2 className="mkt-display text-lg font-bold text-white leading-snug mb-2 group-hover:text-accent transition-colors duration-200">
        {post.title}
      </h2>

      <p className="text-sm text-fg-muted leading-relaxed mb-4 flex-1 line-clamp-3">
        {post.description}
      </p>

      <div className="flex items-center gap-4 mkt-mono text-caption text-fg-subtle mt-auto pt-3 border-t border-white/8">
        <span className="flex items-center gap-1.5">
          <Calendar className="h-3 w-3" />
          <time dateTime={post.publishedAt}>{formatPostDate(locale, post.publishedAt)}</time>
        </span>
        <span className="flex items-center gap-1.5">
          <Clock className="h-3 w-3" />
          {BLOG[locale].readingTime(post.readingMinutes)}
        </span>
      </div>
    </Link>
  );
}
