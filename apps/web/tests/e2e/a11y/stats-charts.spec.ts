import { expect, test, type Locator } from "@playwright/test";
import { installApiFixtures } from "./fixtures";

let api: Awaited<ReturnType<typeof installApiFixtures>>;

test.beforeEach(async ({ page }) => {
  api = await installApiFixtures(page);
  // The feed fixture's close falls inside the last 60 days, so the chart has dots and months.
  await page.clock.setFixedTime(new Date("2026-01-20T00:00:00Z"));
});

test.afterEach(() => api.expectAllAnswered());

const CHARTS = [
  "Constellation of account closes over time",
  "Distribution of XLM recovered per close",
];

function card(chart: Locator): Locator {
  return chart.locator("xpath=ancestor::div[contains(@class, 'rounded-2xl')][1]");
}

for (const name of CHARTS) {
  test(`${name}: labels are 11px or larger and sit at their marks`, async ({ page }) => {
    await page.goto("/stats");
    const box = card(page.locator(`svg[aria-label="${name}"]`));
    const labels = box.locator("[data-axis-label]");
    const ticks = box.locator("[data-axis-tick]");
    await expect(ticks.first()).toBeAttached();
    expect(await box.locator("svg text").count()).toBe(0);

    const sizes = await labels.evaluateAll((els) =>
      els.map((el) => parseFloat(getComputedStyle(el).fontSize))
    );
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(11);

    const tickCount = await ticks.count();
    for (let i = 0; i < tickCount; i++) {
      const tick = (await ticks.nth(i).boundingBox())!;
      const label = (await labels.nth(i).boundingBox())!;
      const anchor = await labels.nth(i).getAttribute("data-anchor");
      const at =
        anchor === "start"
          ? label.x
          : anchor === "end"
            ? label.x + label.width
            : label.x + label.width / 2;
      expect(Math.abs(at - (tick.x + tick.width / 2)), `label ${i} at its tick`).toBeLessThan(1);
    }

    const boxes = (await Promise.all((await labels.all()).map((l) => l.boundingBox())))
      .map((b) => b!)
      .sort((a, b) => a.x - b.x);
    const chartBox = (await box.boundingBox())!;
    for (let i = 0; i < boxes.length; i++) {
      expect(boxes[i].x).toBeGreaterThanOrEqual(chartBox.x);
      expect(boxes[i].x + boxes[i].width).toBeLessThanOrEqual(chartBox.x + chartBox.width);
      if (i > 0)
        expect(boxes[i].x, `label ${i} clears the one before`).toBeGreaterThan(
          boxes[i - 1].x + boxes[i - 1].width
        );
    }
  });
}

test("the heatmap's scroll area is reached by Tab and scrolls with the arrow keys", async ({
  page,
}) => {
  await page.goto("/stats");
  await expect(page.getByText(/\d+ active days/)).toBeVisible();
  const region = page.getByRole("region", { name: "Activity heatmap, last 12 months" });

  for (let i = 0; i < 40 && !(await region.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press("Tab");
  await expect(region).toBeFocused();
  const outline = await region.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none");

  const overflows = await region.evaluate((el) => el.scrollWidth > el.clientWidth);
  test.skip(!overflows, "the grid fits, so there is nothing to scroll");
  expect(await region.evaluate((el) => el.scrollLeft)).toBe(0);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
});
