import { test, expect } from "@playwright/test";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import {
  enterDestinationAndBegin,
  enterSourceAndAnalyze,
  expectSigningPanel,
} from "./helpers/flow";

// Leaving a close mid-way is a decision: on /execute, after the review confirm, the logo and
// the network switcher ask first, and declining keeps the wizard where it was.
//
// Testnet only. Every account is a throwaway made here and its keys live only in memory. The
// one asset is issued by an account of this spec, so no third-party asset or contract is
// involved. Nothing is signed through the app: the test stops at the confirm.

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const PASSPHRASE = Networks.TESTNET;

async function fund(pub: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`friendbot ${res.status}: ${await res.text()}`);
}

async function submitOps(kp: Keypair, ops: xdr.Operation[]): Promise<void> {
  const res = await fetch(`${HORIZON}/accounts/${kp.publicKey()}`);
  if (!res.ok) throw new Error(`load account: ${res.status}`);
  const { sequence } = (await res.json()) as { sequence: string };
  const builder = new TransactionBuilder(new Account(kp.publicKey(), sequence), {
    fee: "1000",
    networkPassphrase: PASSPHRASE,
  }).setTimeout(120);
  ops.forEach((op) => builder.addOperation(op));
  const tx = builder.build();
  tx.sign(kp);
  const sent = await fetch(`${HORIZON}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tx: tx.toEnvelope().toXdr("base64") }),
  });
  const body = (await sent.json()) as { successful?: boolean; extras?: unknown };
  if (!sent.ok || !body.successful) throw new Error(`tx failed: ${JSON.stringify(body.extras)}`);
}

test("leaving a multi-step close asks first, and declining keeps the wizard mounted", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const source = Keypair.random();
  const issuer = Keypair.random();
  const destination = Keypair.random();
  await Promise.all([source, issuer, destination].map((kp) => fund(kp.publicKey())));
  // An empty trustline to the spec's own asset: the plan removes it, then merges.
  await submitOps(source, [
    Operation.changeTrust({ asset: new Asset("LWLEAVE", issuer.publicKey()) }),
  ]);

  await enterSourceAndAnalyze(page, source.publicKey());
  await enterDestinationAndBegin(page, destination.publicKey());
  await expectSigningPanel(page);

  await page.getByRole("link", { name: "LumenWipe home" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("A close is in progress");
  await dialog.getByRole("button", { name: "Stay" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/testnet\/execute$/);
  await expectSigningPanel(page);

  await page.getByRole("link", { name: "Mainnet" }).click();
  await expect(dialog).toContainText("A close is in progress");
  await dialog.getByRole("button", { name: "Stay" }).click();
  await expect(page).toHaveURL(/\/testnet\/execute$/);
  await expectSigningPanel(page);
});
