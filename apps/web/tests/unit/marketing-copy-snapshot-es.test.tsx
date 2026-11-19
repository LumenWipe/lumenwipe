import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import * as navigation from "next/navigation";
import type { Metadata } from "next";
import SpanishLandingPage, { metadata as landingMetadata } from "@/app/(marketing-es)/es/page";
import SpanishFaqPage, { metadata as faqMetadata } from "@/app/(marketing-es)/es/faq/page";
import MarketingNav from "@/components/marketing/MarketingNav";
import MarketingFooter from "@/components/marketing/MarketingFooter";
import NotFoundView, { notFoundMetadata } from "@/components/marketing/NotFoundView";
import { FAQ } from "@/lib/i18n/messages/faq";
import { rootMetadata } from "@/lib/site/root-metadata";
import { siteUrl } from "@/lib/site/url";
import { fakeRouter } from "./fixtures/navigation";

// The Spanish copy as the build prerenders /es, /es/faq, their frame and the 404, awaiting a native reader's
// review. A change here is a change to what a Spanish reader sees.

const SURFACES: Record<string, () => ReactElement> = {
  landing: () => <SpanishLandingPage />,
  faq: () => <SpanishFaqPage />,
  nav: () => <MarketingNav locale="es" />,
  footer: () => <MarketingFooter locale="es" />,
  "not found": () => <NotFoundView locale="es" />,
};

const METADATA: Record<string, Metadata> = {
  root: rootMetadata("es"),
  landing: landingMetadata,
  faq: faqMetadata,
  "not found": notFoundMetadata("es"),
};

function serverRender(element: ReactElement): string {
  spyOn(navigation, "useRouter").mockReturnValue(fakeRouter());
  spyOn(navigation, "usePathname").mockReturnValue("/es");
  return renderToString(element);
}

beforeAll(() => setSystemTime(new Date("2026-11-16T00:00:00Z")));
afterAll(() => setSystemTime());
afterEach(() => mock.restore());

describe("Spanish marketing copy", () => {
  for (const [name, surface] of Object.entries(SURFACES)) {
    test(`${name} renders the recorded markup`, () => {
      expect(serverRender(surface())).toMatchSnapshot();
    });
  }

  for (const [name, metadata] of Object.entries(METADATA)) {
    test(`${name} metadata is the recorded metadata`, () => {
      expect(JSON.parse(JSON.stringify(metadata))).toMatchSnapshot();
    });
  }

  test("the landing shows the FAQ in Spanish", () => {
    const html = serverRender(<SpanishLandingPage />);
    expect(html).toContain(FAQ.es.heading);
    expect(html).not.toContain(FAQ.en.heading);
    expect(html).toContain('aria-controls="');
  });

  test("the landing is indexed, with both languages and the other Open Graph locale", () => {
    expect(landingMetadata.robots).toBeUndefined();
    expect(landingMetadata.alternates?.canonical).toBe(siteUrl("/es"));
    expect(landingMetadata.alternates?.languages).toEqual({
      en: siteUrl("/"),
      es: siteUrl("/es"),
      "x-default": siteUrl("/"),
    });
    expect(landingMetadata.openGraph).toMatchObject({
      locale: "es_LA",
      alternateLocale: ["en_US"],
    });
  });

  test("the FAQ is indexed, with both languages and the other Open Graph locale", () => {
    expect(faqMetadata.robots).toBeUndefined();
    expect(faqMetadata.alternates?.canonical).toBe(siteUrl("/es/faq"));
    expect(faqMetadata.alternates?.languages).toEqual({
      en: siteUrl("/faq"),
      es: siteUrl("/es/faq"),
      "x-default": siteUrl("/faq"),
    });
    expect(faqMetadata.openGraph).toMatchObject({
      locale: "es_LA",
      alternateLocale: ["en_US"],
    });
  });
});
