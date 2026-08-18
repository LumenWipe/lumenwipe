import { test, expect, type Page } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { confirmDestinationControl } from "./helpers/destination";
import { enterSourceAddress, openTestnetHome, TESTNET_STEP_TIMEOUT } from "./helpers/flow";

const FRIENDBOT = "https://friendbot.stellar.org";

async function fund(pub: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`friendbot ${res.status}: ${await res.text()}`);
}

// The same-address warning and the exchange memo requirement now live on the
// late-destination step (DestinationInput in PlanView), reached after analyzing a
// real account. A plain freshly-funded account holds no trustlines/offers, so every
// asset is "resolved" immediately and the destination step renders right away.
async function analyzeFreshAccountToDestinationStep(page: Page): Promise<string> {
  const source = Keypair.random();
  await fund(source.publicKey());

  await openTestnetHome(page);

  await enterSourceAddress(page, source.publicKey());

  const analyzeButton = page.getByRole("button", { name: /Analyze account/i });
  await expect(analyzeButton).toBeEnabled();
  await analyzeButton.click();

  await expect(page).toHaveURL(/\/testnet\/analyze/, { timeout: 30_000 });

  // The destination step is present once assets are resolved.
  await expect(page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/)).toBeVisible({
    timeout: 30_000,
  });

  return source.publicKey();
}

// Both redirect assertions wait on a route being reached for the first time, which under
// `next dev` includes compiling it. That is a build step, not a rendered-DOM check, so the 5s
// default is a coin flip on ordering: whichever test happens to touch the route first pays the
// compile and the others do not.
test("old /public route redirects to /mainnet", async ({ page }) => {
  await page.goto("/public");
  await expect(page).toHaveURL(/\/mainnet/, { timeout: TESTNET_STEP_TIMEOUT });
});

test("home page renders the entry form and headline", async ({ page }) => {
  await page.goto("/testnet");
  await expect(page.getByText("Wind down your Stellar account")).toBeVisible();
  await expect(page.getByText("Account details")).toBeVisible();
  // "Non-custodial" appears both in the hero badge and a feature card; assert the
  // unambiguous badge copy to avoid a strict-mode multiple-match.
  await expect(page.getByText("Non-custodial · Client-side signing only")).toBeVisible();
});

test("Analyze button is disabled until all inputs are valid", async ({ page }) => {
  await page.goto("/testnet");
  const button = page.getByRole("button", { name: /Analyze account/i });
  await expect(button).toBeDisabled();
});

test("same source and destination shows warning and keeps the begin button disabled", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const address = await analyzeFreshAccountToDestinationStep(page);

  // Entering the source account as its own destination must surface the warning
  // and keep "Begin execution" disabled.
  await page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/).fill(address);
  await confirmDestinationControl(page);

  await expect(page.getByText(/Source and destination are the same/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /Begin execution/i })).toBeDisabled();
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
  await expect(page).toHaveURL(/\/testnet$/, { timeout: TESTNET_STEP_TIMEOUT });
});

test("source address input rejects invalid input visually", async ({ page }) => {
  await openTestnetHome(page);
  const button = page.getByRole("button", { name: /Analyze account/i });

  // Assert the enabled state first. "Disabled" is also what an empty field, a mistargeted
  // fill, or a deleted validator produce, so without a positive control this test passes no
  // matter what the validator does.
  await enterSourceAddress(page, Keypair.random().publicKey());
  await expect(button).toBeEnabled();

  await page.getByPlaceholder(/G\.\.\. \(the account to merge\)/).fill("NOTANADDRESS");
  await expect(button).toBeDisabled();
});

test("exchange destination shows memo field requirement", async ({ page }) => {
  test.setTimeout(120_000);
  await analyzeFreshAccountToDestinationStep(page);

  // Coinbase Deposits address - verified in Stellar Expert directory as coinbase.com, memo-required
  const coinbaseAddress = "GB5CLRWUCBQ6DFK2LR5ZMWJ7QCVEB3XKMPTQUYCDIYB4DRZJBEW6M26D";
  await page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/).fill(coinbaseAddress);

  // The registry-driven memo requirement should surface, and a registry address is never
  // asked to confirm control - the registry already knows what it is.
  await expect(page.getByText(/requires a .* memo/i)).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: /wallet I control, not an exchange/i })
  ).toHaveCount(0);
});
