import { test, expect, type Page } from "@playwright/test";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

// Regression coverage for issue #73: "Begin execution" must land on the whole-plan review
// gate (/review), not skip straight into /execute, and nothing may be persisted to a
// resumable session until the user explicitly confirms on that page.
//
// Testnet only, per repo rules.

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const BASE_FEE = "1000";

async function fund(pub: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`friendbot ${res.status}: ${await res.text()}`);
}

async function loadSequence(id: string): Promise<string> {
  const res = await fetch(`${HORIZON}/accounts/${id}`);
  if (!res.ok) throw new Error(`load account ${id}: ${res.status}`);
  return ((await res.json()) as { sequence: string }).sequence;
}

async function submitOps(kp: Keypair, ops: ReturnType<typeof Operation.manageData>[]): Promise<void> {
  const builder = new TransactionBuilder(
    new Account(kp.publicKey(), await loadSequence(kp.publicKey())),
    { fee: BASE_FEE, networkPassphrase: PASSPHRASE }
  ).setTimeout(120);
  ops.forEach((op) => builder.addOperation(op));
  const tx = builder.build();
  tx.sign(kp);
  const res = await fetch(`${HORIZON}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tx: tx.toEnvelope().toXDR("base64") }),
  });
  const body = (await res.json()) as { successful?: boolean; extras?: { result_codes?: unknown } };
  if (!res.ok || !body.successful) {
    throw new Error(`tx failed: ${JSON.stringify(body.extras?.result_codes ?? body)}`);
  }
}

async function accountExists(id: string): Promise<boolean> {
  const res = await fetch(`${HORIZON}/accounts/${id}`);
  return res.status !== 404;
}

// friendbot's 200 response lands before the account is reliably visible to every read
// path the app hits (RPC, stellar.expert); wait for Horizon to see it before driving
// the UI, or "Analyze account" can 404 on an account that funded a moment ago.
async function waitUntilIndexed(id: string, attempts = 10, delayMs = 1_500): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await accountExists(id)) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`account ${id} was not indexed in time`);
}

async function dismissRiskModal(page: Page): Promise<void> {
  const acceptRisk = page.getByRole("button", { name: /I understand, continue/i });
  if (await acceptRisk.isVisible().catch(() => false)) {
    await acceptRisk.click();
  }
}

// Drives home -> analyze -> fills destination -> clicks "Begin execution", stopping the
// instant navigation happens - never confirms the review page.
async function reachReviewWithoutConfirming(
  page: Page,
  source: Keypair,
  destination: string
): Promise<void> {
  await page.goto("/testnet");
  await dismissRiskModal(page);

  await page.getByPlaceholder(/G\.\.\. \(the account to merge\)/).fill(source.publicKey());
  const analyzeButton = page.getByRole("button", { name: /Analyze account/i });
  await expect(analyzeButton).toBeEnabled();
  await analyzeButton.click();
  await expect(page).toHaveURL(/\/testnet\/analyze/, { timeout: 30_000 });

  const beginButton = page.getByRole("button", { name: /Begin execution/i });
  await expect(beginButton).toBeVisible({ timeout: 30_000 });
  await page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/).fill(destination);
  await expect(beginButton).toBeEnabled();
  await beginButton.click();
}

test("begin execution lands on the review gate, not directly on execute", async ({ page }) => {
  test.setTimeout(120_000);

  const source = Keypair.random();
  const destination = Keypair.random();
  await fund(source.publicKey());
  await fund(destination.publicKey());
  await waitUntilIndexed(source.publicKey());
  await submitOps(source, [Operation.manageData({ name: "lw-e2e-review", value: "1" })]);

  await reachReviewWithoutConfirming(page, source, destination.publicKey());

  await expect(page).toHaveURL(/\/testnet\/review/);
  await expect(page.getByRole("heading", { name: /Review the full plan/i })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /I understand this plan and want to proceed/i })
  ).toBeVisible();

  // The account was never touched - the gate is client-side and read-only.
  expect(await accountExists(source.publicKey())).toBe(true);
});

test("no resumable session is persisted while sitting on the review gate", async ({ page }) => {
  test.setTimeout(120_000);

  const source = Keypair.random();
  const destination = Keypair.random();
  await fund(source.publicKey());
  await fund(destination.publicKey());
  await waitUntilIndexed(source.publicKey());
  await submitOps(source, [Operation.manageData({ name: "lw-e2e-review-2", value: "1" })]);

  await reachReviewWithoutConfirming(page, source, destination.publicKey());
  await expect(page).toHaveURL(/\/testnet\/review/);

  // Simulate closing the tab before confirming, then reopening at home - where the
  // resumable-session recovery banner actually renders (not on /analyze).
  await page.goto("/testnet");

  await expect(page.getByText(/In-progress account merge found/i)).toHaveCount(0);
});
