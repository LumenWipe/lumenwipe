import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { Calendar, Clock, ArrowLeft } from "lucide-react";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import { getAllSlugs, getPost, extractToc, slugify } from "@/lib/blog";
import CategoryBadge from "@/components/blog/CategoryBadge";

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

      <div className="max-w-5xl mx-auto px-4 py-10">
        {/* Breadcrumb */}
        <Link
          href="/blog"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-8"
        >
          <ArrowLeft className="h-3 w-3" />
          All articles
        </Link>

        <div className="flex gap-10">
          {/* Article */}
          <article className="flex-1 min-w-0">
            {/* Header */}
            <header className="mb-8 pb-8 border-b border-border">
              <div className="mb-4">
                <CategoryBadge category={post.category} />
              </div>
              <h1 className="text-2xl md:text-3xl font-bold text-foreground leading-tight mb-4 tracking-tight">
                {post.title}
              </h1>
              <p className="text-muted-foreground text-base leading-relaxed mb-5">
                {post.description}
              </p>
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
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

          {/* TOC sidebar */}
          {toc.length > 0 && (
            <aside className="hidden lg:block w-52 flex-shrink-0">
              <div className="sticky top-20">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                  On this page
                </p>
                <nav>
                  <ul className="space-y-1">
                    {toc.map((entry) => (
                      <li key={entry.id}>
                        <a
                          href={`#${entry.id}`}
                          className={`block text-xs text-muted-foreground hover:text-foreground transition-colors py-0.5 leading-snug ${
                            entry.level === 3 ? "pl-3" : ""
                          }`}
                        >
                          {entry.text}
                        </a>
                      </li>
                    ))}
                  </ul>
                </nav>
              </div>
            </aside>
          )}
        </div>
      </div>
    </>
  );
}
