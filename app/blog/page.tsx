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
    <div className="max-w-5xl mx-auto px-4 py-12">
      <div className="mb-12">
        <h1 className="text-3xl font-bold text-foreground mb-3 tracking-tight">Blog</h1>
        <p className="text-muted-foreground text-base max-w-2xl leading-relaxed">
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
        <div className="text-center py-20 text-muted-foreground text-sm">
          No articles published yet.
        </div>
      )}
    </div>
  );
}
