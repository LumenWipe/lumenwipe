import { test, expect } from "@playwright/test";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";

// E2E coverage for the close-account REST API, exercised end-to-end against TESTNET.
// This spec talks only to the API (plan -> transactions -> submit), signs locally with
// the source key, and asserts ON-CHAIN (via Horizon) that the source account was merged
// away. Per repo rules: testnet only, never mainnet. It uses friendbot/Horizon-testnet
// directly only for setup and the final assertion.

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";

async function fund(pub: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`friendbot ${res.status}: ${await res.text()}`);
}

async function accountExists(id: string): Promise<boolean> {
  const res = await fetch(`${HORIZON}/accounts/${id}`);
  return res.status !== 404;
}

test("close API: plan -> transactions -> sign -> submit merges a fresh account", async ({
  request,
}) => {
  test.setTimeout(120_000);

  const source = Keypair.random();
  const destination = Keypair.random();
  await fund(source.publicKey());
  await fund(destination.publicKey());

  // 1. Plan: a freshly funded account holds nothing, so there is one transaction and
  //    no decisions to resolve.
  const planRes = await request.post("/api/v1/testnet/close/plan", {
    data: { source: source.publicKey(), destination: destination.publicKey() },
  });
  expect(planRes.ok()).toBeTruthy();
  const plan = await planRes.json();
  expect(plan.status).toBe("ready");
  expect(plan.execution.estimatedTransactionCount).toBe(1);
  expect(plan.decisionPoints).toHaveLength(0);

  // 2. Transactions: one unsigned fused close, with an intent that merges to the
  //    requested destination and nowhere else.
  const txRes = await request.post("/api/v1/testnet/close/transactions", {
    data: { source: source.publicKey(), destination: destination.publicKey(), decisions: [] },
  });
  expect(txRes.ok()).toBeTruthy();
  const txBody = await txRes.json();
  expect(txBody.transactions).toHaveLength(1);
  const closeTx = txBody.transactions[0];
  expect(closeTx.intent.guarantees.mergeDestination).toBe(destination.publicKey());
  expect(closeTx.covers).toContain("MERGE");
  expect(txBody.remaining.requiresAnotherCall).toBe(false);

  // 3. Sign locally - keys never leave the client.
  const tx = TransactionBuilder.fromXDR(closeTx.xdr, closeTx.networkPassphrase ?? Networks.TESTNET);
  tx.sign(source);
  const signedXdr = tx.toEnvelope().toXDR("base64");

  // 4. Submit through the API.
  const submitRes = await request.post("/api/v1/testnet/submit", { data: { signedXdr } });
  expect(submitRes.ok()).toBeTruthy();
  const submitBody = await submitRes.json();
  expect(submitBody.status).toBe("success");
  expect(typeof submitBody.hash).toBe("string");

  // 5. On-chain: the source account was merged away and no longer exists.
  await expect
    .poll(() => accountExists(source.publicKey()), { timeout: 30_000, intervals: [2_000] })
    .toBe(false);
});

test("close API: rejects a malformed source with 400", async ({ request }) => {
  const res = await request.post("/api/v1/testnet/close/plan", { data: { source: "not-valid" } });
  expect(res.status()).toBe(400);
  expect((await res.json()).error.code).toBe("invalid_source");
});
