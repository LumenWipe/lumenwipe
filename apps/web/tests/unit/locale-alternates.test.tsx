import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveSitemap } from "next/dist/build/webpack/loaders/metadata/resolve-route-data";
import { createMetadataElements } from "next/dist/lib/metadata/metadata-elements";
import {
  accumulateMetadata,
  createSelectedMetadata,
} from "next/dist/lib/metadata/resolve-metadata";
import type { Metadata } from "next";
import { LOCALE_TAGS, type Locale } from "@/lib/i18n/locale";
import {
  languageAlternates,
  localePath,
  pageMetadata,
  sitemapPages,
  type SpanishPage,
} from "@/lib/site/pages";
import { rootMetadata } from "@/lib/site/root-metadata";
import { siteUrl } from "@/lib/site/url";

const TRANSLATED: SpanishPage[] = [{ path: "/", translated: true }];
const UNTRANSLATED: SpanishPage[] = [{ path: "/", translated: false }];

/** The `<head>` tags Next renders for a page under its locale's root layout. */
async function headTags(locale: Locale, path: string, pages: readonly SpanishPage[]) {
  const page = pageMetadata({ path, locale, title: "Page", description: "About it." }, pages);
  const resolved = await accumulateMetadata(
    path,
    [
      [rootMetadata(locale), null],
      [page, null],
    ],
    Promise.resolve(path),
    { trailingSlash: false, isStaticMetadataRouteFile: false }
  );
  const head = document.createElement("head");
  head.innerHTML = renderToStaticMarkup(
    <>{createMetadataElements(createSelectedMetadata(resolved))}</>
  );
  const hreflang = Object.fromEntries(
    [...head.querySelectorAll('link[rel="alternate"][hreflang]')].map((link) => [
      link.getAttribute("hreflang"),
      new URL(link.getAttribute("href")!).href,
    ])
  );
  const og = (property: string) =>
    [...head.querySelectorAll(`meta[property="${property}"]`)].map((m) =>
      m.getAttribute("content")
    );
  return {
    canonical: new URL(head.querySelector('link[rel="canonical"]')!.getAttribute("href")!).href,
    hreflang,
    ogLocale: og("og:locale"),
    ogLocaleAlternate: og("og:locale:alternate"),
    robots: head.querySelector('meta[name="robots"]')?.getAttribute("content") ?? null,
  };
}

/** The sitemap XML Next writes for the static pages, as each URL and its hreflang links. */
function sitemapAlternates(pages: readonly SpanishPage[]): Record<string, Record<string, string>> {
  const xml = resolveSitemap(sitemapPages(pages));
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return Object.fromEntries(
    [...doc.getElementsByTagName("url")].map((url) => [
      url.getElementsByTagName("loc")[0]!.textContent,
      Object.fromEntries(
        [...url.getElementsByTagName("xhtml:link")].map((link) => [
          link.getAttribute("hreflang"),
          link.getAttribute("href"),
        ])
      ),
    ])
  );
}

const PAIR = { en: siteUrl("/"), es: siteUrl("/es"), "x-default": siteUrl("/") };

describe("a translated pair", () => {
  test("has one hreflang set, the same from either side, naming each version and English as x-default", () => {
    expect(languageAlternates("en", "/", TRANSLATED)).toEqual(PAIR);
    expect(languageAlternates("es", "/es", TRANSLATED)).toEqual(PAIR);
  });

  for (const locale of ["en", "es"] as const) {
    const other: Locale = locale === "en" ? "es" : "en";
    const path = localePath(locale, "/");

    test(`renders the ${locale} version's own canonical, the set and the other Open Graph locale`, async () => {
      const head = await headTags(locale, path, TRANSLATED);
      expect(head.canonical).toBe(siteUrl(path));
      expect(head.hreflang).toEqual(PAIR);
      expect(head.ogLocale).toEqual([LOCALE_TAGS[locale].openGraph]);
      expect(head.ogLocaleAlternate).toEqual([LOCALE_TAGS[other].openGraph]);
      expect(head.robots).toBeNull();
    });
  }

  test("lists the set under both URLs in the sitemap, and under no other", () => {
    const entries = sitemapAlternates(TRANSLATED);
    expect(entries[siteUrl("/")]).toEqual(PAIR);
    expect(entries[siteUrl("/es")]).toEqual(PAIR);
    for (const [url, links] of Object.entries(entries)) {
      if (url !== siteUrl("/") && url !== siteUrl("/es")) expect(links).toEqual({});
    }
  });
});

describe("a page with no translated pair", () => {
  test("has no hreflang set", () => {
    expect(languageAlternates("en", "/", UNTRANSLATED)).toBeNull();
    expect(languageAlternates("es", "/es", UNTRANSLATED)).toBeNull();
    for (const path of ["/faq", "/blog", "/blog/a-post", "/mainnet"]) {
      expect(languageAlternates("en", path, TRANSLATED)).toBeNull();
    }
    expect(languageAlternates("es", "/es/faq", TRANSLATED)).toBeNull();
  });

  test("names no alternate when its Spanish version is untranslated, which stays noindex", async () => {
    const english = await headTags("en", "/", UNTRANSLATED);
    const spanish = await headTags("es", "/es", UNTRANSLATED);
    for (const head of [english, spanish]) {
      expect(head.hreflang).toEqual({});
      expect(head.ogLocaleAlternate).toEqual([]);
    }
    expect(english.robots).toBeNull();
    expect(spanish.robots).toBe("noindex, follow");
  });

  test("names no alternate in the sitemap", () => {
    for (const links of Object.values(sitemapAlternates(UNTRANSLATED))) expect(links).toEqual({});
  });

  test("declares neither in its metadata", () => {
    const metadata: Metadata = pageMetadata(
      { path: "/faq", title: "FAQ", description: "About it." },
      TRANSLATED
    );
    expect(metadata.alternates).not.toHaveProperty("languages");
    expect(metadata.openGraph).not.toHaveProperty("alternateLocale");
  });
});
