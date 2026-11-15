import { shareImage } from "@/components/seo/ShareImage";
import { getAllSlugs, getPost } from "@/lib/blog";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return getAllSlugs().map((slug) => ({ slug }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const post = getPost((await params).slug);
  return shareImage({ eyebrow: `Blog · ${post.category}`, headline: post.title });
}
