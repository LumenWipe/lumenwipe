import type { Metadata } from "next";
import PostPage, { postMetadata, postStaticParams } from "@/components/blog/PostPage";

export const dynamicParams = false;

export function generateStaticParams() {
  return postStaticParams("en");
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  return postMetadata("en", (await params).slug);
}

export default async function EnglishPostPage({ params }: { params: Promise<{ slug: string }> }) {
  return <PostPage locale="en" slug={(await params).slug} />;
}
