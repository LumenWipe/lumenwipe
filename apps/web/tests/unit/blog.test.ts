import { test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import fs from "fs";
import readingTime from "reading-time";
import { BLOG } from "@/lib/i18n/messages/blog";
import path from "path";
import {
  extractToc,
  getAllPostMetas,
  getAllSlugs,
  minutesToRead,
  getPost,
  parseFrontMatter,
  PostNotFoundError,
  postSlug,
  relatedPosts,
  resolveUpdatedAt,
  slugify,
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

const SPANISH_DIR = path.join(CONTENT_DIR, "es");
const TRANSLATED = "how-do-i-remove-a-trustline-on-stellar";

test("getAllPostMetas › a locale reads only its own folder, and English leaves the translations out", () => {
  const english = getAllSlugs();
  const spanish = getAllSlugs("es");
  expect(spanish).toContain(TRANSLATED);
  expect(english).not.toContain("es");
  const files = fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".mdx"));
  expect(english.length).toBe(files.filter((f) => f !== `${DRAFT_SLUG}.mdx`).length);
  expect(getAllPostMetas("es").map((p) => p.slug)).toEqual([...spanish].sort());
  expect(getPost(TRANSLATED, "es").title).not.toBe(getPost(TRANSLATED).title);
});

test("getAllSlugs › lists a locale's slugs in one order whatever order the directory lists them in", () => {
  const listed = { en: getAllSlugs(), es: getAllSlugs("es") };
  const readdir = fs.readdirSync.bind(fs);
  const spy = spyOn(fs, "readdirSync").mockImplementation(((dir: fs.PathLike) =>
    (readdir(dir) as string[]).reverse()) as typeof fs.readdirSync);
  try {
    expect({ en: getAllSlugs(), es: getAllSlugs("es") }).toEqual(listed);
  } finally {
    spy.mockRestore();
  }
  expect(listed.en).toEqual([...listed.en].sort());
});

test("getPost › a post missing in a locale is not found there", () => {
  expect(() => getPost("phase-0-launch", "es")).toThrow(PostNotFoundError);
  expect(() => getPost("../how-do-i-remove-a-trustline-on-stellar", "es")).toThrow(
    PostNotFoundError
  );
});

test("getAllPostMetas › a translation with no published English post fails the build by name", () => {
  const slug = "test-orphan-fixture";
  const file = path.join(SPANISH_DIR, `${slug}.mdx`);
  fs.writeFileSync(
    file,
    `---\ntitle: "Huérfano"\ndescription: "Solo para blog.test.ts."\npublishedAt: "2026-06-02"\ncategory: "Guides"\ntags: ["fixture"]\n---\n\nCuerpo.\n`
  );
  try {
    expect(() => getAllPostMetas("es")).toThrow(`Post "es/${slug}" has no published English post`);
    expect(() => getAllSlugs("es")).toThrow(`Post "es/${slug}" has no published English post`);
    expect(getAllSlugs()).not.toContain(slug);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("getAllPostMetas › a translation's front matter is validated and named with its locale", () => {
  const file = path.join(SPANISH_DIR, "phase-0-launch.mdx");
  fs.writeFileSync(
    file,
    `---\ntitle: "Inválido"\ndescription: "Solo para blog.test.ts."\npublishedAt: "2026-06-02"\ncategory: "Guía"\ntags: ["fixture"]\n---\n\nCuerpo.\n`
  );
  try {
    expect(() => getAllPostMetas("es")).toThrow(
      'Post "es/phase-0-launch" has invalid front matter'
    );
  } finally {
    fs.rmSync(file, { force: true });
  }
});

// The anchor every heading had before slugify learned accents: letters and digits of the ASCII
// lowercase text, the rest dropped.
function asciiSlugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

test("slugify › keeps an accented letter as its base letter, so a Spanish heading reads in its anchor", () => {
  expect(slugify("¿Qué es una trustline?")).toBe("que-es-una-trustline");
  expect(slugify("Por qué una trustline impide el merge")).toBe(
    "por-que-una-trustline-impide-el-merge"
  );
  expect(slugify("Añadir una señal, ¡ya!")).toBe("anadir-una-senal-ya");
  expect(slugify("Cómo lo resuelve LumenWipe")).toBe("como-lo-resuelve-lumenwipe");
});

test("slugify › leaves every English heading's anchor as it was", () => {
  const headings = getAllSlugs().flatMap((slug) =>
    (getPost(slug).content.match(/^#{2,3}\s+.+/gm) ?? []).map((h) => h.replace(/^#+\s+/, ""))
  );
  expect(headings.length).toBeGreaterThan(20);
  for (const heading of headings) expect(slugify(heading)).toBe(asciiSlugify(heading));
  expect(extractToc(getPost(TRANSLATED).content).map((e) => e.id)).toEqual([
    "what-a-trustline-is",
    "why-a-trustline-stops-the-merge",
    "what-to-do-with-the-balance",
    "how-lumenwipe-handles-it",
    "doing-it-by-hand",
    "start-a-close",
  ]);
});

test("extractToc › every translated post's anchors are unique ASCII", () => {
  for (const slug of getAllSlugs("es")) {
    const ids = extractToc(getPost(slug, "es").content).map((e) => e.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  }
});

test("postSlug › takes a post's slug from its file name, lowercase words joined by single hyphens", () => {
  expect(postSlug("how-do-i-remove-a-trustline-on-stellar.mdx")).toBe(
    "how-do-i-remove-a-trustline-on-stellar"
  );
  expect(postSlug("phase-0-launch.mdx", "es")).toBe("phase-0-launch");
  for (const file of [
    "Bad-Name.mdx",
    "bad_name.mdx",
    "bad--name.mdx",
    "-bad.mdx",
    "bad-.mdx",
    "qué.mdx",
    'x"><script>.mdx',
    "javascript:alert(1).mdx",
    ".mdx",
  ]) {
    expect(() => postSlug(file)).toThrow(`Post file "${file}" has an invalid name`);
  }
  expect(() => postSlug("Bad.mdx", "es")).toThrow('Post file "es/Bad.mdx" has an invalid name');
});

test("getAllPostMetas › a post file with an invalid name fails the build by name, in either locale", () => {
  const front = `---\ntitle: "Bad"\ndescription: "Used only by blog.test.ts."\npublishedAt: "2026-06-02"\ncategory: "Guides"\ntags: ["fixture"]\n---\n\nBody.\n`;
  for (const [dir, locale, name] of [
    [CONTENT_DIR, "en", "Test_Bad Name.mdx"],
    [SPANISH_DIR, "es", "es/Test_Bad Name.mdx"],
  ] as const) {
    const file = path.join(dir, "Test_Bad Name.mdx");
    fs.writeFileSync(file, front);
    try {
      expect(() => getAllPostMetas(locale)).toThrow(`Post file "${name}" has an invalid name`);
      expect(() => getAllSlugs(locale)).toThrow(`Post file "${name}" has an invalid name`);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
});
