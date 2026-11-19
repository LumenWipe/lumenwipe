import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Metadata } from "next";
import sitemap from "@/app/sitemap";
import robots from "@/app/robots";
import { rootMetadata as rootMetadataFor } from "@/lib/site/root-metadata";
import { getAllPostMetas, getPost } from "@/lib/blog";
import { LOCALE_TAGS } from "@/lib/i18n/locale";
import { SITE } from "@/lib/i18n/messages/site";
import {
  HOME_TITLE,
  INDEXED_PAGES,
  languageAlternate,
  languageAlternates,
  localePath,
  NOINDEX_PAGES,
  postShareImage,
  shareImageFor,
  SITE_NAME,
  SPANISH_PAGES,
  spanishIndexedPages,
} from "@/lib/site/pages";
import { spanishPages } from "@/lib/site/spanish-pages";
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
    if (route.endsWith("/blog/[slug]")) {
      const locale = routeLocale(route);
      for (const post of getAllPostMetas(locale)) {
        const metadata: Metadata = await mod.generateMetadata({
          params: Promise.resolve({ slug: post.slug }),
        });
        const path = localePath(locale, `/blog/${post.slug}`);
        pages.push({ route: path, dir, metadata, expectedTitle: post.title });
      }
    } else {
      pages.push({ route, dir, metadata: mod.metadata, expectedTitle: undefined });
    }
  }
  return pages;
}

const routeLocale = (route: string) => (route === "/es" || route.startsWith("/es/") ? "es" : "en");
/** The route of a post page, `/blog/<slug>` or `/es/blog/<slug>`, as its slug. */
const postSlug = (route: string) => /^(?:\/es)?\/blog\/([^/]+)$/.exec(route)?.[1] ?? null;

const PAGES = await resolvePages();
const PAIRS = spanishPages();
const SITEMAP = sitemap();
const SITEMAP_URLS = SITEMAP.map((entry) => entry.url);

