import { Calendar, Clock, RefreshCw } from "lucide-react";
import type { PostMeta } from "@/lib/blog";
import { formatPostDate } from "@/lib/blog-date";

/** When the post was published, when it last changed if it did, and how long it takes to read. */
export default function PostDates({
  post,
}: {
  post: Pick<PostMeta, "publishedAt" | "updatedAt" | "readingTime">;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mkt-mono text-xs text-fg-muted">
      <span className="flex items-center gap-1.5">
        <Calendar aria-hidden="true" className="h-3 w-3" />
        <time dateTime={post.publishedAt}>{formatPostDate(post.publishedAt)}</time>
      </span>
      {post.updatedAt > post.publishedAt && (
        <span className="flex items-center gap-1.5">
          <RefreshCw aria-hidden="true" className="h-3 w-3" />
          Updated <time dateTime={post.updatedAt}>{formatPostDate(post.updatedAt)}</time>
        </span>
      )}
      <span className="flex items-center gap-1.5">
        <Clock aria-hidden="true" className="h-3 w-3" />
        {post.readingTime}
      </span>
    </div>
  );
}
