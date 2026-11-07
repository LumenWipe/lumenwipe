import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  Account,
  Asset,
  Claimant,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import {
  enterDestinationAndBegin,
  enterSourceAndAnalyze,
  TESTNET_STEP_TIMEOUT,
} from "./helpers/flow";
import { connectStubWallet, installWalletStub } from "./helpers/wallet-stub";

// A close of more than one transaction, signed through the shared wallet stub, watched while it
// runs: the step list and the progress line must follow each transaction, not stay on step 1.
//
// Testnet only, per repo rules. The close really runs: the first transaction confirms, and the
// wallet is then left unanswered on the next one, so the throwaway account stays part closed.

const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";

async function fund(pub: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`friendbot ${res.status}: ${await res.text()}`);
  for (let i = 0; i < 10; i++) {
    if ((await fetch(`${HORIZON}/accounts/${pub}`)).ok) return;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`account ${pub} was not indexed in time`);
}

async function submitOps(kp: Keypair, ops: xdr.Operation[]): Promise<void> {
  const account = (await (await fetch(`${HORIZON}/accounts/${kp.publicKey()}`)).json()) as {
    sequence: string;
  };
  const builder = new TransactionBuilder(new Account(kp.publicKey(), account.sequence), {
    fee: "1000",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(120);
  ops.forEach((op) => builder.addOperation(op));
  const tx = builder.build();
  tx.sign(kp);
  const res = await fetch(`${HORIZON}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tx: tx.toEnvelope().toXdr("base64") }),
  });
  if (!res.ok) throw new Error(`setup transaction failed: ${await res.text()}`);
}

/** The step list on screen: the desktop sidebar at this viewport, the mobile one is hidden. */
function stepList(page: Page): Locator {
  return page.getByRole("list", { name: "Plan steps" }).filter({ visible: true });
}

/** Funds an account holding a claimable balance of a throwaway asset, which forces a claim
 *  round before the merge round, and opens /execute for it with the stub wallet connected. */
async function multiTransactionClose(page: Page, owner: Keypair): Promise<void> {
  const issuer = Keypair.random();
  const receiver = Keypair.random();
  await Promise.all([
    fund(owner.publicKey()),
    fund(issuer.publicKey()),
    fund(receiver.publicKey()),
  ]);
  await submitOps(issuer, [
    Operation.createClaimableBalance({
      asset: new Asset("STEP", issuer.publicKey()),
      amount: "5",
      claimants: [new Claimant(owner.publicKey())],
    }),
  ]);

  await enterSourceAndAnalyze(page, owner.publicKey());
  await page.getByRole("radio", { name: /Add a STEP trustline and claim it/ }).check();
  await page
    .getByRole("radio", { name: /Return my .*STEP to the issuer/ })
    .check({ timeout: TESTNET_STEP_TIMEOUT });
  await enterDestinationAndBegin(page, receiver.publicKey());
  await connectStubWallet(page);
  await page.getByRole("checkbox").check();
}

test("the step list, progress line and confirmed hash follow each transaction of a multi-transaction close", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const owner = Keypair.random();
  const wallet = await installWalletStub(page, {
    address: owner.publicKey(),
    sign: { kind: "approve", keypair: owner },
  });
  await multiTransactionClose(page, owner);

  await page.getByRole("button", { name: /Sign & execute close/i }).click();
  await wallet.waitForSignRequest(TESTNET_STEP_TIMEOUT);
  // The first request was answered when it arrived; the next one is left open.
  wallet.set({ sign: { kind: "never" } });

  const list = stepList(page);
  await expect(list.locator("li").first()).toContainText("Confirmed", { timeout: 60_000 });
  await expect.poll(() => wallet.signRequests.length, { timeout: 60_000 }).toBe(2);

  await expect(
    page
      .locator('[role="status"]')
      .filter({ hasText: /^Transaction 2 of (at least )?\d+: approve in your wallet/ })
  ).toHaveCount(1);
  const current = list.locator("li[aria-current='step']");
  await expect(current).toHaveCount(1);
  await expect(current).toContainText("Signing");
  // The active step moved off the first one, which is confirmed.
  await expect(list.locator("li").first()).not.toHaveAttribute("aria-current", "step");

  // Before the close completes, the confirmed transaction can be checked on the explorer.
  const link = list
    .locator("li")
    .first()
    .getByRole("link", { name: /^View transaction/ });
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  const href = await link.getAttribute("href");
  const hash = /^https:\/\/stellar\.expert\/explorer\/testnet\/tx\/([0-9a-f]{64})$/.exec(
    href ?? ""
  )?.[1];
  expect(hash).toBeDefined();
  await expect(link).toHaveAccessibleName(
    `View transaction ${hash!.slice(0, 6)}…${hash!.slice(-6)} on Stellar Expert (opens in a new tab)`
  );
  const onChain = (await (await fetch(`${HORIZON}/transactions/${hash}`)).json()) as {
    successful?: boolean;
    source_account?: string;
  };
  expect(onChain.successful).toBe(true);
  expect(onChain.source_account).toBe(owner.publicKey());
  await expect(page).toHaveURL(/\/testnet\/execute/);
});
