import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ReactElement } from "react";
import LandingPage from "@/app/(marketing)/page";
import SecurityPage from "@/app/(marketing)/security/page";
import HowItWorksPage from "@/app/(marketing)/how-it-works/page";
import FaqPage from "@/app/(marketing)/faq/page";
import PlaygroundPage from "@/app/(marketing)/playground/page";
import NotFoundView from "@/components/marketing/NotFoundView";
import { renderMarketing } from "./fixtures/marketing";

const PAGES: Record<string, () => ReactElement> = {
  landing: () => <LandingPage />,
  security: () => <SecurityPage />,
  "how it works": () => <HowItWorksPage />,
  faq: () => <FaqPage />,
  playground: () => <PlaygroundPage />,
  "not found": () => <NotFoundView />,
};

const GOLD = /(?:^|\s)(?:[a-z-]+:)*(?:bg|text|border)-value(?:\/\S+)?(?=\s|$)/;
const AMOUNT = /^\+?\d[\d,.]*(?:\s*XLM)?$/;

function gold(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[class]")].filter((el) =>
    GOLD.test(el.getAttribute("class") ?? "")
  );
}

afterEach(() => mock.restore());

describe("gold on marketing pages", () => {
  for (const [name, page] of Object.entries(PAGES)) {
    test(`${name}: no button or link is gold`, () => {
      const root = renderMarketing(page());
      const actions = gold(root).filter((el) => el.closest("a, button") === el);
      expect(actions.map((el) => el.outerHTML)).toEqual([]);
    });

    test(`${name}: gold marks only an XLM amount, a total, its bar or the headline's lumens`, () => {
      const root = renderMarketing(page());
      const misused = gold(root).filter((el) => {
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text === "") return !el.parentElement?.parentElement?.querySelector(".text-value");
        return !AMOUNT.test(text) && text !== "lumens.";
      });
      expect(misused.map((el) => el.outerHTML)).toEqual([]);
    });
  }

  test("the landing actions are Button classes or cyan text links, not a hand-rolled fill", () => {
    const root = renderMarketing(<LandingPage />);
    const open = [...root.querySelectorAll("a")].filter((a) => a.textContent === "Open the app");
    expect(open.length).toBeGreaterThan(0);
    for (const a of open) {
      const button = /\bbg-accent\b|\bborder-line-strong\b/.test(a.className);
      const textLink = /\btext-accent\b/.test(a.className) && !/(?:^|\s)bg-/.test(a.className);
      expect(button || textLink).toBe(true);
    }
    const submit = [...root.querySelectorAll("button")].find(
      (b) => b.textContent === "Analyze account"
    );
    expect(submit?.className).toContain("bg-accent");
    expect(submit?.className).toContain("text-accent-fg");
  });
});
