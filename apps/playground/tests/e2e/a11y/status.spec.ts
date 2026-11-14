import { expect, test } from "@playwright/test";
import { appAlerts } from "../alerts";
import { expectNoAxeViolations } from "./axe";
import { SESSION_ID, answerRoutes, runSetup } from "./fixtures";

// What a screen reader is told, and the countdown's warning, extension and end.

const liveStatus = (page: import("@playwright/test").Page) =>
  page.locator('[role="status"][aria-live="polite"]:not(next-route-announcer *)');

test("the polite status region is empty on load, then announces each setup step", async ({
  page,
}) => {
  const routes = await answerRoutes(page);
  let release = (): void => {};
  const held = new Promise<void>((r) => (release = r));
  routes.set(`/session/${SESSION_ID}/mess`, async () => {
    await held;
    return { status: 200, body: { txHash: null } };
  });
  await page.goto("/");
  await expect(liveStatus(page)).toHaveCount(1);
  await expect(liveStatus(page)).toHaveText("");
  await page.getByRole("button", { name: "Create & trash a demo account" }).click();
  await expect(liveStatus(page)).toContainText("step 1 of 3");
  release();
  routes.expectAllAnswered();
});

test("five minutes before the end it warns once and offers one extension", async ({ page }) => {
  const routes = await answerRoutes(page, 4);
  routes.set(`/session/${SESSION_ID}/extend`, () => ({
    status: 200,
    body: { expiresAt: Date.now() + 34 * 60_000, extended: true },
  }));
  await page.goto("/");
  await runSetup(page);
  await expect(liveStatus(page)).toContainText("Five minutes left");
  await expectNoAxeViolations(page, "warning");
  await page.getByRole("button", { name: /Add 30 minutes/ }).click();
  await expect(page.getByRole("button", { name: /Add 30 minutes/ })).toHaveCount(0);
  await expect(page.getByText(/Session ends in 3\d:/)).toBeVisible();
  routes.expectAllAnswered();
});

test("once time is up the key is withheld and the close is still offered", async ({ page }) => {
  const routes = await answerRoutes(page, -1);
  await page.goto("/");
  await runSetup(page);
  await expect(page.getByRole("button", { name: "Try the demolish flow yourself" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Demolish it here" })).toBeEnabled();
  await expectNoAxeViolations(page, "time up");
  routes.expectAllAnswered();
});

test("a setup step refused for time offers to close what was created", async ({ page }) => {
  const routes = await answerRoutes(page);
  routes.set(`/session/${SESSION_ID}/mess`, () => ({
    status: 410,
    body: { error: "session_expired" },
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "Create & trash a demo account" }).click();
  await expect(appAlerts(page)).toContainText("the demo account will be reclaimed");
  await expect(page.getByRole("button", { name: "Close the demo account now" })).toBeVisible();
  await expectNoAxeViolations(page, "expired");
  routes.expectAllAnswered();
});
