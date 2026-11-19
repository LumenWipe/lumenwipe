import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
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
    expect(SPANISH_PAGES.find((page) => page.path === "/")?.translated).toBe(true);
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
  });

  test("links nothing from a page whose other version is not translated", () => {
    for (const [locale, pathname] of [
      ["en", "/faq"],
      ["en", "/security"],
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
