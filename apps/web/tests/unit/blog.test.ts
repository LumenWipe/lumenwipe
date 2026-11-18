import { test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import fs from "fs";
import readingTime from "reading-time";
import { BLOG } from "@/lib/i18n/messages/blog";
import path from "path";
import {
  getAllPostMetas,
  getAllSlugs,
  minutesToRead,
  getPost,
  parseFrontMatter,
  PostNotFoundError,
  relatedPosts,
  resolveUpdatedAt,
  type PostMeta,
} from "@/lib/blog";

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

test("getAllPostMetas › posts of the same day keep one order whatever order the directory lists them in", () => {
  const listed = getAllPostMetas().map((post) => post.slug);
  const readdir = fs.readdirSync.bind(fs);
  const spy = spyOn(fs, "readdirSync").mockImplementation(((dir: fs.PathLike) =>
    (readdir(dir) as string[]).reverse()) as typeof fs.readdirSync);
  try {
    expect(getAllPostMetas().map((post) => post.slug)).toEqual(listed);
  } finally {
    spy.mockRestore();
  }
  const sameDay = getAllPostMetas().filter((post, i, all) =>
    all.some((other, j) => j !== i && other.publishedAt === post.publishedAt)
  );
  expect(sameDay.length).toBeGreaterThan(1);
  for (let i = 1; i < sameDay.length; i++) {
    if (sameDay[i].publishedAt === sameDay[i - 1].publishedAt) {
      expect(sameDay[i - 1].slug < sameDay[i].slug).toBe(true);
    }
  }
});

test("getPost › throws for a draft post instead of returning unpublished content", () => {
  expect(() => getPost(DRAFT_SLUG)).toThrow();
});

test("getAllPostMetas › every listed post has a publishedAt that parses to a valid date", () => {
  for (const post of getAllPostMetas()) {
    expect(Number.isNaN(new Date(post.publishedAt).getTime())).toBe(false);
  }
});

test("minutesToRead › renders as reading-time's own text, for every published post and a few lengths", () => {
  const texts = [
    "",
    "word ".repeat(1),
    "word ".repeat(200),
    "word ".repeat(201),
    "word ".repeat(1999),
    ...getAllSlugs().map((slug) => getPost(slug).content),
  ];
  for (const text of texts) {
    expect(BLOG.en.readingTime(minutesToRead(text))).toBe(readingTime(text).text);
  }
  for (const post of getAllPostMetas()) {
    expect(post.readingMinutes).toBe(minutesToRead(getPost(post.slug).content));
  }
});

test("resolveUpdatedAt › a post never edited after publishing is last modified when published", () => {
  expect(resolveUpdatedAt("p", "2026-06-02", undefined)).toBe("2026-06-02");
});

test("resolveUpdatedAt › an edit date on or after publishing is the last modification", () => {
  expect(resolveUpdatedAt("p", "2026-06-02", "2026-06-02")).toBe("2026-06-02");
  expect(resolveUpdatedAt("p", "2026-06-02", "2026-11-10")).toBe("2026-11-10");
});

test("resolveUpdatedAt › refuses an edit date before publishing or not written as YYYY-MM-DD", () => {
  for (const bad of [
    "2026-06-01",
    "June 3, 2026",
    "2026-6-3",
    "2026-06-31",
    new Date("2026-11-10"),
    20261110,
  ]) {
    expect(() => resolveUpdatedAt("p", "2026-06-02", bad)).toThrow(
      'Post "p" has an invalid updatedAt'
    );
  }
});

test("getAllPostMetas › every post's updatedAt is a date no earlier than its publishedAt", () => {
  for (const post of getAllPostMetas()) {
    expect(post.updatedAt >= post.publishedAt).toBe(true);
    expect(getPost(post.slug).updatedAt).toBe(post.updatedAt);
  }
});

const VALID = {
  title: "A post",
  description: "What it says.",
  publishedAt: "2026-06-02",
  category: "Guides" as const,
  tags: ["stellar"],
};

test("parseFrontMatter › accepts a complete front matter and defaults updatedAt to publishedAt", () => {
  expect(parseFrontMatter("p", { ...VALID, cta: "Try it." })).toEqual({
    ...VALID,
    updatedAt: "2026-06-02",
    cta: "Try it.",
  });
});

test("parseFrontMatter › refuses an unknown category instead of rendering an empty badge", () => {
  expect(() => parseFrontMatter("p", { ...VALID, category: "Guide" })).toThrow(
    /Post "p" has invalid front matter:[\s\S]*category/
  );
});

test("parseFrontMatter › refuses a missing or blank description", () => {
  const { description: _description, ...rest } = VALID;
  expect(() => parseFrontMatter("p", rest)).toThrow(/description/);
  expect(() => parseFrontMatter("p", { ...VALID, description: "  " })).toThrow(/description/);
});

test("parseFrontMatter › refuses a publishedAt that is not a real YYYY-MM-DD date", () => {
  for (const bad of ["2026-02-30", "2026-6-2", "June 2, 2026", new Date("2026-06-02")]) {
    expect(() => parseFrontMatter("p", { ...VALID, publishedAt: bad })).toThrow(/publishedAt/);
  }
});

test("parseFrontMatter › refuses an unknown key, so a misspelled field fails", () => {
  expect(() => parseFrontMatter("p", { ...VALID, updateAt: "2026-07-01" })).toThrow(/updateAt/);
});

test("parseFrontMatter › refuses missing, empty or non-string tags", () => {
  const { tags: _tags, ...rest } = VALID;
  for (const data of [
    rest,
    { ...VALID, tags: [] },
    { ...VALID, tags: "stellar" },
    { ...VALID, tags: [""] },
  ]) {
    expect(() => parseFrontMatter("p", data)).toThrow(/tags/);
  }
});

test("parseFrontMatter › still applies the updatedAt rule", () => {
  expect(() => parseFrontMatter("p", { ...VALID, updatedAt: "2026-06-01" })).toThrow(
    'Post "p" has an invalid updatedAt'
  );
});

test("getAllPostMetas › a published post with a bad category fails with a readable message", () => {
  const slug = "test-invalid-fixture";
  const file = path.join(CONTENT_DIR, `${slug}.mdx`);
  fs.writeFileSync(
    file,
    `---\ntitle: "Invalid"\ndescription: "Used only by blog.test.ts."\npublishedAt: "2026-06-02"\ncategory: "Guide"\ntags: ["fixture"]\n---\n\nBody.\n`
  );
  try {
    expect(() => getAllPostMetas()).toThrow(`Post "${slug}" has invalid front matter`);
    expect(() => getAllSlugs()).toThrow(`Post "${slug}" has invalid front matter`);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("getPost › a slug with no published post is not found, and is never read as a path", () => {
  for (const slug of ["no-such-post", "../blog/phase-0-launch", DRAFT_SLUG]) {
    expect(() => getPost(slug)).toThrow(PostNotFoundError);
  }
});

function meta(slug: string, tags: string[], publishedAt = "2026-06-02"): PostMeta {
  return {
    slug,
    title: slug,
    description: slug,
    publishedAt,
    updatedAt: publishedAt,
    category: "Guides",
    tags,
    readingMinutes: 1,
  };
}

test("relatedPosts › ranks by shared tags, then newest, and leaves out the post and unrelated ones", () => {
  const post = meta("self", ["a", "b"]);
  const all = [
    post,
    meta("one-tag-old", ["a"], "2026-01-01"),
    meta("two-tags", ["a", "b"], "2026-01-01"),
    meta("one-tag-new", ["b"], "2026-05-01"),
    meta("unrelated", ["c"], "2026-09-01"),
  ];
  expect(relatedPosts(post, all).map((p) => p.slug)).toEqual([
    "two-tags",
    "one-tag-new",
    "one-tag-old",
  ]);
  expect(relatedPosts(post, all, 2).map((p) => p.slug)).toEqual(["two-tags", "one-tag-new"]);
  expect(relatedPosts(meta("lonely", ["z"]), all)).toEqual([]);
});
