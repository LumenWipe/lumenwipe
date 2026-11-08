import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/** WCAG 2.2 A and AA, which is where the 24 by 24 px target size (SC 2.5.8) lives. */
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const BLOCKING = new Set(["serious", "critical"]);

/**
 * Runs axe on the page once it has a title and fails on any serious or critical violation. Lesser
 * findings are attached to the test as annotations so they stay visible without failing it.
 */
export async function expectNoAxeViolations(page: Page, screen: string): Promise<void> {
  // Metadata is streamed, and every client navigation mounts the head's title anew, so for a
  // moment after one `document.title` is empty. Wait for it here. This cannot see a navigation
  // that has not started yet, and `waitForLoadState("networkidle")` does not help either: it
  // stays fired for the document after the first idle and ignores client navigations. So a spec
  // whose last action navigates waits for the destination URL before calling this.
  await expect(page, `document title on ${screen}`).toHaveTitle(/\S/);
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const describe = (v: (typeof violations)[number]): string =>
    `${v.id} (${v.impact}): ${v.help}\n${v.nodes
      .map((n) => `  ${n.target.join(" ")}\n    ${n.failureSummary?.replace(/\n/g, "\n    ")}`)
      .join("\n")}`;

  for (const v of violations.filter((v) => !BLOCKING.has(v.impact ?? ""))) {
    test.info().annotations.push({ type: `axe ${screen}`, description: describe(v) });
  }
  const blocking = violations.filter((v) => BLOCKING.has(v.impact ?? ""));
  expect(blocking.map(describe), `serious or critical axe violations on ${screen}`).toEqual([]);
}
