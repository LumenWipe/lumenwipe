import { test, expect } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  enterDestinationAndBegin,
  enterSecretKey,
  enterSourceAndAnalyze,
  expectSigningPanel,
} from "./helpers/flow";

// The confirmation is lost after the transaction reached the network: the submit goes through
// for real, and the browser is told the connection dropped. The screen has to reach completion
// on the idempotent resend, showing no error on the way.
//
// Testnet only, per repo rules.

const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";

async function fund(pub: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`friendbot ${res.status}: ${await res.text()}`);
}

test("a confirmation lost after the send still reaches the completed state", async ({ page }) => {
  test.setTimeout(240_000);

  const source = Keypair.random();
  const destination = Keypair.random();
  await fund(source.publicKey());
  await fund(destination.publicKey());

  let submits = 0;
  await page.route("**/api/v1/testnet/submit", async (route) => {
    submits++;
    if (submits > 1) return route.continue();
    await route.fetch();
    await route.abort("connectionreset");
  });

  await enterSourceAndAnalyze(page, source.publicKey());
  await enterDestinationAndBegin(page, destination.publicKey());
  await expectSigningPanel(page);
  await enterSecretKey(page, source.secret());
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /Sign & execute close/i }).click();

  await expect(page).toHaveURL(/\/testnet\/complete/, { timeout: 120_000 });
  expect(submits).toBeGreaterThan(1);
  await expect(page.getByText(/could not be completed|could not be confirmed/i)).toHaveCount(0);

  const merged = await fetch(`${HORIZON}/accounts/${source.publicKey()}`);
  expect(merged.status).toBe(404);
});
