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
import LandingPage, { metadata as landingMetadata } from "@/app/(marketing)/page";
import FaqPage, { metadata as faqMetadata } from "@/app/(marketing)/faq/page";
import SecurityPage, { metadata as securityMetadata } from "@/app/(marketing)/security/page";
import HowItWorksPage, {
  metadata as howItWorksMetadata,
} from "@/app/(marketing)/how-it-works/page";
import MarketingNav from "@/components/marketing/MarketingNav";
import MarketingFooter from "@/components/marketing/MarketingFooter";
import NotFoundView, { NOT_FOUND_METADATA } from "@/components/marketing/NotFoundView";
import { renderLlmsTxt } from "@/lib/site/llms";
import { ROOT_METADATA } from "@/lib/site/root-metadata";

// Recorded from the English copy as it stood before it moved into the locale dictionary. A change
// here is a change to what an English reader sees, so it is never updated alongside a refactor.
// Server-rendered, as the build prerenders it, so a text split differently shows as a change too.
// The clock is pinned for the footer's copyright year.

const SURFACES: Record<string, () => ReactElement> = {
  landing: () => <LandingPage />,
  faq: () => <FaqPage />,
  security: () => <SecurityPage />,
  "how it works": () => <HowItWorksPage />,
  nav: () => <MarketingNav />,
  footer: () => <MarketingFooter />,
  "not found": () => <NotFoundView />,
};

const METADATA: Record<string, Metadata> = {
  root: ROOT_METADATA,
  landing: landingMetadata,
  faq: faqMetadata,
  security: securityMetadata,
  "how it works": howItWorksMetadata,
  "not found": NOT_FOUND_METADATA,
};

function serverRender(element: ReactElement): string {
  spyOn(navigation, "useRouter").mockReturnValue({
    push: () => {},
  } as unknown as ReturnType<typeof navigation.useRouter>);
  spyOn(navigation, "usePathname").mockReturnValue("/");
  return renderToString(element);
}

beforeAll(() => setSystemTime(new Date("2026-11-16T00:00:00Z")));
afterAll(() => setSystemTime());
afterEach(() => mock.restore());

describe("English marketing copy", () => {
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

  test("llms.txt is the recorded text", () => {
    expect(renderLlmsTxt("https://lumenwipe.com")).toMatchSnapshot();
  });
});
