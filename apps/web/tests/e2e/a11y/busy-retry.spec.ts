import { expect, test } from "@playwright/test";
import { enterSourceAddress, openTestnetHome } from "../helpers/flow";
import { expectNoAxeViolations } from "./axe";
import { BUSY_ACCOUNT, BUSY_ONCE_ACCOUNT, installApiFixtures } from "./fixtures";

let api: Awaited<ReturnType<typeof installApiFixtures>>;

test.beforeEach(async ({ page }) => {
  api = await installApiFixtures(page);
});

test.afterEach(() => api.expectAllAnswered());

async function analyze(page: Parameters<typeof openTestnetHome>[0], source: string) {
  await openTestnetHome(page);
  await enterSourceAddress(page, source);
  await page.getByRole("button", { name: /Analyze account/i }).click();
  await expect(page).toHaveURL(/\/testnet\/analyze/);
}

test("a busy analysis waits with a notice that can be stopped, then offers a retry", async ({
  page,
}) => {
  await analyze(page, BUSY_ACCOUNT);
  const notice = page.getByTestId("busy-retry");
  await expect(notice).toContainText("will try again on its own in about 30 seconds");
  await expectNoAxeViolations(page, "analyze, waiting on a busy service");

  await page.getByRole("button", { name: "Stop waiting" }).click();
  await expect(notice).toBeHidden();
  await expect(page.getByRole("alert").filter({ hasText: "Analysis failed" })).toContainText(
    "Try again in about 30 seconds."
  );
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expectNoAxeViolations(page, "analyze, busy service");
});

test("an analysis that is busy once finishes on its own", async ({ page }) => {
  await analyze(page, BUSY_ONCE_ACCOUNT);
  await expect(
    page.getByRole("heading", { level: 1, name: "Decide what happens to each item" })
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
});
