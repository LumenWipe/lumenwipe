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
import {
  CLOSE_FINISHED_URL,
  enterSecretKey,
  enterSourceAddress,
  expectSigningPanel,
  openTestnetHome,
  TESTNET_STEP_TIMEOUT,
} from "./helpers/flow";
import { connectStubWallet, installWalletStub } from "./helpers/wallet-stub";

// E2E coverage for "the multisig path" - named as an explicit target in
// docs/architecture.md §17 and never previously exercised end to end. Configures a real
// 2-of-3 testnet account, then drives the UI through the close: no single key reaches the
// thresholds, so the first transaction is the signer normalization alone (two keys), and the
// merge follows under the master key alone. The first test uses the secret-key path for every
// signer (no wallet browser extension is installable in Playwright's CI environment; the
// secret-key tab exercises the identical accumulate-then-switch-signer code path a connected
// wallet would).

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
    body: new URLSearchParams({ tx: tx.toEnvelope().toXdr("base64") }),
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

  // Round 1: sign with the master key alone (weight 1) - insufficient for the threshold (2)
  // the signer normalization, the first transaction of this close, needs.
  await enterSecretKey(page, master.secret());
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /Sign .* execute close/i }).click();

  // The signing-progress panel appears instead of completion - this account needs a
  // second signer (SigningProgress.tsx L52-55: "needs N more signing weight").
  await expect(page.getByText(/more signing weight/i)).toBeVisible({ timeout: 30_000 });

  // The paused round ends the master key's turn: its secret is wiped and the field is empty.
  const keyField = page.getByPlaceholder("S...");
  await expect(keyField).toHaveValue("");

  // The second co-signer adds its signature. Reselecting the already-active tab is a no-op, so
  // the shared helper works here too rather than a second way of doing the same thing.
  const add = page.getByRole("button", { name: /Add signature/i });
  await enterSecretKey(page, coSignerB.secret());
  await expect(add).toBeEnabled();
  await add.click();

  // The normalization lands as its own transaction and the account stays open under the
  // master key alone.
  await expectSignerNormalizationConfirmed(page);
  expect(await accountExists(master.publicKey())).toBe(true);

  // The merge round pauses for the master key: the co-signer is no longer a signer, and its
  // turn ended with its key wiped.
  await expect(page.getByText(/more signing weight/i)).toBeVisible({
    timeout: TESTNET_STEP_TIMEOUT,
  });
  await expect(keyField).toHaveValue("");
  await enterSecretKey(page, master.secret());
  await expect(add).toBeEnabled();
  await add.click();

  await expect(page).toHaveURL(CLOSE_FINISHED_URL, { timeout: 90_000 });

  expect(await accountExists(master.publicKey())).toBe(false);
});

/** Waits until the plan's "Remove extra signers" step reads as confirmed on the network. */
async function expectSignerNormalizationConfirmed(page: Page): Promise<void> {
  await expect(
    page
      .getByRole("list", { name: "Plan steps" })
      .getByRole("listitem")
      .filter({ hasText: "Remove extra signers" })
  ).toContainText("Confirmed", { timeout: 90_000 });
}

test("multisig close: a wallet that already signed cannot open a second prompt", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const master = Keypair.random();
  const coSignerB = Keypair.random();
  const coSignerC = Keypair.random();
  const destination = Keypair.random();
  const wallet = await installWalletStub(page, {
    address: master.publicKey(),
    sign: { kind: "approve", keypair: master },
  });

  await fund(master.publicKey());
  await fund(destination.publicKey());
  await configureTwoOfThree(master, coSignerB, coSignerC);

  await driveToExecute(page, { source: master.publicKey(), destination: destination.publicKey() });

  // Round 1: the master key signs through the wallet (weight 1 of 2).
  await connectStubWallet(page);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /Sign .* execute close/i }).click();
  await expect(page.getByText(/more signing weight/i)).toBeVisible({ timeout: 30_000 });
  expect(wallet.signRequests).toHaveLength(1);

  // The wallet is still connected and still on screen, but it already signed: the button stays
  // disabled with the reason, and no second prompt reaches the wallet.
  const add = page.getByRole("button", { name: /Add signature/i });
  await expect(page.getByTestId("active-signer")).toContainText(master.publicKey().slice(-4));
  await expect(page.getByText("This signer already signed.", { exact: false })).toBeVisible();
  await expect(add).toBeDisabled();
  await add.click({ force: true });
  expect(wallet.signRequests).toHaveLength(1);

  // A signer the round still needs completes the normalization. The wallet is not asked while
  // the user is on the secret-key tab.
  await enterSecretKey(page, coSignerB.secret());
  await expect(add).toBeEnabled();
  await add.click();
  await expectSignerNormalizationConfirmed(page);
  expect(await accountExists(master.publicKey())).toBe(true);
  await expect(page.getByText(/more signing weight/i)).toBeVisible({
    timeout: TESTNET_STEP_TIMEOUT,
  });
  await expect(page.getByPlaceholder("S...")).toHaveValue("");
  expect(wallet.signRequests).toHaveLength(1);

  // The merge round is a different transaction: the wallet, picked up again from its own tab,
  // signs it, and that is the only second prompt it ever sees.
  await page.getByRole("tab", { name: "Connect wallet" }).click();
  await expect(page.getByTestId("active-signer")).toContainText(master.publicKey().slice(-4));
  await expect(add).toBeEnabled();
  await add.click();
  await expect(page).toHaveURL(CLOSE_FINISHED_URL, { timeout: 90_000 });
  expect(wallet.signRequests).toHaveLength(2);
  expect(wallet.signRequests[1].transactionXdr).toBeDefined();
  expect(wallet.signRequests[1].transactionXdr).not.toBe(wallet.signRequests[0].transactionXdr);
  expect(await accountExists(master.publicKey())).toBe(false);
});

