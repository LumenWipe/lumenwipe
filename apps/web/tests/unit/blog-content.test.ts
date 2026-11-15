import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { getAllPostMetas, getPost } from "@/lib/blog";
import { INDEXED_PAGES } from "@/lib/site/pages";
import { contentStatusRows } from "@/lib/site/content-status";
import { FEATURES, PROTOCOLS } from "@/lib/site/status";

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

/** The table rows in `content` that mark something the status registry does not list as live
 *  as available. */
function availableButNotLive(content: string): string[] {
  const notLive = [
    ...FEATURES.filter((f) => f.status !== "live").flatMap((f) => [f.title, f.noun]),
    ...PROTOCOLS.filter((p) => p.status !== "live").map((p) => p.name),
  ].map((name) => name.toLowerCase());
  return content
    .split("\n")
    .filter((line) => /^\|.*\|\s*$/.test(line) && /\bAvailable\b/.test(line))
    .filter((line) => notLive.some((name) => line.toLowerCase().includes(name)));
}

describe("blog content", () => {
  test("flags a row marking a testnet-only feature as available", () => {
    expect(availableButNotLive("| Sponsored fees (fee-bump) | ✓ Available |")).toHaveLength(1);
    expect(availableButNotLive("| Sponsored fees (fee-bump) | Testnet only |")).toEqual([]);
    expect(availableButNotLive("| Account merge | ✓ Available |")).toEqual([]);
  });

  test("no post marks a feature or protocol that is not live as available", () => {
    const found = posts.flatMap((p) =>
      availableButNotLive(p.content).map((l) => `${p.slug}: ${l}`)
    );
    expect(found).toEqual([]);
  });

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

  test("each blocker article links to the other four and ends on the account entry page", () => {
    const blockers = posts.filter((p) => p.tags.includes("account-blockers"));
    expect(blockers).toHaveLength(5);
    for (const post of blockers) {
      const links = new Set(internalLinks(post.content));
      const missing = blockers
        .filter((other) => other.slug !== post.slug && !links.has(`/blog/${other.slug}`))
        .map((other) => other.slug);
      expect({ post: post.slug, missing }).toEqual({ post: post.slug, missing: [] });
      expect(links.has("/mainnet")).toBe(true);
    }
  });

  test("a blocker article states the reserve through the shared figure, never as a copied number", () => {
    for (const post of posts.filter((p) => p.tags.includes("account-blockers"))) {
      expect({ post: post.slug, copied: /\d+(\.\d+)?\s*XLM/.test(post.content) }).toEqual({
        post: post.slug,
        copied: false,
      });
    }
  });

  test("no planned article is already published", () => {
    expect(() => contentStatusRows(getAllPostMetas())).not.toThrow();
  });
});
