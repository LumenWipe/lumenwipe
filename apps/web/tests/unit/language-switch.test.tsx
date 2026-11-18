import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import * as navigation from "next/navigation";
import LanguageSwitch from "@/components/marketing/LanguageSwitch";
import MarketingFooter from "@/components/marketing/MarketingFooter";
import MarketingNav from "@/components/marketing/MarketingNav";
import { languageAlternate, SPANISH_PAGES, type SpanishPage } from "@/lib/site/pages";

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
    expect(languageAlternate("en", "/blog", TRANSLATED)).toBeNull();
    expect(languageAlternate("es", "/faq", TRANSLATED)).toBeNull();
    expect(languageAlternate("en", "/es/faq", TRANSLATED)).toBeNull();
  });

  test("the header, mobile menu and footer each mount it, in both directions", () => {
    // The real list, flipped in place for this test only: the nav and footer take no list prop.
    const home = SPANISH_PAGES.find((page) => page.path === "/") as SpanishPage;
    home.translated = true;
    try {
      for (const [locale, pathname, href, tag] of [
        ["en", "/", "/es", "es-419"],
        ["es", "/es", "/", "en"],
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
    } finally {
      home.translated = false;
    }
  });

  test("links nothing today: no Spanish page is translated yet", () => {
    expect(SPANISH_PAGES.every((page) => !page.translated)).toBe(true);
    for (const [locale, pathname] of [
      ["en", "/"],
      ["es", "/es"],
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
});
