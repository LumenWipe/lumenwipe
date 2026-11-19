import type { Metadata } from "next";
import PostPage, { postMetadata, postStaticParams } from "@/components/blog/PostPage";

export const dynamicParams = false;

export function generateStaticParams() {
  return postStaticParams("es");
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  return postMetadata("es", (await params).slug);
}

export default async function SpanishPostPage({ params }: { params: Promise<{ slug: string }> }) {
  return <PostPage locale="es" slug={(await params).slug} />;
}
