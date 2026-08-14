import { test, expect, type Page } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";

// Regression coverage for issue #115: the exchange registry used to fail open. An address it
// did not recognize was treated as a personal wallet, so the close built a direct
// ACCOUNT_MERGE into it. Merging into an exchange deposit address is unrecoverable - exchanges
// credit payments carrying a memo and cannot credit a merge - and it fails silently: the
// transaction succeeds, and the source account no longer exists to investigate from.
//
// The registry holds a curated set of deposit addresses, so absence proves nothing. These tests
// pin the resulting rule: an unrecognized destination cannot reach execution until the user
// confirms they control it, and a recognized one is never asked.
//
// Testnet only, per repo rules.

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";

// A registry entry, so the confirmation must not appear for it. It also requires a memo, which
// is what the destination panel asks for instead.
const REGISTRY_EXCHANGE = "GB5CLRWUCBQ6DFK2LR5ZMWJ7QCVEB3XKMPTQUYCDIYB4DRZJBEW6M26D";

async function fund(pub: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`friendbot ${res.status}: ${await res.text()}`);
}

// friendbot's 200 lands before the account is reliably visible to every read path the app
// hits, so wait for Horizon to see it before driving the UI.
async function waitUntilIndexed(id: string, attempts = 10, delayMs = 1_500): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    // Only a genuine 200 means indexed. Treating any non-404 as success reads a Horizon
    // 429 or 500 as "ready" and pushes the resulting failure onto whatever the spec asserts next.
    const res = await fetch(`${HORIZON}/accounts/${id}`);
    if (res.ok) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`account ${id} was not indexed in time`);
}

async function dismissRiskModal(page: Page): Promise<void> {
  const acceptRisk = page.getByRole("button", { name: /I understand, continue/i });
  // The notice renders after hydration, so a bare isVisible() check can run before it exists
  // and leave the overlay silently intercepting clicks on the form beneath it. Wait for it,
  // then wait for it to go away, rather than racing it.
  await acceptRisk.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if (await acceptRisk.isVisible().catch(() => false)) {
    await acceptRisk.click();
    await acceptRisk.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  }
}

// Drives home -> analyze and stops at the destination panel, without entering a destination.
async function reachDestinationStep(page: Page, source: Keypair): Promise<void> {
  await page.goto("/testnet");
  await dismissRiskModal(page);

  // Connecting a wallet is the primary path since #95, so the raw address field is behind
  // "Paste address". These tests drive an address only - they never sign anything.
  await page.getByRole("button", { name: /Paste address/i }).click();
  await page.getByPlaceholder(/G\.\.\. \(the account to merge\)/).fill(source.publicKey());
  const analyzeButton = page.getByRole("button", { name: /Analyze account/i });
  await expect(analyzeButton).toBeEnabled();
  await analyzeButton.click();
  await expect(page).toHaveURL(/\/testnet\/analyze/, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: /Begin execution/i })).toBeVisible({
    timeout: 30_000,
  });
}

const confirmationCheckbox = (page: Page) =>
  page.getByRole("checkbox", {
    name: /wallet I control, not an exchange or custodial account/i,
  });

test("an unrecognized destination blocks execution until control is confirmed", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const source = Keypair.random();
  const destination = Keypair.random();
  await fund(source.publicKey());
  await waitUntilIndexed(source.publicKey());

  await reachDestinationStep(page, source);

  const beginButton = page.getByRole("button", { name: /Begin execution/i });
  await page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/).fill(destination.publicKey());

  // The warning states the actual risk, not a generic "double-check the address", and does not
  // misdescribe the product: LumenWipe does route recognized exchanges through the mediator, so
  // the manual fallback is advice for this address only, not how exchanges work in general.
  await expect(page.getByText(/don't recognize this address/i)).toBeVisible();
  await expect(page.getByText(/loses the funds/i)).toBeVisible();
  await expect(page.getByText(/exchanges it recognizes/i)).toBeVisible();

  // This is the regression: before the fix the flow proceeded with no confirmation at all.
  await expect(beginButton).toBeDisabled();

  await confirmationCheckbox(page).check();
  await expect(beginButton).toBeEnabled();
});

// The confirmation is recorded against the address it was given for, not as a boolean, so it
// cannot be inherited by a destination the user never vouched for. A boolean would silently
// carry consent from one address to the next - a quieter version of the bug being fixed.
test("editing the destination revokes a confirmation given for the previous address", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const source = Keypair.random();
  const first = Keypair.random();
  const second = Keypair.random();
  await fund(source.publicKey());
  await waitUntilIndexed(source.publicKey());

  await reachDestinationStep(page, source);

  const beginButton = page.getByRole("button", { name: /Begin execution/i });
  const destinationInput = page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/);

  await destinationInput.fill(first.publicKey());
  await confirmationCheckbox(page).check();
  await expect(beginButton).toBeEnabled();

  await destinationInput.fill(second.publicKey());

  await expect(confirmationCheckbox(page)).not.toBeChecked();
  await expect(beginButton).toBeDisabled();
});

test("a registry exchange destination is never asked to confirm control", async ({ page }) => {
  test.setTimeout(120_000);

  const source = Keypair.random();
  await fund(source.publicKey());
  await waitUntilIndexed(source.publicKey());

  await reachDestinationStep(page, source);

  await page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/).fill(REGISTRY_EXCHANGE);

  await expect(confirmationCheckbox(page)).toHaveCount(0);
  await expect(page.getByText(/don't recognize this address/i)).toHaveCount(0);
  // It asks for the deposit memo instead, which is the registry knowing what this address is.
  await expect(page.getByText(/requires a text memo/i)).toBeVisible();
});
