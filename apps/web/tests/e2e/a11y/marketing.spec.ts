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

test("the home page carries no noindex", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
});

for (const path of [
  "/faq",
  "/security",
  "/registry",
  "/content",
  "/blog/how-do-i-remove-a-trustline-on-stellar",
  "/blog/phase-1-launch",
]) {
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
    const robots = page.locator('meta[name="robots"]');
    await expect(robots).toHaveCount(1);
    await expect(robots).toHaveAttribute("content", /noindex/);
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    const next = page.getByRole("navigation", { name: "Where to go next" });
    for (const link of ["Guides", "How it works", "Try the playground", /Report a broken link/]) {
      await expect(next.getByRole("link", { name: link })).toBeVisible();
    }
    await expectNoAxeViolations(page, name);
  });
}

test("the registry shows the API's copy through the web's proxy route", async ({ page }) => {
  await page.route("**/api/config/exchange-registry", (route) =>
    route.fulfill({
      json: {
        lastVerified: "2026-11-01",
        validUntil: "2026-12-01",
        entries: [
          {
            address: "GB5CLRWUCBQ6DFK2LR5ZMWJ7QCVEB3XKMPTQUYCDIYB4DRZJBEW6M26D",
            name: "Coinbase",
            domain: "coinbase.com",
            requiresMediator: true,
            requiresMemo: true,
            memoType: "text",
          },
        ],
      },
    })
  );
  await page.goto("/registry");
  await expect(page.getByText("Shown: the API's copy, read when this page loaded.")).toBeVisible();
  await expect(page.getByText("Last checked 2026-11-01", { exact: false })).toBeVisible();
});

test("the prerendered registry says it is not current once its validUntil has passed", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2099-01-01T00:00:00Z"));
  await page.goto("/registry");
  await expect(page.getByText(/This list is past .* so it is not current/)).toBeVisible();
  await expect(page.getByText(/contract list is past .* not current/)).toBeVisible();
  await expect(page.getByText("Current.", { exact: true })).toHaveCount(0);
});

test("the content hub lists published and planned articles in a table", async ({ page }) => {
  await page.goto("/content");
  const table = page.getByRole("table", { name: "Published and planned articles" });
  await expect(table.getByRole("cell", { name: "Planned" }).first()).toBeVisible();
  await expect(table.getByRole("cell", { name: "Published" }).first()).toBeVisible();
});

const YOUTUBE_HOSTS =
  /^https:\/\/(?:[^/]*\.)?(?:youtube(?:-nocookie)?\.com|ytimg\.com|googlevideo\.com)\//;

for (const [path, title] of [
  ["/content", "What is LumenWipe?"],
  ["/blog/phase-1-launch", "LumenWipe walkthrough: closing a Stellar account"],
]) {
  test(`${path} asks YouTube for nothing until play is pressed, then focuses the player`, async ({
    page,
  }) => {
    const requested: string[] = [];
    page.on("request", (request) => {
      if (YOUTUBE_HOSTS.test(request.url())) requested.push(request.url());
    });
    await page.route(YOUTUBE_HOSTS, (route) => route.abort());
    await page.goto(path);
    const play = page.getByRole("button", { name: `Play video: ${title}` });
    await play.scrollIntoViewIfNeeded();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(requested, "requests to YouTube before play").toEqual([]);

    await play.click();
    const player = page.locator(`iframe[title="${title}"]`);
    await expect(player).toBeFocused();
    expect(new URL((await player.getAttribute("src")) ?? "").origin).toBe(
      "https://www.youtube-nocookie.com"
    );
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
