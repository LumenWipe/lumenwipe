import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Metadata } from "next";
import sitemap from "@/app/sitemap";
import robots from "@/app/robots";
import { rootMetadata as rootMetadataFor } from "@/lib/site/root-metadata";
import { getAllPostMetas, getPost } from "@/lib/blog";
import { LOCALE_TAGS } from "@/lib/i18n/locale";
import {
  HOME_TITLE,
  INDEXED_PAGES,
  languageAlternate,
  languageAlternates,
  localePath,
  NOINDEX_PAGES,
  postShareImage,
  SHARE_IMAGE,
  SITE_NAME,
  SPANISH_PAGES,
  spanishIndexedPages,
} from "@/lib/site/pages";
import { siteOrigin, siteUrl } from "@/lib/site/url";

const APP = join(import.meta.dir, "..", "..", "app");
const MARKETING = join(APP, "(marketing)");
const MARKETING_ES = join(APP, "(marketing-es)");
// The API keys page is public too, but signs in with a wallet, so it renders under the nonce policy
// of the (app) group.
const API_KEYS = join(APP, "(app)", "api-keys");

/** Every page file under a marketing route group, as its route path and directory. */
function marketingRoutes(root: string, dir = root): { route: string; dir: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return marketingRoutes(root, path);
    if (entry.name !== "page.tsx") return [];
    const route = relative(root, dir).split(sep).filter(Boolean).join("/");
    return [{ route: `/${route}`, dir }];
  });
}

interface Page {
  route: string;
  /** The page's own segment directory, for file-based share images. */
  dir: string;
  metadata: Metadata;
  expectedTitle: Metadata["title"];
}

async function resolvePages(): Promise<Page[]> {
  const pages: Page[] = [];
  for (const { route, dir } of [
    ...marketingRoutes(MARKETING),
    ...marketingRoutes(MARKETING_ES),
    { route: "/api-keys", dir: API_KEYS },
  ]) {
    const mod = await import(join(dir, "page.tsx"));
    if (route === "/blog/[slug]") {
      for (const post of getAllPostMetas()) {
        const metadata: Metadata = await mod.generateMetadata({
          params: Promise.resolve({ slug: post.slug }),
        });
        pages.push({ route: `/blog/${post.slug}`, dir, metadata, expectedTitle: post.title });
      }
    } else {
      pages.push({ route, dir, metadata: mod.metadata, expectedTitle: undefined });
    }
  }
  return pages;
}

const PAGES = await resolvePages();

const routeLocale = (route: string) => (route === "/es" || route.startsWith("/es/") ? "es" : "en");
const SITEMAP = sitemap();
const SITEMAP_URLS = SITEMAP.map((entry) => entry.url);

/** Every static page title is the page name only: the root template adds the brand. */
const PAGE_TITLES: Record<string, Metadata["title"]> = {
  "/": { absolute: HOME_TITLE },
  "/api-keys": "API keys",
  "/blog": "Blog",
  "/content": "Content",
  "/es": { absolute: HOME_TITLE },
  "/faq": "FAQ",
  "/how-it-works": "How it works",
  "/playground": "Playground",
  "/registry": "Exchange registry",
  "/security": "Security",
  "/stats": "Stats",
};

