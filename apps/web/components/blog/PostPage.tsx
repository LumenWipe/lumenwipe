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
  type Post,
} from "@/lib/blog";
import { postTimestamp } from "@/lib/blog-date";
import type { Locale } from "@/lib/i18n/locale";
import { BLOG } from "@/lib/i18n/messages/blog";
import { localePath, pageMetadata, postShareImage, type SpanishPage } from "@/lib/site/pages";
import { spanishPages } from "@/lib/site/spanish-pages";
import { postJsonLd } from "@/lib/site/structured-data";
import JsonLd from "@/components/seo/JsonLd";
import CategoryBadge from "@/components/blog/CategoryBadge";
import BlogToc from "@/components/blog/BlogToc";
import YouTubeEmbed from "@/components/blog/YouTubeEmbed";
import PostDates from "@/components/blog/PostDates";
import PostNextStep from "@/components/blog/PostNextStep";
import RelatedPosts from "@/components/blog/RelatedPosts";
import { baseReserveComponents } from "@/components/blog/BaseReserve";

/** The route params of every post published in `locale`. */
export function postStaticParams(locale: Locale): { slug: string }[] {
  return getAllSlugs(locale).map((slug) => ({ slug }));
}

/** The post at `slug` in `locale`, or null when there is none. */
function findPost(slug: string, locale: Locale): Post | null {
  try {
    return getPost(slug, locale);
  } catch (error) {
    if (error instanceof PostNotFoundError) return null;
    throw error;
  }
}

/** The metadata of the post at `slug` in `locale`, with its other language when it has one. A
 *  translation shares its English post's share image. */
export function postMetadata(
  locale: Locale,
  slug: string,
  pages: readonly SpanishPage[] = spanishPages()
): Metadata {
  const post = findPost(slug, locale);
  if (!post) return {};
  const image = locale === "en" ? post : getPost(slug);
  return {
    ...pageMetadata(
      {
        path: localePath(locale, `/blog/${slug}`),
        locale,
        title: post.title,
        description: post.description,
        shareImage: postShareImage(slug, image.title),
        blogFeed: locale === "en",
        openGraph: {
          type: "article",
          publishedTime: postTimestamp(post.publishedAt),
          modifiedTime: postTimestamp(post.updatedAt),
          tags: post.tags,
        },
      },
      pages
    ),
    keywords: post.tags,
  };
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

function mdxComponents(locale: Locale) {
  return {
    h2: makeHeadingComponent("h2"),
    h3: makeHeadingComponent("h3"),
    YouTubeEmbed,
    ...baseReserveComponents(locale),
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
}

/** The post at `slug` in `locale`. */
export default function PostPage({ locale, slug }: { locale: Locale; slug: string }) {
  const post = findPost(slug, locale);
  if (!post) notFound();

  const T = BLOG[locale].post;
  const toc = extractToc(post.content);
  const related = relatedPosts(post, getAllPostMetas(locale));

  return (
    <>
      <JsonLd data={postJsonLd(post, locale)} />

      <div className="max-w-5xl mx-auto px-5 lg:px-8 py-12">
        <Link
          href={localePath(locale, "/blog")}
          className="inline-flex items-center gap-1.5 mkt-mono text-xs text-fg-muted hover:text-white transition-colors mb-8"
        >
          <ArrowLeft className="h-3 w-3" />
          {T.allArticles}
        </Link>

        <div className="flex gap-10">
          <article className="flex-1 min-w-0">
            <header className="mb-8 pb-8 border-b border-white/10">
              <div className="mb-4">
                <CategoryBadge category={post.category} locale={locale} />
              </div>
              <h1 className="mkt-display text-3xl md:text-display font-extrabold text-white leading-[1.05] mb-4 tracking-tight">
                {post.title}
              </h1>
              <p className="text-white/85 text-base leading-relaxed mb-5">{post.description}</p>
              <PostDates post={post} locale={locale} />
            </header>

            <div className="prose prose-invert max-w-none">
              <MDXRemote
                source={post.content}
                components={mdxComponents(locale)}
                options={{
                  mdxOptions: {
                    remarkPlugins: [remarkGfm],
                  },
                }}
              />
            </div>

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

            <PostNextStep lead={post.cta} locale={locale} />
            <RelatedPosts posts={related} locale={locale} />
          </article>

          <BlogToc toc={toc} label={T.onThisPage} />
        </div>
      </div>
    </>
  );
}
