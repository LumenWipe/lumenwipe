import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { Calendar, Clock, ArrowLeft } from "lucide-react";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import { getAllSlugs, getPost, extractToc, slugify } from "@/lib/blog";
import CategoryBadge from "@/components/blog/CategoryBadge";
import BlogToc from "@/components/blog/BlogToc";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "";

export async function generateStaticParams() {
  return getAllSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  try {
    const post = getPost(slug);
    return {
      title: post.title,
      description: post.description,
      keywords: post.tags,
      openGraph: {
        title: post.title,
        description: post.description,
        url: `${APP_URL}/blog/${slug}`,
        type: "article",
        publishedTime: post.publishedAt,
        tags: post.tags,
      },
      twitter: {
        card: "summary_large_image",
        title: post.title,
        description: post.description,
      },
      alternates: {
        canonical: `${APP_URL}/blog/${slug}`,
      },
    };
  } catch {
    return {};
  }
}

function extractTextFromChildren(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children))
    return (children as React.ReactNode[]).map(extractTextFromChildren).join("");
  if (children !== null && typeof children === "object" && "props" in (children as object)) {
    const el = children as React.ReactElement<{ children?: React.ReactNode }>;
    return extractTextFromChildren(el.props?.children);
  }
  return "";
}

function makeHeadingComponent(Tag: "h2" | "h3") {
  return function HeadingWithAnchor({ children }: { children: React.ReactNode }) {
    const text = extractTextFromChildren(children);
    const id = slugify(text);
    return (
      <Tag id={id} className="scroll-mt-20">
        {children}
      </Tag>
    );
  };
}

const mdxComponents = {
  h2: makeHeadingComponent("h2"),
  h3: makeHeadingComponent("h3"),
  a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
    const isExternal = href?.startsWith("http");
    return (
      <a
        href={href}
        target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noopener noreferrer" : undefined}
        {...props}
      >
        {children}
      </a>
    );
  },
};

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  let post;
  try {
    post = getPost(slug);
  } catch {
    notFound();
  }

  const toc = extractToc(post.content);
  const date = new Date(post.publishedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.title,
    description: post.description,
    datePublished: post.publishedAt,
    author: {
      "@type": "Organization",
      name: "LumenWipe",
      url: APP_URL,
    },
    publisher: {
      "@type": "Organization",
      name: "LumenWipe",
      url: APP_URL,
    },
    keywords: post.tags.join(", "),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <div className="max-w-5xl mx-auto px-5 lg:px-8 py-12">
        {/* Breadcrumb */}
        <Link
          href="/blog"
          className="inline-flex items-center gap-1.5 mkt-mono text-xs text-white/65 hover:text-white transition-colors mb-8"
        >
          <ArrowLeft className="h-3 w-3" />
          All articles
        </Link>

        <div className="flex gap-10">
          {/* Article */}
          <article className="flex-1 min-w-0">
            {/* Header */}
            <header className="mb-8 pb-8 border-b border-white/10">
              <div className="mb-4">
                <CategoryBadge category={post.category} />
              </div>
              <h1 className="mkt-display text-3xl md:text-[2.6rem] font-extrabold text-white leading-[1.05] mb-4 tracking-tight">
                {post.title}
              </h1>
              <p className="text-white/85 text-base leading-relaxed mb-5">{post.description}</p>
              <div className="flex items-center gap-4 mkt-mono text-xs text-white/55">
                <span className="flex items-center gap-1.5">
                  <Calendar className="h-3 w-3" />
                  {date}
                </span>
                <span className="flex items-center gap-1.5">
                  <Clock className="h-3 w-3" />
                  {post.readingTime}
                </span>
              </div>
            </header>

            {/* Content */}
            <div className="prose prose-invert max-w-none">
              <MDXRemote
                source={post.content}
                components={mdxComponents}
                options={{
                  mdxOptions: {
                    remarkPlugins: [remarkGfm],
                  },
                }}
              />
            </div>

            {/* Tags */}
            {post.tags.length > 0 && (
              <div className="mt-10 pt-8 border-t border-border">
                <div className="flex flex-wrap gap-2">
                  {post.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-xs px-2 py-1 rounded bg-secondary text-muted-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </article>

          {/* TOC sidebar with scroll-spy */}
          <BlogToc toc={toc} />
        </div>
      </div>
    </>
  );
}
