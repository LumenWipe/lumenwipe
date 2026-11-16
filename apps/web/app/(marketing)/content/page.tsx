import type { Metadata } from "next";
import { pageMetadata } from "@/lib/site/pages";
import { getAllPostMetas } from "@/lib/blog";
import PostCard from "@/components/blog/PostCard";
import ContentStatusTable from "@/components/blog/ContentStatusTable";
import { contentStatusRows } from "@/lib/site/content-status";
import { Play } from "lucide-react";
import YouTubeEmbed from "@/components/blog/YouTubeEmbed";
import { VIDEOS } from "@/lib/site/videos";

export const metadata: Metadata = pageMetadata({
  path: "/content",
  title: "Content",
  description:
    "Videos, guides, and technical deep dives on LumenWipe - closing Stellar accounts, recovering XLM reserves, and DeFi position unwinding.",
});

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="mkt-eyebrow inline-flex items-center gap-2 text-accent/90">
      <span className="h-px w-6 bg-line-strong" />
      {children}
    </span>
  );
}

function LangBadge({ lang }: { lang: "EN" | "ES" }) {
  return (
    <span className="mkt-mono rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-caption uppercase tracking-wider text-fg-subtle">
      {lang}
    </span>
  );
}

function DurationBadge({ duration }: { duration: string }) {
  return (
    <span className="mkt-mono inline-flex items-center gap-1 text-caption text-fg-subtle">
      <Play className="h-2.5 w-2.5" />
      {duration}
    </span>
  );
}

export default function ContentPage() {
  const posts = getAllPostMetas();

  return (
    <div className="mx-auto max-w-5xl px-5 py-14 lg:px-8 lg:py-20">
      {/* Header */}
      <div className="mb-14">
        <Eyebrow>Content</Eyebrow>
        <h1 className="mkt-display mt-4 mb-3 text-4xl font-extrabold tracking-tight text-white">
          Videos &amp; articles
        </h1>
        <p className="max-w-2xl text-base leading-relaxed text-white/70">
          Walkthroughs, deep dives, and guides on closing Stellar accounts and recovering locked
          reserves.
        </p>
      </div>

      {/* Videos */}
      <section className="mb-16">
        <h2 className="mkt-display mb-6 text-xl font-bold text-white">Videos</h2>
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {VIDEOS.map((v) => (
            <div key={v.id} className="mkt-card flex flex-col overflow-hidden">
              <YouTubeEmbed id={v.id} title={v.title} className="" />
              {/* Metadata */}
              <div className="flex flex-1 flex-col gap-2 p-4">
                <div className="flex items-center gap-2">
                  <LangBadge lang={v.lang} />
                  <DurationBadge duration={v.duration} />
                </div>
                <h3 className="mkt-display text-body font-semibold leading-snug text-white">
                  {v.title}
                </h3>
                <p className="text-body-sm leading-relaxed text-fg-muted">{v.description}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Divider */}
      <div className="mb-14 border-t border-white/[0.07]" />

      {/* Blog */}
      <section>
        <h2 className="mkt-display mb-6 text-xl font-bold text-white">From the blog</h2>
        {posts.length > 0 ? (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            {posts.map((post) => (
              <PostCard key={post.slug} post={post} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-fg-subtle">No articles published yet.</p>
        )}
      </section>

      <section aria-labelledby="content-status" className="mt-16">
        <h2 id="content-status" className="mkt-display mb-2 text-xl font-bold text-white">
          Article status
        </h2>
        <p className="mb-6 max-w-2xl text-sm leading-relaxed text-white/70">
          What is published and what is planned next.
        </p>
        <ContentStatusTable rows={contentStatusRows(posts)} />
      </section>
    </div>
  );
}
