import Link from "next/link";
import { Calendar, Clock } from "lucide-react";
import type { PostMeta } from "@/lib/blog";
import CategoryBadge from "./CategoryBadge";

export default function PostCard({ post }: { post: PostMeta }) {
  const date = new Date(post.publishedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <Link
      href={`/blog/${post.slug}`}
      className="group flex flex-col bg-card border border-border rounded-lg p-6 hover:border-stellar/40 transition-colors duration-200"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <CategoryBadge category={post.category} />
      </div>

      <h2 className="text-base font-semibold text-foreground leading-snug mb-2 group-hover:text-stellar transition-colors duration-200">
        {post.title}
      </h2>

      <p className="text-sm text-muted-foreground leading-relaxed mb-4 flex-1 line-clamp-3">
        {post.description}
      </p>

      <div className="flex items-center gap-4 text-xs text-muted-foreground mt-auto pt-2 border-t border-border">
        <span className="flex items-center gap-1.5">
          <Calendar className="h-3 w-3" />
          {date}
        </span>
        <span className="flex items-center gap-1.5">
          <Clock className="h-3 w-3" />
          {post.readingTime}
        </span>
      </div>
    </Link>
  );
}
