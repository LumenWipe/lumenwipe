import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe";
import { EVERY_KIND_PLAN, answerRoutes, runSetup } from "./fixtures";

// The scene as something to read, not only to watch: its list view, its keyboard model and what
// it does with the visitor's motion preference.

const orbit = (page: Page): Locator =>
  page.getByRole("list", { name: "Entries on the demo account" });

async function setUpEveryKind(page: Page): Promise<() => void> {
  const routes = await answerRoutes(page, 60, EVERY_KIND_PLAN);
  await page.goto("/");
  await runSetup(page);
  return routes.expectAllAnswered;
}

/** A node's centre, rounded to whole pixels. */
async function centre(node: Locator): Promise<string> {
  const box = await node.boundingBox();
  if (!box) throw new Error("node not laid out");
  return `${Math.round(box.x + box.width / 2)},${Math.round(box.y + box.height / 2)}`;
}

test("the list view says what the orbit draws, and passes axe", async ({ page }) => {
  const expectAllAnswered = await setUpEveryKind(page);
  const names = await orbit(page)
    .getByRole("button")
    .evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label")));
  expect(names.length).toBe(EVERY_KIND_PLAN.flatMap((s) => s.nodes).length);
  await expect(page.getByRole("list", { name: "Legend" })).toBeVisible();

  await page.getByRole("button", { name: "List" }).click();
  const rows = page
    .getByRole("list", { name: "Entries on the demo account" })
    .getByRole("listitem");
  await expect(rows).toHaveCount(names.length);
  expect([...(await rows.allTextContents())].sort()).toEqual([...names].sort());
  await expectNoAxeViolations(page, "scene list");
  expectAllAnswered();
});

test("the orbit is one tab stop, and the arrow keys walk its nodes", async ({ page }) => {
  const expectAllAnswered = await setUpEveryKind(page);
  const buttons = orbit(page).getByRole("button");
  await expect(orbit(page).locator('button[tabindex="0"]')).toHaveCount(1);
  await buttons.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(buttons.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(buttons.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(buttons.first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(buttons.first()).toHaveAttribute("aria-expanded", "true");
  expectAllAnswered();
});

test("under reduced motion the orbit stands still, with no pause button", async ({ page }) => {
  const expectAllAnswered = await setUpEveryKind(page);
  const node = orbit(page).getByRole("button").first();
  const before = await centre(node);
  await page.waitForTimeout(1500);
  expect(await centre(node)).toBe(before);
  await expect(page.getByRole("button", { name: "Pause motion" })).toHaveCount(0);
  expectAllAnswered();
});

test("without it the orbit drifts, and Pause motion stops it", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const expectAllAnswered = await setUpEveryKind(page);
  // Away from the nodes, since a pointer over the orbit holds it still.
  await page.mouse.move(0, 0);
  const node = orbit(page).getByRole("button").first();
  const before = await centre(node);
  await expect.poll(() => centre(node), { timeout: 5000 }).not.toBe(before);

  await page.getByRole("button", { name: "Pause motion" }).click();
  await page.mouse.move(0, 0);
  // Let the spring settle and the last frame land before measuring.
  await page.waitForTimeout(500);
  const paused = await centre(node);
  await page.waitForTimeout(1500);
  expect(await centre(node)).toBe(paused);
  expectAllAnswered();
});
