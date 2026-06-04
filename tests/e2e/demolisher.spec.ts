import { test, expect } from "@playwright/test";

test("old /public route redirects to /mainnet", async ({ page }) => {
  await page.goto("/public");
  await expect(page).toHaveURL(/\/mainnet/);
});

test("home page renders the entry form and headline", async ({ page }) => {
  await page.goto("/testnet");
  await expect(page.getByText("Wind down your Stellar account")).toBeVisible();
  await expect(page.getByText("Account details")).toBeVisible();
  await expect(page.getByText("Non-custodial")).toBeVisible();
});

test("Analyze button is disabled until all inputs are valid", async ({ page }) => {
  await page.goto("/testnet");
  const button = page.getByRole("button", { name: /Analyze account/i });
  await expect(button).toBeDisabled();
});

test("same source and destination shows warning and keeps button disabled", async ({ page }) => {
  await page.goto("/testnet");

  const address = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

  await page.getByPlaceholder(/G\.\.\. \(the account to merge\)/).fill(address);
  await page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/).fill(address);

  await expect(page.getByText(/Source and destination are the same/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /Analyze account/i })).toBeDisabled();
});

test("testnet page shows testnet badge in navbar", async ({ page }) => {
  await page.goto("/testnet");
  await expect(page.locator("header")).toContainText(/testnet/i);
});

test("mainnet page shows mainnet badge in navbar", async ({ page }) => {
  await page.goto("/mainnet");
  await expect(page.locator("header")).toContainText(/mainnet/i);
});

test("irreversible warning is visible on home page", async ({ page }) => {
  await page.goto("/testnet");
  await expect(page.getByText(/Irreversible action/i)).toBeVisible();
});

test("analyze page redirects to home when no source param", async ({ page }) => {
  await page.goto("/testnet/analyze");
  await expect(page).toHaveURL(/\/testnet$/);
});

test("source address input rejects invalid input visually", async ({ page }) => {
  await page.goto("/testnet");

  const sourceInput = page.getByPlaceholder(/G\.\.\. \(the account to merge\)/);
  await sourceInput.fill("NOTANADDRESS");

  const button = page.getByRole("button", { name: /Analyze account/i });
  await expect(button).toBeDisabled();
});

test("exchange destination shows memo field requirement", async ({ page }) => {
  await page.goto("/testnet");

  // Coinbase Deposits address - verified in Stellar Expert directory as coinbase.com, memo-required
  const coinbaseAddress = "GB5CLRWUCBQ6DFK2LR5ZMWJ7QCVEB3XKMPTQUYCDIYB4DRZJBEW6M26D";
  await page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/).fill(coinbaseAddress);

  // Memo field or exchange name should appear
  await expect(page.getByText(/memo/i)).toBeVisible();
});
