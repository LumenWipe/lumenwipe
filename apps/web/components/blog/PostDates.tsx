import { Calendar, Clock, RefreshCw } from "lucide-react";
import type { PostMeta } from "@/lib/blog";
import { formatPostDate } from "@/lib/blog-date";
import type { Locale } from "@/lib/i18n/locale";
import { BLOG } from "@/lib/i18n/messages/blog";

/** When the post was published, when it last changed if it did, and how long it takes to read. */
export default function PostDates({
  post,
  locale,
}: {
  post: Pick<PostMeta, "publishedAt" | "updatedAt" | "readingMinutes">;
  locale: Locale;
}) {
  const T = BLOG[locale];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mkt-mono text-xs text-fg-muted">
      <span className="flex items-center gap-1.5">
        <Calendar aria-hidden="true" className="h-3 w-3" />
        <time dateTime={post.publishedAt}>{formatPostDate(locale, post.publishedAt)}</time>
      </span>
      {post.updatedAt > post.publishedAt && (
        <span className="flex items-center gap-1.5">
          <RefreshCw aria-hidden="true" className="h-3 w-3" />
          {T.updated}
          <time dateTime={post.updatedAt}>{formatPostDate(locale, post.updatedAt)}</time>
        </span>
      )}
      <span className="flex items-center gap-1.5">
        <Clock aria-hidden="true" className="h-3 w-3" />
        {T.readingTime(post.readingMinutes)}
      </span>
    </div>
  );
}
