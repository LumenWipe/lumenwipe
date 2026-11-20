import type { Metadata } from "next";
import Link from "next/link";
import JsonLd from "@/components/seo/JsonLd";
import PostCard from "@/components/blog/PostCard";
import { Button } from "@/components/ui/button";
import { getAllPostMetas } from "@/lib/blog";
import type { Locale } from "@/lib/i18n/locale";
import { BLOG } from "@/lib/i18n/messages/blog";
import { SITE } from "@/lib/i18n/messages/site";
import { localeHref, localePath, pageMetadata } from "@/lib/site/pages";
import { blogJsonLd } from "@/lib/site/structured-data";

/** The blog index's metadata in `locale`. Only the English index advertises the feed, which
 *  lists the English posts. */
export function blogIndexMetadata(locale: Locale): Metadata {
  return pageMetadata({
    path: localePath(locale, "/blog"),
    locale,
    title: BLOG[locale].title,
    description: SITE[locale].metadata.blogDescription,
    blogFeed: locale === "en",
  });
}

/** The blog index in `locale`: the posts published in that language, newest first. */
export default function BlogIndexPage({ locale }: { locale: Locale }) {
  const T = BLOG[locale];
  const posts = getAllPostMetas(locale);

  return (
    <div className="max-w-5xl mx-auto px-5 lg:px-8 py-14 lg:py-20">
      <JsonLd data={blogJsonLd(posts, locale)} />
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
            <PostCard key={post.slug} post={post} locale={locale} />
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
              <Link href={localeHref(locale, "/how-it-works")}>{T.howItWorks}</Link>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
