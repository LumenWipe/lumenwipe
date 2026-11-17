import { getAllPostMetas } from "@/lib/blog";
import { blogFeed } from "@/lib/blog-feed";
import { BLOG_FEED } from "@/lib/site/pages";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(blogFeed(getAllPostMetas()), {
    headers: { "Content-Type": `${BLOG_FEED.type}; charset=utf-8` },
  });
}
