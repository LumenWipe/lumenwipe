import { expect, test, type Page } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { enterSourceAddress, enterSourceAndAnalyze, openTestnetHome } from "../helpers/flow";
import { installApiFixtures } from "./fixtures";

const MARK = "data-a11y-tab";

/** Tags every control a keyboard user should be able to reach and returns how many there are.
 *  A radio group and a roving tablist contribute one stop each, as the browser gives them. */
async function markTabStops(page: Page): Promise<number> {
  return page.evaluate((mark) => {
    const candidates = document.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]'
    );
    const radioStop = new Map<string, HTMLInputElement>();
    for (const el of Array.from(candidates)) {
      if (!(el instanceof HTMLInputElement) || el.type !== "radio" || el.disabled) continue;
      const current = radioStop.get(el.name);
      if (!current || (el.checked && !current.checked)) radioStop.set(el.name, el);
    }
    let count = 0;
    for (const el of Array.from(candidates)) {
      el.removeAttribute(mark);
      if (el.matches(":disabled") || el.tabIndex < 0) continue;
      if (el.closest('[inert], [aria-hidden="true"]')) continue;
      if (el instanceof HTMLInputElement && el.type === "radio" && radioStop.get(el.name) !== el) {
        continue;
      }
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || getComputedStyle(el).visibility === "hidden") {
        continue;
      }
      el.setAttribute(mark, String(count++));
    }
    return count;
  }, MARK);
}

/** The ring is drawn on the focused element, or on the wrapper of a composite field. */
async function focusRing(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    let el = document.activeElement as HTMLElement | null;
    for (let depth = 0; el && depth < 3; depth++, el = el.parentElement) {
      const style = getComputedStyle(el);
      if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2) return true;
    }
    return false;
  });
}

async function expectEveryStopReachedWithRing(page: Page): Promise<void> {
  const total = await markTabStops(page);
  expect(total).toBeGreaterThan(0);
  await page.locator("body").evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  const reached = new Set<string>();
  const withoutRing: string[] = [];
  for (let presses = 0; presses < total + 20 && reached.size < total; presses++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(
      (mark) => document.activeElement?.getAttribute(mark) ?? null,
      MARK
    );
    if (stop === null) continue;
    reached.add(stop);
    if (!(await focusRing(page))) {
      withoutRing.push(await page.evaluate(() => document.activeElement?.outerHTML ?? ""));
    }
  }

  const missed = await page.evaluate(
    ([mark, seen]) =>
      Array.from(document.querySelectorAll(`[${mark}]`))
        .filter((el) => !seen.includes(el.getAttribute(mark) ?? ""))
        .map((el) => el.outerHTML.slice(0, 200)),
    [MARK, [...reached]] as const
  );
  expect(missed, "controls Tab never reached").toEqual([]);
  expect(withoutRing, "controls focused without a visible ring").toEqual([]);
}

test("every control on the entry screen is reachable with Tab and shows the ring", async ({
  page,
}) => {
  const api = await installApiFixtures(page);
  await openTestnetHome(page);
  await expectEveryStopReachedWithRing(page);
  await enterSourceAddress(page, Keypair.random().publicKey());
  await expectEveryStopReachedWithRing(page);
  api.expectAllAnswered();
});

test("every control on the analyze screen is reachable with Tab and shows the ring", async ({
  page,
}) => {
  const api = await installApiFixtures(page);
  await enterSourceAndAnalyze(page, Keypair.random().publicKey());
  await expect(page.getByRole("heading", { level: 1, name: "Review & decide" })).toBeVisible();
  await expectEveryStopReachedWithRing(page);
  api.expectAllAnswered();
});