describe("every public page under app/(marketing) and app/(marketing-es), and /api-keys", () => {
  test("is found, including every published post", () => {
    expect(PAGES.map((p) => p.route).sort()).toEqual(
      [...Object.keys(PAGE_TITLES), ...getAllPostMetas().map((p) => `/blog/${p.slug}`)].sort()
    );
  });

  for (const page of PAGES) {
    describe(page.route, () => {
      test("is in the sitemap, or marked noindex and left out", () => {
        const listed = SITEMAP_URLS.includes(siteUrl(page.route));
        expect(listed).toBe(!NOINDEX_PAGES.includes(page.route));
      });

      test("declares its own canonical URL, for Open Graph too", () => {
        expect(page.metadata.alternates?.canonical).toBe(siteUrl(page.route));
        expect(page.metadata.openGraph?.url).toBe(siteUrl(page.route));
      });

      test("has a share image for Open Graph and X", () => {
        const post = page.route.startsWith("/blog/") ? getPost(page.route.slice(6)) : null;
        const image = post ? postShareImage(post.slug, post.title) : SHARE_IMAGE;
        expect(page.metadata.openGraph?.images).toEqual([image]);
        expect(page.metadata.twitter?.images).toEqual([image]);
        expect(page.metadata.twitter).toMatchObject({ card: "summary_large_image" });
        if (post) expect(existsSync(join(page.dir, "share.png", "route.tsx"))).toBe(true);
      });

      test("is titled by the page name only, the brand added once by the root template", () => {
        const expected = page.expectedTitle ?? PAGE_TITLES[page.route];
        expect(page.metadata.title).toEqual(expected);
        if (typeof expected === "string" && !page.route.startsWith("/blog/")) {
          expect(expected).not.toContain(SITE_NAME);
        }
        const shared =
          typeof expected === "object" ? HOME_TITLE : `${String(expected)} | ${SITE_NAME}`;
        expect(page.metadata.openGraph?.title).toBe(shared);
        expect(page.metadata.twitter?.title).toBe(shared);
      });

      test("shares in its own locale", () => {
        expect(page.metadata.openGraph).toMatchObject({
          locale: LOCALE_TAGS[routeLocale(page.route)].openGraph,
        });
      });

      test("names its other language only as a translated pair", () => {
        const locale = routeLocale(page.route);
        const other = languageAlternate(locale, page.route);
        expect(page.metadata.alternates?.languages).toEqual(
          languageAlternates(locale, page.route) ?? undefined
        );
        expect(page.metadata.openGraph?.alternateLocale).toEqual(
          other ? [LOCALE_TAGS[other.locale].openGraph] : undefined
        );
      });

      test(`is ${NOINDEX_PAGES.includes(page.route) ? "" : "not "}marked noindex`, () => {
        if (NOINDEX_PAGES.includes(page.route)) {
          expect(page.metadata.robots).toEqual({ index: false, follow: true });
        } else {
          expect(page.metadata.robots).toBeUndefined();
        }
      });
    });
  }

  test("/api-keys and the untranslated Spanish landing are the only pages marked noindex", () => {
    expect(NOINDEX_PAGES).toEqual(["/api-keys", "/es"]);
    expect(
      PAGES.filter((p) => p.metadata.robots !== undefined)
        .map((p) => p.route)
        .sort()
    ).toEqual(["/api-keys", "/es"]);
  });

  test("each root layout declares no page URL and no robots rule, and shares in its locale", () => {
    for (const locale of ["en", "es"] as const) {
      const rootMetadata = rootMetadataFor(locale);
      expect(rootMetadata.openGraph).not.toHaveProperty("url");
      expect(rootMetadata.openGraph).toMatchObject({ locale: LOCALE_TAGS[locale].openGraph });
      expect(rootMetadata.robots).toBeUndefined();
      expect(rootMetadata.openGraph?.images).toEqual([SHARE_IMAGE]);
      expect(rootMetadata.twitter?.images).toEqual([SHARE_IMAGE]);
      expect(String(rootMetadata.metadataBase)).toBe(siteUrl("/"));
    }
  });

  test("the share image is generated from the root segment", () => {
    expect(existsSync(join(MARKETING, "..", "opengraph-image.tsx"))).toBe(true);
  });
});

