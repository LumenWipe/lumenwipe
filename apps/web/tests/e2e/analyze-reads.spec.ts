import { test, expect, type Page } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { enterSourceAndAnalyze, TESTNET_STEP_TIMEOUT } from "./helpers/flow";

// Reads a throwaway friendbot account and submits nothing.
const FRIENDBOT = "https://friendbot.stellar.org";

function countRequests(page: Page, path: string): () => number {
  let count = 0;
  page.on("request", (req) => {
    if (new URL(req.url()).pathname.startsWith(path)) count++;
  });
  return () => count;
}

test("one analysis reads the account exactly once", async ({ page }) => {
  test.setTimeout(TESTNET_STEP_TIMEOUT * 2);
  const source = Keypair.random();
  const funded = await fetch(`${FRIENDBOT}/?addr=${source.publicKey()}`);
  expect(funded.ok).toBe(true);

  const accountReads = countRequests(page, "/api/testnet/account/");
  const planRequests = countRequests(page, "/api/v1/testnet/close/plan");

  await enterSourceAndAnalyze(page, source.publicKey());
  await expect(page.getByRole("button", { name: /Review the full plan/i })).toBeVisible({
    timeout: TESTNET_STEP_TIMEOUT,
  });

  expect(accountReads()).toBe(1);
  expect(planRequests()).toBe(1);
});