/** Adds, as a second signer of `master` (weight 2, thresholds 2), the hash of a transaction that
 *  merges `master` into `destination`, and returns that transaction's XDR. It is built for the
 *  sequence the account will have once the signer is added, so it is the next one to land. The
 *  pasted merge is submitted on its own, with no signatures, so the pre-auth signer alone has to
 *  meet the high threshold; the master key (weight 1) alone still does not. */
async function preAuthorizeMerge(master: Keypair, destination: string): Promise<string> {
  const res = await fetch(`${HORIZON}/accounts/${master.publicKey()}`);
  const { sequence } = (await res.json()) as { sequence: string };
  const merge = new TransactionBuilder(
    new Account(master.publicKey(), (BigInt(sequence) + BigInt(1)).toString()),
    {
      fee: BASE_FEE,
      networkPassphrase: PASSPHRASE,
    }
  )
    .addOperation(Operation.accountMerge({ destination }))
    .setTimeout(1800)
    .build();
  const config = new TransactionBuilder(new Account(master.publicKey(), sequence), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.setOptions({ signer: { preAuthTx: merge.hash(), weight: 2 } }))
    .addOperation(Operation.setOptions({ lowThreshold: 1, medThreshold: 2, highThreshold: 2 }))
    .setTimeout(60)
    .build();
  config.sign(master);
  const submitRes = await fetch(`${HORIZON}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tx: config.toEnvelope().toXdr("base64") }),
  });
  if (!submitRes.ok)
    throw new Error(`preAuthorizeMerge failed ${submitRes.status}: ${await submitRes.text()}`);
  for (let attempt = 0; attempt < SIGNERS_POLL_MAX_ATTEMPTS; attempt++) {
    const account = (await (await fetch(`${HORIZON}/accounts/${master.publicKey()}`)).json()) as {
      signers: unknown[];
    };
    if (account.signers.length === 2) return merge.toXDR();
    await new Promise((resolve) => setTimeout(resolve, SIGNERS_POLL_DELAY_MS));
  }
  throw new Error(`timed out waiting for ${master.publicKey()} to show its pre-auth signer`);
}

test("pre-authorized close: the pasted transaction is decoded, confirmed by a second click, and completes the close", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const master = Keypair.random();
  const destination = Keypair.random();
  await fund(master.publicKey());
  await fund(destination.publicKey());
  const preAuthXdr = await preAuthorizeMerge(master, destination.publicKey());

  await driveToExecute(page, { source: master.publicKey(), destination: destination.publicKey() });

  // The master key alone (weight 1 of 2) pauses the close on the pre-auth signer.
  await enterSecretKey(page, master.secret());
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /Sign .* execute close/i }).click();
  await expect(page.getByText(/more signing weight/i)).toBeVisible({ timeout: 30_000 });

  await page.getByLabel("Pre-authorized transaction XDR").fill(preAuthXdr);
  const submit = page.getByRole("button", { name: "Submit pre-authorized transaction" });
  await expect(submit).toHaveCount(0);
  await page.getByRole("button", { name: "Review transaction" }).click();

  const summary = page.getByRole("region", { name: "What this transaction does" });
  await expect(summary).toContainText(`Source account: ${master.publicKey()}`);
  await expect(page.getByRole("list", { name: "Operations" }).getByRole("listitem")).toHaveText([
    `Merge account ${master.publicKey()} into ${destination.publicKey()}`,
  ]);
  await expect(summary).toContainText(`Merge destination: ${destination.publicKey()}`);

  await submit.click();
  await expect(page).toHaveURL(CLOSE_FINISHED_URL, { timeout: 90_000 });
  expect(await accountExists(master.publicKey())).toBe(false);
});

// Mirrors fast-path-close.spec.ts's driveFusedClose through the review gate, stopping
// short of signing (this test drives two separate signing rounds itself).
async function driveToExecute(
  page: Page,
  opts: { source: string; destination: string }
): Promise<void> {
  await openTestnetHome(page);
  await enterSourceAddress(page, opts.source);
  const analyzeButton = page.getByRole("button", { name: /Analyze account/i });
  await expect(analyzeButton).toBeEnabled();
  await analyzeButton.click();
  await expect(page).toHaveURL(/\/testnet\/analyze/, { timeout: 30_000 });

  const beginButton = page.getByRole("button", { name: /Review the full plan/i });
  // The destination field is on screen from the start; the button unlocks once every item is decided.
  await expect(page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/)).toBeVisible({
    timeout: 30_000,
  });
  await page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/).fill(opts.destination);
  await confirmDestinationControl(page);
  await expect(beginButton).toBeEnabled({ timeout: TESTNET_STEP_TIMEOUT });
  await beginButton.click();

  await expect(page).toHaveURL(/\/testnet\/review/, { timeout: TESTNET_STEP_TIMEOUT });
  const proceedButton = page.getByRole("button", {
    name: /Continue to signing/i,
  });
  await expect(proceedButton).toBeDisabled({ timeout: TESTNET_STEP_TIMEOUT });
  await page.getByRole("checkbox").check();
  await expect(proceedButton).toBeEnabled();
  await proceedButton.click();

  await expect(page).toHaveURL(/\/testnet\/execute/, { timeout: TESTNET_STEP_TIMEOUT });
  await expectSigningPanel(page);
}
