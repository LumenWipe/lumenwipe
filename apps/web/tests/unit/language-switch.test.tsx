import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import * as navigation from "next/navigation";
import LanguageSwitch from "@/components/marketing/LanguageSwitch";
import MarketingFooter from "@/components/marketing/MarketingFooter";
import MarketingNav from "@/components/marketing/MarketingNav";
import {
  isTranslated,
  languageAlternate,
  localeHref,
  SPANISH_PAGES,
  type SpanishPage,
} from "@/lib/site/pages";
import { spanishPages } from "@/lib/site/spanish-pages";

const TRANSLATED: readonly SpanishPage[] = [
  { path: "/", translated: true },
  { path: "/faq", translated: true },
  { path: "/security", translated: false },
];

const at = (pathname: string) => spyOn(navigation, "usePathname").mockReturnValue(pathname);

afterEach(() => {
  cleanup();
  mock.restore();
});

describe("the language switch", () => {
  test("links a translated English page to its Spanish version, in Spanish", () => {
    at("/faq");
    render(<LanguageSwitch locale="en" pages={TRANSLATED} />);
    const link = screen.getByRole("link", { name: "Español" });
    expect(link.getAttribute("href")).toBe("/es/faq");
    expect(link.getAttribute("hreflang")).toBe("es-419");
    expect(link.getAttribute("lang")).toBe("es-419");
  });

  test("links a translated Spanish page back to its English version, in English", () => {
    at("/es");
    render(<LanguageSwitch locale="es" pages={TRANSLATED} />);
    const link = screen.getByRole("link", { name: "English" });
    expect(link.getAttribute("href")).toBe("/");
    expect(link.getAttribute("hreflang")).toBe("en");
    expect(link.getAttribute("lang")).toBe("en");
  });

  test("renders nothing for an untranslated page, in either direction", () => {
    for (const [locale, pathname] of [
      ["en", "/security"],
      ["es", "/es/security"],
    ] as const) {
      at(pathname);
      const { container } = render(<LanguageSwitch locale={locale} pages={TRANSLATED} />);
      expect(container.innerHTML).toBe("");
      cleanup();
      mock.restore();
    }
  });

  test("renders nothing for a page with no Spanish version, or a path in the other locale", () => {
    expect(languageAlternate("en", "/stats", TRANSLATED)).toBeNull();
    expect(languageAlternate("es", "/faq", TRANSLATED)).toBeNull();
    expect(languageAlternate("en", "/es/faq", TRANSLATED)).toBeNull();
  });

  test("the header, mobile menu and footer each mount it, in both directions", () => {
    for (const path of ["/", "/faq", "/security", "/how-it-works"]) {
      expect(SPANISH_PAGES.find((page) => page.path === path)?.translated).toBe(true);
    }
    for (const [locale, pathname, href, tag] of [
      ["en", "/", "/es", "es-419"],
      ["es", "/es", "/", "en"],
      ["en", "/faq", "/es/faq", "es-419"],
      ["es", "/es/faq", "/faq", "en"],
      ["en", "/security", "/es/security", "es-419"],
      ["es", "/es/security", "/security", "en"],
      ["en", "/how-it-works", "/es/how-it-works", "es-419"],
      ["es", "/es/how-it-works", "/how-it-works", "en"],
    ] as const) {
      at(pathname);
      const { container } = render(
        <>
          <MarketingNav locale={locale} />
          <MarketingFooter locale={locale} />
        </>
      );
      const nav = container.querySelector("nav")!;
      const sheet = container.querySelector("header > div[id]")!;
      const footer = container.querySelector("footer")!;
      for (const [where, region] of [
        ["header", nav],
        ["mobile menu", sheet],
        ["footer", footer],
      ] as const) {
        const links = [...region.querySelectorAll("a[hreflang]")];
        expect(links, `${where} on ${pathname}`).toHaveLength(1);
        expect(links[0].getAttribute("href")).toBe(href);
        expect(links[0].getAttribute("hreflang")).toBe(tag);
        expect(links[0].getAttribute("lang")).toBe(tag);
      }
      cleanup();
      mock.restore();
    }
  });

  test("the header, mobile menu and footer link a translated post to its other version, and an untranslated post to none", () => {
    const slug = "how-do-i-remove-a-trustline-on-stellar";
    expect(spanishPages()).toContainEqual({ path: `/blog/${slug}`, translated: true });
    for (const [locale, pathname, href] of [
      ["en", `/blog/${slug}`, `/es/blog/${slug}`],
      ["es", `/es/blog/${slug}`, `/blog/${slug}`],
      ["en", "/blog", "/es/blog"],
      ["es", "/es/blog", "/blog"],
      ["en", "/blog/account-merge-on-stellar", null],
    ] as const) {
      at(pathname);
      const { container } = render(
        <>
          <MarketingNav locale={locale} pages={spanishPages()} />
          <MarketingFooter locale={locale} pages={spanishPages()} />
        </>
      );
      const links = [...container.querySelectorAll("a[hreflang]")].map((a) =>
        a.getAttribute("href")
      );
      expect({ pathname, links }).toEqual({ pathname, links: href ? [href, href, href] : [] });
      cleanup();
      mock.restore();
    }
  });

  test("the frame gives the header and footer the translated posts, read on the server", () => {
    // The frame loads next/font, which runs only inside a Next build, so its source is read.
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "components", "marketing", "MarketingShell.tsx"),
      "utf8"
    );
    expect(source).toContain("const pages = spanishPages();");
    expect(source).toContain("<MarketingNav locale={locale} pages={pages} />");
    expect(source).toContain("<MarketingFooter locale={locale} pages={pages} />");
  });

  test("the footer leads to the blog in the reader's language", () => {
    for (const [locale, href] of [
      ["en", "/blog"],
      ["es", "/es/blog"],
    ] as const) {
      at(locale === "en" ? "/" : "/es");
      const { container } = render(<MarketingFooter locale={locale} />);
      const blog = [...container.querySelectorAll("footer a")].filter((link) =>
        /\/blog$/.test(link.getAttribute("href") ?? "")
      );
      expect(blog.map((link) => link.getAttribute("href"))).toEqual([href]);
      cleanup();
      mock.restore();
    }
  });

  test("links nothing from a page whose other version is not translated", () => {
    for (const [locale, pathname] of [
      ["en", "/registry"],
      ["en", "/stats"],
    ] as const) {
      at(pathname);
      const { container } = render(
        <>
          <MarketingNav locale={locale} />
          <MarketingFooter locale={locale} />
        </>
      );
      expect(container.querySelector("a[hreflang]")).toBeNull();
      expect(screen.queryByRole("link", { name: /^(English|Español)$/ })).toBeNull();
      cleanup();
      mock.restore();
    }
  });

  test("the footer leads to the FAQ in the reader's language", () => {
    for (const [locale, pathname, href] of [
      ["en", "/", "/faq"],
      ["es", "/es", "/es/faq"],
    ] as const) {
      at(pathname);
      const { container } = render(<MarketingFooter locale={locale} />);
      const faq = [...container.querySelectorAll("footer a")].filter((link) =>
        link.getAttribute("href")?.endsWith("/faq")
      );
      expect(faq.map((link) => link.getAttribute("href"))).toEqual([href]);
      cleanup();
      mock.restore();
    }
  });

  test("the header, mobile menu and footer lead to the security and how it works pages in the reader's language", () => {
    for (const [locale, pathname, prefix] of [
      ["en", "/", ""],
      ["es", "/es", "/es"],
    ] as const) {
      at(pathname);
      const { container } = render(
        <>
          <MarketingNav locale={locale} />
          <MarketingFooter locale={locale} />
        </>
      );
      const hrefs = [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));
      for (const page of ["/security", "/how-it-works"]) {
        const href = `${prefix}${page}`;
        expect(hrefs.filter((link) => link?.endsWith(page))).toEqual([href, href, href]);
      }
      cleanup();
      mock.restore();
    }
  });
});

describe("links between the locales", () => {
  test("English reads every page; Spanish only the translated ones", () => {
    expect(isTranslated("en", "/security", TRANSLATED)).toBe(true);
    expect(isTranslated("en", "/stats", TRANSLATED)).toBe(true);
    expect(isTranslated("es", "/faq", TRANSLATED)).toBe(true);
    expect(isTranslated("es", "/security", TRANSLATED)).toBe(false);
    expect(isTranslated("es", "/stats", TRANSLATED)).toBe(false);
  });

  test("a Spanish page links to the Spanish version only when it is translated", () => {
    expect(localeHref("es", "/", TRANSLATED)).toBe("/es");
    expect(localeHref("es", "/faq", TRANSLATED)).toBe("/es/faq");
    expect(localeHref("es", "/security", TRANSLATED)).toBe("/security");
    expect(localeHref("en", "/faq", TRANSLATED)).toBe("/faq");
  });
});
