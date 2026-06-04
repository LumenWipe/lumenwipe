import type { Metadata } from "next";
import { getAllPostMetas } from "@/lib/blog";
import PostCard from "@/components/blog/PostCard";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "";

export const metadata: Metadata = {
  title: "Blog",
  description:
    "Technical deep dives, project updates, and guides on Stellar account management, trustline removal, reserve recovery, and non-custodial DeFi tooling.",
  openGraph: {
    title: "Blog | LumenWipe",
    description: "Technical deep dives, project updates, and guides on Stellar account management.",
    url: `${APP_URL}/blog`,
    type: "website",
  },
  alternates: {
    canonical: `${APP_URL}/blog`,
  },
};

export default function BlogPage() {
  const posts = getAllPostMetas();

  return (
    <div className="max-w-5xl mx-auto px-5 lg:px-8 py-14 lg:py-20">
      <div className="mb-12">
        <span className="mkt-eyebrow inline-flex items-center gap-2 text-stellar/90">
          <span className="h-px w-6 bg-stellar/50" />
          Blog
        </span>
        <h1 className="mkt-display text-4xl font-extrabold text-white mt-4 mb-3 tracking-tight">
          Field notes on closing Stellar accounts
        </h1>
        <p className="text-white/55 text-base max-w-2xl leading-relaxed">
          Technical deep dives, project updates, and guides on Stellar account management, reserve
          recovery, and non-custodial tooling.
        </p>
      </div>

      {posts.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {posts.map((post) => (
            <PostCard key={post.slug} post={post} />
          ))}
        </div>
      ) : (
        <div className="text-center py-20 text-white/45 text-sm">No articles published yet.</div>
      )}
    </div>
  );
}
