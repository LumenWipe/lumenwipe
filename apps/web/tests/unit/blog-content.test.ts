import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { getAllPostMetas, getPost } from "@/lib/blog";
import { INDEXED_PAGES, localePath } from "@/lib/site/pages";
import { spanishPages } from "@/lib/site/spanish-pages";
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
 *  as available, in English or, with `word` "Disponible", in Spanish. */
function availableButNotLive(content: string, word = "Available"): string[] {
  const notLive = [
    ...FEATURES.filter((f) => f.status !== "live").flatMap((f) => [f.title, f.noun]),
    ...PROTOCOLS.filter((p) => p.status !== "live").map((p) => p.name),
  ].map((name) => name.toLowerCase());
  return content
    .split("\n")
    .filter((line) => /^\|.*\|\s*$/.test(line) && new RegExp(`\\b${word}\\b`, "i").test(line))
    .filter((line) => notLive.some((name) => line.toLowerCase().includes(name)));
}

const NEGATION = {
  en: /\b(not|other than|except)\b/i,
  es: /(?<!\p{L})(no|salvo|excepto|distint[oa]s?)(?!\p{L})/iu,
};

/** The sentences and table rows in `content` that tie signers to op_has_sub_entries without saying
 *  they are left out of it. */
function signerSubEntryClaims(content: string, negation: RegExp = NEGATION.en): string[] {
  return content
    .split(/(?<=[.!?])\s+|\n/)
    .filter((part) => /has_sub_entries/i.test(part) && /\b(signers?|firmantes?)\b/i.test(part))
    .filter((part) => !negation.test(part));
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

  test("flags a sentence or table row that blames signers for op_has_sub_entries", () => {
    expect(
      signerSubEntryClaims(
        "| `ACCOUNT_MERGE_HAS_SUB_ENTRIES` | Trustlines, offers, data entries, or signers still exist |"
      )
    ).toHaveLength(1);
    expect(
      signerSubEntryClaims(
        "The merge fails with a result code such as `op_has_sub_entries` that says nothing about signers."
      )
    ).toHaveLength(1);
    expect(
      signerSubEntryClaims(
        "`op_has_sub_entries` means something other than a signer is still on the account."
      )
    ).toEqual([]);
  });

  test("no post blames signers for op_has_sub_entries, which the merge does not count them toward", () => {
    const found = posts.flatMap((p) =>
      signerSubEntryClaims(p.content).map((claim) => `${p.slug}: ${claim}`)
    );
    expect(found).toEqual([]);
  });

  test("no planned article is already published", () => {
    expect(() => contentStatusRows(getAllPostMetas())).not.toThrow();
  });
});

const translations = getAllPostMetas("es").map((meta) => ({
  es: getPost(meta.slug, "es"),
  en: getPost(meta.slug),
}));
const SPANISH = new Set(spanishPages().map((p) => localePath("es", p.path)));

/** The internal links in a Spanish post that break the language rule: a link to a page with a
 *  Spanish version must lead to it, and a link under /es must lead to a Spanish page. */
function misdirectedLinks(content: string, spanish: ReadonlySet<string>): string[] {
  return internalLinks(content).filter((link) =>
    link === "/es" || link.startsWith("/es/")
      ? !spanish.has(link)
      : spanish.has(localePath("es", link))
  );
}

/** What a translation must keep from its English post: the structure, the code it names, the
 *  shared reserve figures, its links out of the blog and the actions it leads to. */
function shape(content: string) {
  const count = (re: RegExp) => (content.match(re) ?? []).length;
  return {
    h2: count(/^## /gm),
    h3: count(/^### /gm),
    numbered: count(/^\d+\. /gm),
    bullets: count(/^- /gm),
    tableRows: count(/^\|.*\|\s*$/gm),
    code: [...content.matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort(),
    components: [...content.matchAll(/<([A-Z]\w*)/g)].map((m) => m[1]).sort(),
    external: [...content.matchAll(/\]\((https?:[^)\s]+)\)/g)].map((m) => m[1]).sort(),
    app: internalLinks(content)
      .filter((l) => l.startsWith("/mainnet"))
      .sort(),
  };
}

describe("translated posts", () => {
  test("there is at least one, each under its English post's slug", () => {
    expect(translations.length).toBeGreaterThan(0);
  });

  test("every blocker article has its Spanish version", () => {
    const blockers = posts.filter((p) => p.tags.includes("account-blockers")).map((p) => p.slug);
    expect(blockers).toHaveLength(5);
    expect(
      translations
        .map(({ es }) => es.slug)
        .filter((slug) => blockers.includes(slug))
        .sort()
    ).toEqual([...blockers].sort());
  });

  test("flags a link to the English version of a translated page, and an /es link to none", () => {
    const spanish = new Set(["/es", "/es/faq", "/es/blog/x"]);
    expect(
      misdirectedLinks(
        "[a](/faq) [b](/es/faq) [c](/blog/x) [d](/blog/y) [e](/es/blog/y) [f](/es)",
        spanish
      )
    ).toEqual(["/faq", "/blog/x", "/es/blog/y"]);
  });

  for (const { es, en } of translations) {
    describe(es.slug, () => {
      test("keeps the English post's structure, code, reserve figures, external links and actions", () => {
        expect(shape(es.content)).toEqual(shape(en.content));
      });

      test("keeps its category and has its own lead when the English post has one", () => {
        expect(es.category).toBe(en.category);
        expect(es.cta === undefined).toBe(en.cta === undefined);
      });

      test("links to the Spanish version of every page that has one, and to Spanish pages that exist", () => {
        expect(misdirectedLinks(es.content, SPANISH)).toEqual([]);
        const english = new Set([
          ...INDEXED_PAGES.map((p) => p.path),
          ...APP_ROUTES,
          ...getAllPostMetas().map((p) => `/blog/${p.slug}`),
        ]);
        const broken = internalLinks(es.content).filter(
          (link) => !SPANISH.has(link) && !english.has(link)
        );
        expect(broken).toEqual([]);
      });

      test("links to the Spanish entry points", () => {
        const links = new Set(internalLinks(es.content));
        for (const entry of ["/es", "/es/faq"]) expect(links.has(entry)).toBe(true);
      });

      test("links to the posts its English post links to, in either language", () => {
        const posts = (content: string) =>
          internalLinks(content)
            .map((l) => /^(?:\/es)?\/blog\/([^/]+)$/.exec(l)?.[1])
            .filter(Boolean)
            .sort();
        expect(posts(es.content)).toEqual(posts(en.content));
      });

      test("passes the English post's guards, in Spanish", () => {
        expect(availableButNotLive(es.content, "Disponible")).toEqual([]);
        expect(signerSubEntryClaims(es.content, NEGATION.es)).toEqual([]);
        expect([es.title, es.description, es.cta ?? "", es.content].join("\n")).not.toContain(
          EM_DASH
        );
        expect(/\d+([.,]\d+)?\s*XLM/.test(es.content)).toBe(false);
      });
    });
  }

  test("the Spanish guards flag what the English ones flag", () => {
    expect(
      availableButNotLive("| Sponsored fees (fee-bump) | ✓ Disponible |", "Disponible")
    ).toHaveLength(1);
    expect(
      signerSubEntryClaims(
        "`op_has_sub_entries` significa que quedan firmantes en la cuenta.",
        NEGATION.es
      )
    ).toHaveLength(1);
    expect(
      signerSubEntryClaims(
        "`op_has_sub_entries` no cuenta a los signers de la cuenta.",
        NEGATION.es
      )
    ).toEqual([]);
  });
});
