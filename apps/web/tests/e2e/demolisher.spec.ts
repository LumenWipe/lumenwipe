import { test, expect, type Page } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { confirmDestinationControl } from "./helpers/destination";
import { dismissRiskModal, enterSourceAddress, openTestnetHome } from "./helpers/flow";

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

  await page.goto("/testnet");

  // A risk-disclaimer modal blocks the page on the first visit of a session and
  // intercepts pointer events until accepted. It animates in after load, so wait for
  // it to mount before checking, then wait for it to detach before driving the form -
  // an instant visibility check races the mount and leaves the overlay intercepting clicks.
  const acceptRisk = page.getByRole("button", { name: /I understand, continue/i });
  await acceptRisk.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if (await acceptRisk.isVisible().catch(() => false)) {
    await acceptRisk.click();
    await acceptRisk.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  }

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

test("old /public route redirects to /mainnet", async ({ page }) => {
  await page.goto("/public");
  await expect(page).toHaveURL(/\/mainnet/);
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
  await expect(page).toHaveURL(/\/testnet$/);
});

test("source address input rejects invalid input visually", async ({ page }) => {
  await openTestnetHome(page);
  await enterSourceAddress(page, "NOTANADDRESS");

  const button = page.getByRole("button", { name: /Analyze account/i });
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
