import { test, expect, beforeAll, afterAll } from "bun:test";
import fs from "fs";
import path from "path";
import { getAllPostMetas, getAllSlugs, getPost } from "@/lib/blog";

const CONTENT_DIR = path.join(process.cwd(), "content/blog");
const DRAFT_SLUG = "test-draft-fixture";
const DRAFT_PATH = path.join(CONTENT_DIR, `${DRAFT_SLUG}.mdx`);

beforeAll(() => {
  fs.writeFileSync(
    DRAFT_PATH,
    `---
title: "Draft fixture"
description: "A draft post used only by blog.test.ts."
publishedAt: "pending"
draft: true
category: "Updates"
tags: []
---

Draft content that should never be published.
`
  );
});

afterAll(() => {
  fs.rmSync(DRAFT_PATH, { force: true });
});

test("getAllSlugs › excludes draft posts", () => {
  expect(getAllSlugs()).not.toContain(DRAFT_SLUG);
});

test("getAllPostMetas › excludes draft posts", () => {
  const slugs = getAllPostMetas().map((post) => post.slug);
  expect(slugs).not.toContain(DRAFT_SLUG);
});

test("getPost › throws for a draft post instead of returning unpublished content", () => {
  expect(() => getPost(DRAFT_SLUG)).toThrow();
});

test("getAllPostMetas › every listed post has a publishedAt that parses to a valid date", () => {
  for (const post of getAllPostMetas()) {
    expect(Number.isNaN(new Date(post.publishedAt).getTime())).toBe(false);
  }
});
