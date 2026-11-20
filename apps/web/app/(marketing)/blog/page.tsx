import BlogIndexPage, { blogIndexMetadata } from "@/components/blog/BlogIndexPage";

export const metadata = blogIndexMetadata("en");

export default function EnglishBlogPage() {
  return <BlogIndexPage locale="en" />;
}
