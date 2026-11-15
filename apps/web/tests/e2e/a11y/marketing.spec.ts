import { expect, test, type Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe";
import { installApiFixtures } from "./fixtures";

let api: Awaited<ReturnType<typeof installApiFixtures>>;

test.beforeEach(async ({ page }) => {
  api = await installApiFixtures(page);
});

test.afterEach(() => api.expectAllAnswered());

const DESKTOP = 1024;

function isPhoneWidth(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < DESKTOP;
}

for (const path of ["/faq", "/security"]) {
  test(`${path} has no serious accessibility violations`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoAxeViolations(page, path);
  });
}

for (const [name, path] of [
  ["an unknown page", "/no-such-page"],
  ["a missing blog post", "/blog/no-such-post"],
]) {
  test(`${name} answers 404 with the marketing not-found page and noindex`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/This page has\s*been closed/);
    const robots = await page
      .locator('meta[name="robots"], meta[name="googlebot"]')
      .evaluateAll((tags) => tags.map((t) => t.getAttribute("content") ?? ""));
    expect(robots.length).toBeGreaterThan(0);
    for (const content of robots) expect(content).toContain("noindex");
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    const next = page.getByRole("navigation", { name: "Where to go next" });
    for (const link of ["Guides", "How it works", "Try the playground", /Report a broken link/]) {
      await expect(next.getByRole("link", { name: link })).toBeVisible();
    }
    await expectNoAxeViolations(page, name);
  });
}

test("the skip link is the first stop and moves focus to the content", async ({ page }) => {
  await page.goto("/security");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
});

test("the mobile menu opens with Enter, keeps Tab inside and closes with Escape", async ({
  page,
}) => {
  test.skip(!isPhoneWidth(page), "the menu toggle exists below the lg breakpoint only");
  await page.goto("/security");
  const toggle = page.getByRole("button", { name: "Open menu" });
  await toggle.focus();
  await page.keyboard.press("Enter");

  const close = page.getByRole("button", { name: "Close menu" });
  await expect(close).toHaveAttribute("aria-expanded", "true");
  const sheet = page.locator(`[id="${await close.getAttribute("aria-controls")}"]`);
  await expect(sheet.getByRole("link").first()).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");

  const stops = (await sheet.getByRole("link").count()) + 2;
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => document.activeElement?.closest("header") !== null);
    expect(inside, `Tab ${i + 1} stays in the menu`).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
  await expect(sheet).toBeHidden();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
});

test("the Developers group opens from the keyboard and Escape returns focus", async ({ page }) => {
  test.skip(isPhoneWidth(page), "the desktop navigation shows from the lg breakpoint");
  await page.goto("/security");
  const developers = page.getByRole("button", { name: "Developers" });
  await developers.focus();
  await page.keyboard.press("Enter");
  await expect(developers).toHaveAttribute("aria-expanded", "true");
  const panel = page.locator(`[id="${await developers.getAttribute("aria-controls")}"]`);
  await page.keyboard.press("Tab");
  await expect(panel.getByRole("link", { name: "API keys" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(developers).toBeFocused();
  await expect(developers).toHaveAttribute("aria-expanded", "false");
});

for (const width of [360, 320]) {
  test(`at ${width}px the hero input spans the column and the header keeps Open the app`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "phone",
      "the phone layout is checked from the phone project"
    );
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    const input = page.getByRole("textbox", { name: "Stellar account address" });
    const submit = page.getByRole("button", { name: "Analyze account" });
    const [field, button] = [await input.boundingBox(), await submit.boundingBox()];
    expect(field && button).toBeTruthy();
    expect(button!.y).toBeGreaterThan(field!.y + field!.height - 1);
    expect(field!.width).toBeGreaterThan(width - 80);

    const header = page.getByRole("banner");
    await expect(header.getByRole("link", { name: "Open the app" })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width
    );
  });
}

test("screenshots of landing, security and a 404 at 1280, 360 and 320", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one run captures every width");
  for (const width of [1280, 360, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, path] of [
      ["landing", "/"],
      ["security", "/security"],
      ["404", "/no-such-page"],
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
        `${name} at ${width}px has no horizontal scroll`
      ).toBeLessThanOrEqual(width);
      await testInfo.attach(`${name}-${width}`, {
        body: await page.screenshot({ fullPage: name !== "landing" }),
        contentType: "image/png",
      });
    }
  }
});
