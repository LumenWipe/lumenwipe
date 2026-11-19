import type { Metadata } from "next";
import JsonLd from "@/components/seo/JsonLd";
import { BLOG_DESCRIPTION, pageMetadata } from "@/lib/site/pages";
import { blogJsonLd } from "@/lib/site/structured-data";
import Link from "next/link";
import { getAllPostMetas } from "@/lib/blog";
import PostCard from "@/components/blog/PostCard";
import { Button } from "@/components/ui/button";
import { SITE_LOCALE } from "@/lib/i18n/locale";
import { BLOG } from "@/lib/i18n/messages/blog";

const T = BLOG[SITE_LOCALE];

export const metadata: Metadata = pageMetadata({
  path: "/blog",
  title: T.title,
  description: BLOG_DESCRIPTION,
  blogFeed: true,
});

export default function BlogPage() {
  const posts = getAllPostMetas();

  return (
    <div className="max-w-5xl mx-auto px-5 lg:px-8 py-14 lg:py-20">
      <JsonLd data={blogJsonLd(posts, SITE_LOCALE)} />
      <div className="mb-12">
        <span className="mkt-eyebrow inline-flex items-center gap-2 text-fg-muted">
          <span className="h-px w-6 bg-line-strong" />
          {T.eyebrow}
        </span>
        <h1 className="mkt-display text-4xl font-extrabold text-white mt-4 mb-3 tracking-tight">
          {T.heading}
        </h1>
        <p className="text-white/85 text-base max-w-2xl leading-relaxed">{T.lede}</p>
      </div>

      {posts.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {posts.map((post) => (
            <PostCard key={post.slug} post={post} />
          ))}
        </div>
      ) : (
        <div className="mkt-card flex flex-col items-center gap-4 px-6 py-14 text-center">
          <p className="text-body font-semibold text-white">{T.noPosts}</p>
          <p className="max-w-md text-sm leading-relaxed text-fg-muted">{T.noPostsBody}</p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link href="/content">{T.watchVideos}</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href="/how-it-works">{T.howItWorks}</Link>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
