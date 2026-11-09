import { expect, test, type Page, type Response } from "@playwright/test";

// A random wallet replayed from its code runs the same wallet twice, end to end on testnet: the
// same code and the same plan before each run, and the plan the browser previews is the one the
// server regenerates from the code (two JavaScript engines, one generator).

const BASE = "http://localhost:3002";
// One of the frozen v1 vectors (tests/fixtures/random-v1-vectors.json): the demo token alone, so
// each run is three setup transactions and one close.
const CODE = "LW1-J94RHBTC";

const isCreateSession = (res: Response): boolean => {
  const url = new URL(res.url());
  return (
    url.origin === BASE && url.pathname === "/api/session" && res.request().method() === "POST"
  );
};

async function previewSteps(page: Page): Promise<string[]> {
  return page.getByRole("list", { name: "Steps before the close" }).locator("li").allInnerTexts();
}

/** Runs the wallet on screen through the close; returns the request body and the server's plan. */
async function runOnce(page: Page): Promise<{ body: unknown; planLabels: string[] }> {
  const created = page.waitForResponse(isCreateSession, { timeout: 90_000 });
  await page.getByRole("button", { name: "Create & trash a demo account" }).click();
  const response = await created;
  expect(response.status()).toBe(200);
  const plan = ((await response.json()) as { messPlan: { label: string }[] }).messPlan;
  await page.getByRole("button", { name: "Demolish it here" }).click({ timeout: 6 * 60_000 });
  const summary = page.getByText("demo complete. The account was merged away");
  await expect(summary).toBeVisible({ timeout: 3 * 60_000 });
  await expect(page.getByText(`Replay code ${CODE}`)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  return { body: response.request().postDataJSON(), planLabels: plan.map((s) => s.label) };
}

test("a replay code runs the same wallet twice", async ({ page }) => {
  test.setTimeout(15 * 60_000);
  await page.goto("/");

  await page.getByLabel("Replay a seed").fill(CODE);
  await page.getByRole("button", { name: "Replay", exact: true }).click();
  await expect(page.getByText(CODE, { exact: true })).toBeVisible();
  const firstPreview = await previewSteps(page);
  expect(firstPreview.length).toBeGreaterThan(0);

  const first = await runOnce(page);
  expect(first.body).toEqual({ seed: CODE });
  expect(first.planLabels).toEqual(firstPreview);

  await page.getByRole("button", { name: "Choose different scenarios" }).click();
  await expect(page.getByText(CODE, { exact: true })).toBeVisible();
  expect(await previewSteps(page)).toEqual(firstPreview);

  const second = await runOnce(page);
  expect(second).toEqual(first);
});
