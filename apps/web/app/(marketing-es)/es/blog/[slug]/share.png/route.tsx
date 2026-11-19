import { postShareCard, shareImage } from "@/components/seo/ShareImage";
import { getAllSlugs, getPost } from "@/lib/blog";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return getAllSlugs("es").map((slug) => ({ slug }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  return shareImage(postShareCard(getPost((await params).slug, "es"), "es"));
}
