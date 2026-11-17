import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import {
  extractToc,
  getAllPostMetas,
  getAllSlugs,
  getPost,
  PostNotFoundError,
  relatedPosts,
  slugify,
} from "@/lib/blog";
import { pageMetadata, postShareImage } from "@/lib/site/pages";
import { postTimestamp } from "@/lib/blog-date";
import { postJsonLd } from "@/lib/site/structured-data";
import JsonLd from "@/components/seo/JsonLd";
import CategoryBadge from "@/components/blog/CategoryBadge";
import BlogToc from "@/components/blog/BlogToc";
import YouTubeEmbed from "@/components/blog/YouTubeEmbed";
import PostDates from "@/components/blog/PostDates";
import PostNextStep from "@/components/blog/PostNextStep";
import RelatedPosts from "@/components/blog/RelatedPosts";
import { BaseReserve, BaseReserveCheckedOn } from "@/components/blog/BaseReserve";

export const dynamicParams = false;

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
      ...pageMetadata({
        path: `/blog/${slug}`,
        title: post.title,
        description: post.description,
        shareImage: postShareImage(slug, post.title),
        blogFeed: true,
        openGraph: {
          type: "article",
          publishedTime: postTimestamp(post.publishedAt),
          modifiedTime: postTimestamp(post.updatedAt),
          tags: post.tags,
        },
      }),
      keywords: post.tags,
    };
  } catch (error) {
    if (error instanceof PostNotFoundError) return {};
    throw error;
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
  YouTubeEmbed,
  BaseReserve,
  BaseReserveCheckedOn,
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
  } catch (error) {
    if (error instanceof PostNotFoundError) notFound();
    throw error;
  }

  const toc = extractToc(post.content);
  const related = relatedPosts(post, getAllPostMetas());

  return (
    <>
      <JsonLd data={postJsonLd(post)} />

      <div className="max-w-5xl mx-auto px-5 lg:px-8 py-12">
        {/* Breadcrumb */}
        <Link
          href="/blog"
          className="inline-flex items-center gap-1.5 mkt-mono text-xs text-fg-muted hover:text-white transition-colors mb-8"
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
              <h1 className="mkt-display text-3xl md:text-display font-extrabold text-white leading-[1.05] mb-4 tracking-tight">
                {post.title}
              </h1>
              <p className="text-white/85 text-base leading-relaxed mb-5">{post.description}</p>
              <PostDates post={post} />
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
              <div className="mt-10 pt-8 border-t border-line">
                <div className="flex flex-wrap gap-2">
                  {post.tags.map((tag) => (
                    <span key={tag} className="text-xs px-2 py-1 rounded bg-line text-fg-muted">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <PostNextStep lead={post.cta} />
            <RelatedPosts posts={related} />
          </article>

          {/* TOC sidebar with scroll-spy */}
          <BlogToc toc={toc} />
        </div>
      </div>
    </>
  );
}
