import type { Metadata } from "next";
import { getAllPostMetas } from "@/lib/blog";
import PostCard from "@/components/blog/PostCard";
import { Play } from "lucide-react";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "";

export const metadata: Metadata = {
  title: "Content",
  description:
    "Videos, guides, and technical deep dives on LumenWipe - closing Stellar accounts, recovering XLM reserves, and DeFi position unwinding.",
  openGraph: {
    title: "Content | LumenWipe",
    description: "Videos and articles on Stellar account management and reserve recovery.",
    url: `${APP_URL}/content`,
    type: "website",
  },
  alternates: {
    canonical: `${APP_URL}/content`,
  },
};

type Video = {
  id: string;
  title: string;
  description: string;
  lang: "EN" | "ES";
  duration: string;
};

const VIDEOS: Video[] = [
  {
    id: "vD3xhPpqah8",
    title: "What is LumenWipe?",
    description:
      "A 3-minute overview of what LumenWipe does, why Stellar reserves get locked, and how the non-custodial close flow works.",
    lang: "EN",
    duration: "3 min",
  },
  {
    id: "nVS2zI9mRzw",
    title: "Full walkthrough: testnet, playground & mainnet",
    description:
      "An 11-minute demo covering the full demolition flow - from testnet dry run to a live mainnet account close.",
    lang: "EN",
    duration: "11 min",
  },
  {
    id: "eRkcNd9996c",
    title: "Demo completo: testnet, playground y mainnet",
    description:
      "Demo de 14 minutos que cubre el flujo completo: testnet, playground y cierre real en mainnet.",
    lang: "ES",
    duration: "14 min",
  },
];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="mkt-eyebrow inline-flex items-center gap-2 text-stellar/90">
      <span className="h-px w-6 bg-stellar/50" />
      {children}
    </span>
  );
}

function LangBadge({ lang }: { lang: "EN" | "ES" }) {
  return (
    <span className="mkt-mono rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[0.62rem] uppercase tracking-wider text-white/45">
      {lang}
    </span>
  );
}

function DurationBadge({ duration }: { duration: string }) {
  return (
    <span className="mkt-mono inline-flex items-center gap-1 text-[0.68rem] text-white/35">
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
              {/* 16:9 embed */}
              <div className="relative w-full" style={{ paddingBottom: "56.25%" }}>
                <iframe
                  src={`https://www.youtube-nocookie.com/embed/${v.id}`}
                  title={v.title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  loading="lazy"
                  className="absolute inset-0 h-full w-full border-0"
                />
              </div>
              {/* Metadata */}
              <div className="flex flex-1 flex-col gap-2 p-4">
                <div className="flex items-center gap-2">
                  <LangBadge lang={v.lang} />
                  <DurationBadge duration={v.duration} />
                </div>
                <h3 className="mkt-display text-[0.95rem] font-semibold leading-snug text-white">
                  {v.title}
                </h3>
                <p className="text-[0.82rem] leading-relaxed text-white/55">{v.description}</p>
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
          <p className="text-sm text-white/45">No articles published yet.</p>
        )}
      </section>
    </div>
  );
}
