import { expect, test } from "@playwright/test";
import { appAlerts } from "../alerts";
import { expectNoAxeViolations } from "./axe";
import { SECRET_PLACEHOLDER, SESSION_ID, answerRoutes, runSetup } from "./fixtures";

// Every screen the single-account demo passes through, checked with axe.

test("the start screen, with what the run will create", async ({ page }) => {
  const routes = await answerRoutes(page);
  await page.goto("/");
  await expect(page.getByRole("region", { name: "This will create on testnet" })).toBeVisible();
  await expectNoAxeViolations(page, "start");
  routes.expectAllAnswered();
});

test("a set-up demo with its live state and revealed key", async ({ page }) => {
  const routes = await answerRoutes(page);
  await page.goto("/");
  await runSetup(page);
  await expect(page.getByRole("region", { name: "Demo account right now" })).toBeVisible();
  await page.getByRole("button", { name: "Try the demolish flow yourself" }).click();
  await page.getByRole("button", { name: "Reveal the secret key" }).click();
  await expect(page.getByText(SECRET_PLACEHOLDER)).toBeVisible();
  await expectNoAxeViolations(page, "set up");
  routes.expectAllAnswered();
});

test("a finished demo", async ({ page }) => {
  const routes = await answerRoutes(page);
  await page.goto("/");
  await runSetup(page);
  await page.getByRole("button", { name: "Demolish it here" }).click();
  await expect(page.getByText(/demo complete/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Receipt" }).getByText("9999.5 XLM")).toBeVisible();
  await expectNoAxeViolations(page, "complete");
  routes.expectAllAnswered();
});

test("a key request that fails says why", async ({ page }) => {
  const routes = await answerRoutes(page);
  routes.set(`/session/${SESSION_ID}/credentials`, () => ({
    status: 429,
    body: { error: "rate_limited" },
  }));
  await page.goto("/");
  await runSetup(page);
  await page.getByRole("button", { name: "Try the demolish flow yourself" }).click();
  await expect(appAlerts(page)).toContainText("fetched demo keys too many times");
  await expectNoAxeViolations(page, "key refused");
  routes.expectAllAnswered();
});
