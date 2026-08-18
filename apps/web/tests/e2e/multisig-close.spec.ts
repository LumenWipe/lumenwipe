import { test, expect, type Page } from "@playwright/test";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { confirmDestinationControl } from "./helpers/destination";

// E2E coverage for "the multisig path" - named as an explicit target in
// docs/architecture.md §17 and never previously exercised end to end. Configures a real
// 2-of-3 testnet account, then drives the UI through both signing rounds using the
// secret-key path for both signers (no wallet browser extension is installable in
// Playwright's CI environment; the secret-key tab exercises the identical
// accumulate-then-switch-signer code path a connected wallet would).

const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;

async function fund(pub: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`friendbot ${res.status}: ${await res.text()}`);
}

async function accountExists(id: string): Promise<boolean> {
  const res = await fetch(`${HORIZON}/accounts/${id}`);
  return res.status !== 404;
}

// The UI (via the API's read provider) can lag the Horizon endpoint the configuring
// transaction below is confirmed against - the same ingestion-lag hazard the sibling
// integration test's readAccountStateUntilSignersConfigured absorbs for its own
// (different) read path. Poll Horizon's own /accounts/:id here since that's the provider
// configureTwoOfThree just wrote through, before ever driving the UI.
const SIGNERS_POLL_MAX_ATTEMPTS = 8;
const SIGNERS_POLL_DELAY_MS = 2500;

async function waitForThreeSigners(id: string): Promise<void> {
  for (let attempt = 0; attempt < SIGNERS_POLL_MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${HORIZON}/accounts/${id}`);
    if (res.ok) {
      const account = (await res.json()) as { signers: unknown[] };
      if (account.signers.length === 3) return;
    }
    await new Promise((resolve) => setTimeout(resolve, SIGNERS_POLL_DELAY_MS));
  }
  throw new Error(`timed out waiting for ${id} to show 3 signers on ${HORIZON}`);
}

async function configureTwoOfThree(master: Keypair, coSignerB: Keypair, coSignerC: Keypair) {
  const res = await fetch(`${HORIZON}/accounts/${master.publicKey()}`);
  const { sequence } = (await res.json()) as { sequence: string };
  const tx = new TransactionBuilder(new Account(master.publicKey(), sequence), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.setOptions({ signer: { ed25519PublicKey: coSignerB.publicKey(), weight: 1 } })
    )
    .addOperation(
      Operation.setOptions({ signer: { ed25519PublicKey: coSignerC.publicKey(), weight: 1 } })
    )
    .addOperation(Operation.setOptions({ lowThreshold: 1, medThreshold: 2, highThreshold: 2 }))
    .setTimeout(60)
    .build();
  tx.sign(master);
  const submitRes = await fetch(`${HORIZON}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tx: tx.toEnvelope().toXDR("base64") }),
  });
  if (!submitRes.ok) {
    throw new Error(
      `configureTwoOfThree submission failed ${submitRes.status}: ${await submitRes.text()}`
    );
  }
  await waitForThreeSigners(master.publicKey());
}

test("multisig close: a 2-of-3 account signs with two keys in sequence and merges", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const master = Keypair.random();
  const coSignerB = Keypair.random();
  const coSignerC = Keypair.random();
  const destination = Keypair.random();

  await fund(master.publicKey());
  await fund(destination.publicKey());
  await configureTwoOfThree(master, coSignerB, coSignerC);

  expect(await accountExists(master.publicKey())).toBe(true);

  await driveToExecute(page, { source: master.publicKey(), destination: destination.publicKey() });

  // Round 1: sign with the master key alone (weight 1) - insufficient for the high
  // threshold (2) this fused merge needs. ExecutionWizard defaults to the "Connect
  // wallet" tab, so the secret-key tab must be selected explicitly before its "S..."
  // input exists in the DOM (ExecutionWizard.tsx renderSignerPicker, ~L211-269).
  await page.getByRole("button", { name: /Use secret key \(advanced\)/i }).click();
  await page.getByPlaceholder("S...").fill(master.secret());
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /Sign .* execute close/i }).click();

  // The signing-progress panel appears instead of completion - this account needs a
  // second signer (SigningProgress.tsx L52-55: "needs N more signing weight").
  await expect(page.getByText(/more signing weight/i)).toBeVisible({ timeout: 30_000 });

  // Round 2: swap to the second co-signer via the secret-key tab's "Forget key" control,
  // then add its signature. The signer picker stays on the secret-key tab (mode is
  // unchanged by forgetKey()), so the "S..." input reappears without reselecting the tab.
  await page.getByRole("button", { name: /Forget key/i }).click();
  await page.getByPlaceholder("S...").fill(coSignerB.secret());
  await page.getByRole("button", { name: /Add signature/i }).click();

  await expect(page).toHaveURL(/\/testnet\/complete/, { timeout: 90_000 });

  expect(await accountExists(master.publicKey())).toBe(false);
});

// Mirrors fast-path-close.spec.ts's driveFusedClose through the review gate, stopping
// short of signing (this test drives two separate signing rounds itself).
async function driveToExecute(
  page: Page,
  opts: { source: string; destination: string }
): Promise<void> {
  await page.goto("/testnet");

  const acceptRisk = page.getByRole("button", { name: /I understand, continue/i });
  if (await acceptRisk.isVisible().catch(() => false)) {
    await acceptRisk.click();
  }

  // AccountEntryForm defaults to the "Connect wallet" tab (AccountEntryForm.tsx L22);
  // the "Paste address" tab must be selected explicitly before its "G..." input exists.
  await page.getByRole("button", { name: /Paste address/i }).click();
  await page.getByPlaceholder(/G\.\.\. \(the account to merge\)/).fill(opts.source);
  const analyzeButton = page.getByRole("button", { name: /Analyze account/i });
  await expect(analyzeButton).toBeEnabled();
  await analyzeButton.click();
  await expect(page).toHaveURL(/\/testnet\/analyze/, { timeout: 30_000 });

  const beginButton = page.getByRole("button", { name: /Begin execution/i });
  await expect(beginButton).toBeVisible({ timeout: 30_000 });
  await page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/).fill(opts.destination);
  await confirmDestinationControl(page);
  await expect(beginButton).toBeEnabled();
  await beginButton.click();

  await expect(page).toHaveURL(/\/testnet\/review/);
  const proceedButton = page.getByRole("button", {
    name: /I understand this plan and want to proceed/i,
  });
  await page.getByRole("checkbox").check();
  await expect(proceedButton).toBeEnabled();
  await proceedButton.click();

  await expect(page).toHaveURL(/\/testnet\/execute/);
  // ExecutionWizard's own panel heading ("Executing plan" is the page-level h1;
  // this h2 confirms the sign-and-execute panel itself has mounted - see
  // ExecutionWizard.tsx L286).
  await expect(page.getByRole("heading", { name: /Sign .* execute the close/i })).toBeVisible({
    timeout: 30_000,
  });
}