describe("the Spanish pages", () => {
  const TRANSLATED = [{ path: "/", translated: true }];

  test("each one is a page under app/(marketing-es) with an English page in the sitemap", () => {
    const spanishRoutes = marketingRoutes(MARKETING_ES).map((p) => p.route);
    expect(SPANISH_PAGES.map((p) => localePath("es", p.path)).sort()).toEqual(spanishRoutes.sort());
    for (const page of SPANISH_PAGES) {
      expect(INDEXED_PAGES.map((p) => p.path)).toContain(page.path);
    }
  });

  test("an untranslated one is noindex and out of the sitemap", () => {
    for (const page of SPANISH_PAGES.filter((p) => !p.translated)) {
      const path = localePath("es", page.path);
      expect(NOINDEX_PAGES).toContain(path);
      expect(SITEMAP_URLS).not.toContain(siteUrl(path));
    }
  });

  test("a translated one joins the sitemap with its English page's rank", () => {
    expect(spanishIndexedPages(TRANSLATED)).toEqual([
      { ...INDEXED_PAGES.find((p) => p.path === "/")!, path: "/es" },
    ]);
    expect(spanishIndexedPages([{ path: "/", translated: false }])).toEqual([]);
  });

  test("the Spanish root layout renders its document and frame in Spanish", () => {
    const source = readFileSync(join(MARKETING_ES, "layout.tsx"), "utf8");
    expect(source).toContain('<RootDocument locale="es">');
    expect(source).toContain('<MarketingShell locale="es">');
    expect(source).toContain('rootMetadata("es")');
    expect(LOCALE_TAGS.es).toEqual({
      html: "es-419",
      intl: "es-419",
      openGraph: "es_LA",
      hreflang: "es",
    });
  });
});

describe("the sitemap", () => {
  test("lists the home page first with the top priority, and every URL once on the site origin", () => {
    expect(SITEMAP[0]).toMatchObject({ url: siteUrl("/"), priority: 1 });
    for (const entry of SITEMAP.slice(1)) expect(entry.priority!).toBeLessThan(1);
    expect(new Set(SITEMAP_URLS).size).toBe(SITEMAP_URLS.length);
    for (const url of SITEMAP_URLS) expect(new URL(url).origin).toBe(siteOrigin());
  });

  test("ranks the app entry below the pages that explain it and leaves testnet out", () => {
    const priority = (path: string) => SITEMAP.find((e) => e.url === siteUrl(path))?.priority;
    expect(priority("/mainnet")!).toBeLessThan(priority("/how-it-works")!);
    expect(SITEMAP_URLS).not.toContain(siteUrl("/testnet"));
    expect(INDEXED_PAGES.map((p) => p.path)).not.toContain("/testnet");
  });

  test("dates each post by its last content change", () => {
    for (const post of getAllPostMetas()) {
      const entry = SITEMAP.find((e) => e.url === siteUrl(`/blog/${post.slug}`));
      expect(entry?.lastModified).toEqual(new Date(getPost(post.slug).updatedAt));
    }
  });

  test("dates a post edited after publishing by its updatedAt", () => {
    const slug = "test-updated-fixture";
    const file = join(MARKETING, "..", "..", "content", "blog", `${slug}.mdx`);
    writeFileSync(
      file,
      `---\ntitle: "Updated fixture"\ndescription: "Used only by seo-routes.test.ts."\npublishedAt: "2026-01-02"\nupdatedAt: "2026-03-04"\ncategory: "Updates"\ntags: ["fixture"]\n---\n\nBody.\n`
    );
    try {
      const entry = sitemap().find((e) => e.url === siteUrl(`/blog/${slug}`));
      expect(entry?.lastModified).toEqual(new Date("2026-03-04"));
    } finally {
      rmSync(file, { force: true });
    }
  });

  test("lists the hreflang set of each translated pair, and of nothing else", () => {
    for (const entry of SITEMAP) {
      const path = new URL(entry.url).pathname;
      expect(entry.alternates?.languages).toEqual(
        languageAlternates(routeLocale(path), path) ?? undefined
      );
    }
  });

  test("is linked from robots.txt", () => {
    expect(robots().sitemap).toBe(siteUrl("/sitemap.xml"));
  });
});

describe("siteOrigin", () => {
  const saved = process.env.NEXT_PUBLIC_APP_URL;
  const withUrl = (value: string | undefined, run: () => void) => {
    if (value === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = value;
    try {
      run();
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = saved;
    }
  };

  test("is the configured origin, as it is, without a trailing slash or path", () => {
    withUrl("https://lumenwipe.com/", () => {
      expect(siteOrigin()).toBe("https://lumenwipe.com");
      expect(siteUrl("/faq")).toBe("https://lumenwipe.com/faq");
    });
  });

  test("is never empty when the variable is unset, blank or unparseable", () => {
    for (const value of [undefined, "", "  ", "not a url"]) {
      withUrl(value, () => expect(siteOrigin()).toBe("https://www.lumenwipe.com"));
    }
  });
});
