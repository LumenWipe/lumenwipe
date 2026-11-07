import { expect, test } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { expectNoAxeViolations } from "./axe";
import { installApiFixtures } from "./fixtures";

const CAVEAT = "Estimate, not a promise: fees and market quotes change";

let api: Awaited<ReturnType<typeof installApiFixtures>>;

test.beforeEach(async ({ page }) => {
  api = await installApiFixtures(page);
});

test.afterEach(() => api.expectAllAnswered());

test("the landing estimate is reachable by keyboard, announced, and keeps the address out of URLs", async ({
  page,
}) => {
  const address = Keypair.random().publicKey();
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));

  await page.goto("/");
  await page.getByRole("textbox", { name: "Stellar account address" }).fill(address);
  const estimate = page.getByRole("button", { name: "Estimate recovery" });
  await estimate.focus();
  const asked = page.waitForRequest("**/api/mainnet/estimate");
  await page.keyboard.press("Enter");
  expect((await asked).postDataJSON()).toEqual({ address });

  const panel = page.getByRole("region", { name: "Recovery estimate" });
  await expect(panel.getByText("12.49 to 20.12 XLM")).toBeVisible();
  await expect(panel.getByText(CAVEAT)).toBeVisible();
  await expect(panel.getByText("1 item would block a close until resolved.")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Estimated recovery" })).toHaveCount(1);

  await expect(page).toHaveURL(/\/$/);
  expect(urls.filter((url) => url.includes(address))).toEqual([]);
  await expectNoAxeViolations(page, "home, recovery estimate");
});
