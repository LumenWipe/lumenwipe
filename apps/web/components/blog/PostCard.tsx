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
      className="group flex flex-col mkt-panel rounded-2xl p-6 hover:border-stellar/40 transition-colors duration-200"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <CategoryBadge category={post.category} />
      </div>

      <h2 className="mkt-display text-lg font-bold text-white leading-snug mb-2 group-hover:text-stellar transition-colors duration-200">
        {post.title}
      </h2>

      <p className="text-sm text-white/55 leading-relaxed mb-4 flex-1 line-clamp-3">
        {post.description}
      </p>

      <div className="flex items-center gap-4 mkt-mono text-[0.7rem] text-white/40 mt-auto pt-3 border-t border-white/8">
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
