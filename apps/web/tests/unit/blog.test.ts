import { test, expect } from "bun:test";
import { getAllPostMetas, getAllSlugs, getPost } from "@/lib/blog";

test("getAllSlugs › excludes draft posts", () => {
  expect(getAllSlugs()).not.toContain("phase-1-launch");
});

test("getAllPostMetas › excludes draft posts", () => {
  const slugs = getAllPostMetas().map((post) => post.slug);
  expect(slugs).not.toContain("phase-1-launch");
});

test("getPost › throws for a draft post instead of returning unpublished content", () => {
  expect(() => getPost("phase-1-launch")).toThrow();
});

test("getAllPostMetas › every listed post has a publishedAt that parses to a valid date", () => {
  for (const post of getAllPostMetas()) {
    expect(Number.isNaN(new Date(post.publishedAt).getTime())).toBe(false);
  }
});
