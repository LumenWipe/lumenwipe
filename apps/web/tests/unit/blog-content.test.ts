import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { getAllPostMetas, getPost } from "@/lib/blog";
import { INDEXED_PAGES } from "@/lib/site/pages";
import { contentStatusRows } from "@/lib/site/content-status";

const APP_ROUTES = ["/mainnet/analyze", "/mainnet/review", "/mainnet/allowances"];
const EM_DASH = String.fromCharCode(0x2014);
const posts = getAllPostMetas().map((meta) => getPost(meta.slug));

/** Every site-relative link target in an MDX body, without its fragment. */
function internalLinks(content: string): string[] {
  const targets = [
    ...[...content.matchAll(/\]\((\/[^)\s]*)\)/g)].map((m) => m[1]!),
    ...[...content.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]!),
  ];
  return targets.map((t) => t.split("#")[0]!);
}

/** The internal links in `content` that lead to no page of the site. */
function brokenLinks(content: string, slugs: readonly string[]): string[] {
  const known = new Set([
    ...INDEXED_PAGES.map((p) => p.path),
    ...APP_ROUTES,
    ...slugs.map((s) => `/blog/${s}`),
  ]);
  return internalLinks(content).filter((link) => !known.has(link));
}

describe("blog content", () => {
  test("finds a broken link, an unknown route and a missing post", () => {
    expect(
      brokenLinks('[a](/mainnet) [b](/public) [c](/blog/gone#x) <a href="/faq">d</a>', ["here"])
    ).toEqual(["/public", "/blog/gone"]);
  });

  test("every internal link in every post leads to a page of the site", () => {
    const slugs = posts.map((p) => p.slug);
    const broken = posts.flatMap((p) =>
      brokenLinks(p.content, slugs).map((l) => `${p.slug}: ${l}`)
    );
    expect(broken).toEqual([]);
  });

  test("no post uses an em dash", () => {
    const found = posts.filter((p) =>
      [p.title, p.description, p.cta ?? "", p.content].join("\n").includes(EM_DASH)
    );
    expect(found.map((p) => p.slug)).toEqual([]);
  });

  test("no planned article is already published", () => {
    expect(() => contentStatusRows(getAllPostMetas())).not.toThrow();
  });
});