/** Every static page title is the page name only: the root template adds the brand. */
const PAGE_TITLES: Record<string, Metadata["title"]> = {
  "/": { absolute: HOME_TITLE },
  "/api-keys": "API keys",
  "/blog": "Blog",
  "/content": "Content",
  "/es": { absolute: SITE.es.metadata.homeTitle },
  "/es/faq": "Preguntas frecuentes",
  "/es/blog": "Blog",
  "/es/how-it-works": "Cómo funciona",
  "/es/security": "Seguridad",
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
      [
        ...Object.keys(PAGE_TITLES),
        ...getAllPostMetas().map((p) => `/blog/${p.slug}`),
        ...getAllPostMetas("es").map((p) => `/es/blog/${p.slug}`),
      ].sort()
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

      test("has a share image in its own locale for Open Graph and X", () => {
        const locale = routeLocale(page.route);
        const slug = postSlug(page.route);
        const post = slug ? getPost(slug, locale) : null;
        const image = post ? postShareImage(post.slug, post.title, locale) : shareImageFor(locale);
        expect(image.url.startsWith(localePath(locale, "/"))).toBe(true);
        expect(page.metadata.openGraph?.images).toEqual([image]);
        expect(page.metadata.twitter?.images).toEqual([image]);
        expect(page.metadata.twitter).toMatchObject({ card: "summary_large_image" });
        if (post) {
          const group = locale === "en" ? MARKETING : join(MARKETING_ES, "es");
          expect(existsSync(join(group, "blog", "[slug]", "share.png", "route.tsx"))).toBe(true);
        }
      });

      test("is titled by the page name only, the brand added once by the root template", () => {
        const expected = page.expectedTitle ?? PAGE_TITLES[page.route];
        expect(page.metadata.title).toEqual(expected);
        if (typeof expected === "string" && !postSlug(page.route)) {
          expect(expected).not.toContain(SITE_NAME);
        }
        const shared =
          expected && typeof expected === "object" && "absolute" in expected
            ? expected.absolute
            : `${String(expected)} | ${SITE_NAME}`;
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
        const other = languageAlternate(locale, page.route, PAIRS);
        expect(page.metadata.alternates?.languages).toEqual(
          languageAlternates(locale, page.route, PAIRS) ?? undefined
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

  test("a translated post and its English post name each other, from either side", () => {
    const slug = "how-do-i-remove-a-trustline-on-stellar";
    const pair = {
      en: siteUrl(`/blog/${slug}`),
      es: siteUrl(`/es/blog/${slug}`),
      "x-default": siteUrl(`/blog/${slug}`),
    };
    for (const route of [`/blog/${slug}`, `/es/blog/${slug}`]) {
      const page = PAGES.find((p) => p.route === route)!;
      expect(page.metadata.alternates?.languages).toEqual(pair);
    }
    const english = PAGES.find((p) => p.route === "/blog/account-merge-on-stellar")!;
    expect(english.metadata.alternates?.languages).toBeUndefined();
  });

  test("/api-keys is the only page marked noindex", () => {
    expect(NOINDEX_PAGES).toEqual(["/api-keys"]);
    expect(
      PAGES.filter((p) => p.metadata.robots !== undefined)
        .map((p) => p.route)
        .sort()
    ).toEqual(["/api-keys"]);
  });

  test("each root layout declares no page URL and no robots rule, and shares in its locale", () => {
    for (const locale of ["en", "es"] as const) {
      const rootMetadata = rootMetadataFor(locale);
      expect(rootMetadata.openGraph).not.toHaveProperty("url");
      expect(rootMetadata.openGraph).toMatchObject({ locale: LOCALE_TAGS[locale].openGraph });
      expect(rootMetadata.robots).toBeUndefined();
      expect(rootMetadata.openGraph?.images).toEqual([shareImageFor(locale)]);
      expect(rootMetadata.twitter?.images).toEqual([shareImageFor(locale)]);
      expect(String(rootMetadata.metadataBase)).toBe(siteUrl("/"));
    }
  });

  test("each locale's share image is generated at its root, with its own alt text", () => {
    expect(existsSync(join(APP, "opengraph-image.tsx"))).toBe(true);
    // Outside the route group: a metadata image inside one is served under a hashed path.
    expect(existsSync(join(APP, "es", "opengraph-image.tsx"))).toBe(true);
    expect(shareImageFor("en")).toMatchObject({
      url: "/opengraph-image",
      alt: SITE.en.metadata.shareImageAlt,
    });
    expect(shareImageFor("es")).toMatchObject({
      url: "/es/opengraph-image",
      alt: SITE.es.metadata.shareImageAlt,
    });
    expect(SITE.es.metadata.shareImageAlt).not.toBe(SITE.en.metadata.shareImageAlt);
  });
});

describe("the Spanish pages", () => {
  const TRANSLATED = [{ path: "/", translated: true }];

  test("each one is a page under app/(marketing-es) with an English page in the sitemap", () => {
    const spanishRoutes = marketingRoutes(MARKETING_ES)
      .map((p) => p.route)
      .filter((route) => !route.includes("["));
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
    const homes = [siteUrl("/"), siteUrl("/es")];
    for (const entry of SITEMAP.filter((e) => !homes.includes(e.url))) {
      expect(entry.priority!).toBeLessThan(1);
    }
    expect(new Set(SITEMAP_URLS).size).toBe(SITEMAP_URLS.length);
    for (const url of SITEMAP_URLS) expect(new URL(url).origin).toBe(siteOrigin());
  });

  test("lists the Spanish landing with the home page's rank and both languages", () => {
    const pair = { en: siteUrl("/"), es: siteUrl("/es"), "x-default": siteUrl("/") };
    const entry = (url: string) => SITEMAP.find((e) => e.url === url);
    expect(entry(siteUrl("/es"))).toMatchObject({ priority: 1, alternates: { languages: pair } });
    expect(entry(siteUrl("/"))).toMatchObject({ alternates: { languages: pair } });
  });

  test("lists the Spanish FAQ with the FAQ's rank and both languages", () => {
    const pair = { en: siteUrl("/faq"), es: siteUrl("/es/faq"), "x-default": siteUrl("/faq") };
    const entry = (url: string) => SITEMAP.find((e) => e.url === url);
    expect(entry(siteUrl("/es/faq"))).toMatchObject({
      priority: 0.8,
      changeFrequency: "monthly",
      alternates: { languages: pair },
    });
    expect(entry(siteUrl("/faq"))).toMatchObject({ alternates: { languages: pair } });
  });

  test("lists the Spanish security page with its rank and both languages", () => {
    const pair = {
      en: siteUrl("/security"),
      es: siteUrl("/es/security"),
      "x-default": siteUrl("/security"),
    };
    const entry = (url: string) => SITEMAP.find((e) => e.url === url);
    expect(entry(siteUrl("/es/security"))).toMatchObject({
      priority: 0.9,
      changeFrequency: "monthly",
      alternates: { languages: pair },
    });
    expect(entry(siteUrl("/security"))).toMatchObject({ alternates: { languages: pair } });
  });

  test("lists the Spanish how it works page with its rank and both languages", () => {
    const pair = {
      en: siteUrl("/how-it-works"),
      es: siteUrl("/es/how-it-works"),
      "x-default": siteUrl("/how-it-works"),
    };
    const entry = (url: string) => SITEMAP.find((e) => e.url === url);
    expect(entry(siteUrl("/es/how-it-works"))).toMatchObject({
      priority: 0.9,
      changeFrequency: "monthly",
      alternates: { languages: pair },
    });
    expect(entry(siteUrl("/how-it-works"))).toMatchObject({ alternates: { languages: pair } });
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
        languageAlternates(routeLocale(path), path, PAIRS) ?? undefined
      );
    }
  });

  test("lists each translated post and its English post with both languages", () => {
    const translated = getAllPostMetas("es");
    expect(translated.length).toBeGreaterThan(0);
    for (const { slug } of translated) {
      const pair = {
        en: siteUrl(`/blog/${slug}`),
        es: siteUrl(`/es/blog/${slug}`),
        "x-default": siteUrl(`/blog/${slug}`),
      };
      const entry = (url: string) => SITEMAP.find((e) => e.url === url);
      expect(entry(siteUrl(`/es/blog/${slug}`))).toMatchObject({
        priority: 0.7,
        lastModified: new Date(getPost(slug, "es").updatedAt),
        alternates: { languages: pair },
      });
      expect(entry(siteUrl(`/blog/${slug}`))).toMatchObject({ alternates: { languages: pair } });
    }
    const untranslated = getAllPostMetas().filter(
      (p) => !translated.some((t) => t.slug === p.slug)
    );
    expect(untranslated.length).toBeGreaterThan(0);
    for (const { slug } of untranslated) {
      expect(SITEMAP.find((e) => e.url === siteUrl(`/blog/${slug}`))?.alternates).toBeUndefined();
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
