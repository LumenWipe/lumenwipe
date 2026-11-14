import { expect, test, type Page } from "@playwright/test";
import { EVERY_KIND_PLAN, answerRoutes, runSetup } from "./fixtures";

// The stacked layout: controls above the scene, the activity log folded away, and nothing wider
// than the screen at 320 px. From lg the scene and the controls sit side by side, log open.

const noHorizontalScroll = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe("on a phone", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) >= 1024, "the stacked layout only");

  test("nothing overflows, the controls come first and the log opens on request", async ({
    page,
  }) => {
    const routes = await answerRoutes(page, 60, EVERY_KIND_PLAN);
    await page.goto("/");
    expect(await noHorizontalScroll(page)).toBe(true);
    await runSetup(page);
    expect(await noHorizontalScroll(page)).toBe(true);

    const controls = await page.getByRole("button", { name: "Demolish it here" }).boundingBox();
    const scene = await page.locator("[data-scene]").boundingBox();
    expect(controls && scene && controls.y < scene.y).toBe(true);

    const toggle = page.getByRole("button", { name: /On-chain activity/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("list", { name: "On-chain activity" })).toBeHidden();
    await toggle.click();
    await expect(page.getByRole("list", { name: "On-chain activity" })).toBeVisible();
    routes.expectAllAnswered();
  });

  test("every node sits inside the scene and clear of the account at its centre", async ({
    page,
  }) => {
    const routes = await answerRoutes(page, 60, EVERY_KIND_PLAN);
    await page.goto("/");
    await runSetup(page);
    const scene = await page.locator("[data-scene]").boundingBox();
    if (!scene) throw new Error("scene not laid out");
    const cx = scene.x + scene.width / 2;
    const cy = scene.y + scene.height / 2;
    // The core is a circle; h-24 below the sm breakpoint.
    const coreRadius = 48;
    const nodes = page
      .getByRole("list", { name: "Entries on the demo account" })
      .getByRole("button");
    await expect(nodes).toHaveCount(EVERY_KIND_PLAN.flatMap((s) => s.nodes).length);
    for (const box of await nodes.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })
    )) {
      expect(box.x).toBeGreaterThanOrEqual(scene.x);
      expect(box.y).toBeGreaterThanOrEqual(scene.y);
      expect(box.x + box.width).toBeLessThanOrEqual(scene.x + scene.width);
      expect(box.y + box.height).toBeLessThanOrEqual(scene.y + scene.height);
      const nearestX = Math.max(box.x, Math.min(cx, box.x + box.width));
      const nearestY = Math.max(box.y, Math.min(cy, box.y + box.height));
      expect(Math.hypot(nearestX - cx, nearestY - cy)).toBeGreaterThanOrEqual(coreRadius);
    }
    expect(await noHorizontalScroll(page)).toBe(true);
    routes.expectAllAnswered();
  });
});

test("on a wide screen the log is open, with no toggle", async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 0) < 1024, "the side-by-side layout only");
  const routes = await answerRoutes(page);
  await page.goto("/");
  await runSetup(page);
  await expect(page.getByRole("list", { name: "On-chain activity" })).toBeVisible();
  await expect(page.getByRole("button", { name: /On-chain activity/ })).toBeHidden();
  routes.expectAllAnswered();
});
