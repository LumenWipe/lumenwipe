import BlogIndexPage, { blogIndexMetadata } from "@/components/blog/BlogIndexPage";

export const metadata = blogIndexMetadata("es");

export default function SpanishBlogPage() {
  return <BlogIndexPage locale="es" />;
}
