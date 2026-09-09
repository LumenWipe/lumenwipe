import { test, expect } from "@playwright/test";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  XTAR,
  accountExists,
  fund,
  ingested,
  seedSorobanToken,
  tokenBalanceOf,
} from "./fixtures/defi-seeds";

// E2E for Soroban token balances held directly (#161), against live TESTNET, API-only (plan ->
// transactions -> sign -> submit, repeated until done). The account gets a real XTAR balance by
// swapping on the Soroswap testnet AMM - a balance no trustline shows. The close must find it,
// refuse to proceed without a decision about it, and then honour the decision: either send it, as
// the token, to the account the user named in one plain transfer authorized by nothing else, or
// leave it on record and merge anyway. Asserted ON-CHAIN. Testnet only, never mainnet.

const SWAP_XLM = BigInt(20_000_000); // 2 XLM -> XTAR

interface Fixture {
  source: Keypair;
  destination: Keypair;
  recipient: Keypair;
  balance: bigint;
}

async function seeded(): Promise<Fixture> {
  const source = Keypair.random();
  const destination = Keypair.random();
  const recipient = Keypair.random();
  await Promise.all([
    fund(source.publicKey()),
    fund(destination.publicKey()),
    fund(recipient.publicKey()),
  ]);
  await ingested(source.publicKey());
  const balance = await seedSorobanToken(source, SWAP_XLM);
  expect(balance).toBeGreaterThan(BigInt(0));
  return { source, destination, recipient, balance };
}

/** Polls the plan until discovery has confirmed the token, and returns the matching decision. */
async function planShowsToken(
  request: Parameters<Parameters<typeof test>[2]>[0]["request"],
  body: Record<string, unknown>,
  contract: string
): Promise<Record<string, unknown>> {
  let plan: Record<string, unknown> = {};
  await expect
    .poll(
      async () => {
        const res = await request.post("/api/v1/testnet/close/plan", { data: body });
        if (!res.ok()) return `http ${res.status()}`;
        plan = (await res.json()) as Record<string, unknown>;
        const points = plan.decisionPoints as Array<{ id: string }>;
        return points.some((p) => p.id === `token:${contract}`) ? "found" : "not yet";
      },
      { timeout: 120_000, intervals: [5_000] }
    )
    .toBe("found");
  return plan;
}

async function runClose(
  request: Parameters<Parameters<typeof test>[2]>[0]["request"],
  body: Record<string, unknown>,
  source: Keypair,
  onTransaction: (closeTx: Record<string, unknown>) => void
): Promise<string[][]> {
  const covered: string[][] = [];
  let finished = false;
  for (let round = 0; round < 8 && !finished; round++) {
    const txRes = await request.post("/api/v1/testnet/close/transactions", { data: body });
    expect(txRes.ok(), await txRes.text()).toBeTruthy();
    const { transactions, remaining } = (await txRes.json()) as {
      transactions: Array<Record<string, unknown>>;
      remaining: { requiresAnotherCall: boolean };
    };
    expect(transactions.length).toBeGreaterThan(0);
    for (const closeTx of transactions) {
      covered.push(closeTx.covers as string[]);
      onTransaction(closeTx);
      const tx = TransactionBuilder.fromXDR(
        closeTx.xdr as string,
        (closeTx.networkPassphrase as string) ?? Networks.TESTNET
      );
      tx.sign(source);
      const submitRes = await request.post("/api/v1/testnet/submit", {
        data: { signedXdr: tx.toEnvelope().toXDR("base64") },
      });
      const intent = closeTx.intent as { summary: string };
      const label = `${(closeTx.covers as string[]).join("+")} · ${intent.summary} · source ${source.publicKey()} · xdr ${closeTx.xdr}`;
      expect(submitRes.ok(), `${label}\n${await submitRes.text()}`).toBeTruthy();
      expect(((await submitRes.json()) as { status: string }).status).toBe("success");
    }
    finished = !remaining.requiresAnotherCall;
  }
  expect(finished, "the close did not finish within 8 rounds").toBe(true);
  return covered;
}

const settled = { timeout: 30_000, intervals: [2_000] };

test("close API: a Soroban token the account holds is found, must be decided about, and is sent as the token to the chosen account before the merge", async ({
  request,
}) => {
  test.setTimeout(480_000);
  const { source, destination, recipient, balance } = await seeded();

  const base = {
    source: source.publicKey(),
    destination: destination.publicKey(),
    decisions: [{ id: `destination:${destination.publicKey()}`, choice: "i_control_this_address" }],
  };

  // 1. Discovery finds the balance no trustline shows, and the plan will not call itself ready
  //    until the token has an answer: transfer and leave are offered, leaving is never the default.
  const plan = await planShowsToken(request, base, XTAR);
  expect(plan.status).toBe("needs_decisions");
  const point = (plan.decisionPoints as Array<Record<string, unknown>>).find(
    (p) => p.id === `token:${XTAR}`
  )!;
  expect(point.subject).toMatchObject({
    kind: "soroban_token",
    contract: XTAR,
    symbol: "XTAR",
    decimals: 7,
    balance: balance.toString(),
  });
  const optionIds = (point.options as Array<{ id: string }>).map((o) => o.id);
  expect(optionIds).toContain("transfer_to_account");
  expect(optionIds).toContain("acknowledge_residue");
  expect(point.default).not.toBe("acknowledge_residue");

  // 2. Without the answer, transactions are refused by name - the token is never left in silence.
  const refused = await request.post("/api/v1/testnet/close/transactions", { data: base });
  expect(refused.status()).toBe(422);
  expect(await refused.json()).toMatchObject({
    error: { code: "needs_decisions", details: { missing: [`token:${XTAR}`] } },
  });

  // 3. With the transfer chosen, the plan leads the asset steps with it and the close proceeds.
  const body = {
    ...base,
    decisions: [
      ...base.decisions,
      {
        id: `token:${XTAR}`,
        choice: "transfer_to_account",
        params: { destination: recipient.publicKey() },
      },
    ],
  };
  const ready = await planShowsToken(request, body, XTAR);
  expect(ready.status).toBe("ready");
  const steps = ready.steps as Array<{ type: string; title: string; affectedAsset?: string }>;
  const tokenStep = steps.find((s) => s.affectedAsset === XTAR);
  expect(tokenStep).toMatchObject({ type: "HANDLE_ASSETS" });
  expect(tokenStep!.title).toMatch(/^Send XTAR to G[A-Z2-7]{7}…/);

  // 4. The transfer is one plain call on the token, from the account to the chosen recipient, for
  //    the live balance, under the account's own credentials and nothing nested - the shape the web
  //    anchor signs, and the only shape it signs.
  const transfers: Array<Record<string, unknown>> = [];
  const covered = await runClose(request, body, source, (closeTx) => {
    if ((closeTx.covers as string[]).includes("HANDLE_ASSETS")) {
      const ops = (closeTx.intent as { operations: Array<Record<string, unknown>> }).operations;
      if (ops[0]?.type === "invoke_host_function") transfers.push(ops[0]);
    }
  });
  expect(transfers).toHaveLength(1);
  expect(transfers[0]).toMatchObject({
    contract: XTAR,
    function: "transfer",
    args: [source.publicKey(), recipient.publicKey(), balance.toString()],
    authDepth: 0,
    authorizesBeyondSelf: false,
    unsupportedAddressCount: 0,
    contractsReferenced: [XTAR],
  });
  expect((transfers[0]!.accountsReferenced as string[]).sort()).toEqual(
    [source.publicKey(), recipient.publicKey()].sort()
  );
  // The token moved before anything classic, and the account was merged last.
  const firstClassic = covered.findIndex((c) => !c.includes("HANDLE_ASSETS"));
  expect(firstClassic).toBeGreaterThan(0);
  expect(covered.flat()).toContain("MERGE");

  // 5. On-chain: the recipient holds the whole balance, the account holds none and is gone.
  await expect.poll(() => tokenBalanceOf(XTAR, recipient.publicKey()), settled).toBe(balance);
  await expect.poll(() => tokenBalanceOf(XTAR, source.publicKey()), settled).toBe(BigInt(0));
  await expect.poll(() => accountExists(source.publicKey()), settled).toBe(false);
});

test("close API: a Soroban token the user explicitly leaves stays with the address, on the plan and on the receipt's record, and the account still merges", async ({
  request,
}) => {
  test.setTimeout(480_000);
  const { source, destination, balance } = await seeded();

  const body = {
    source: source.publicKey(),
    destination: destination.publicKey(),
    decisions: [
      { id: `destination:${destination.publicKey()}`, choice: "i_control_this_address" },
      { id: `token:${XTAR}`, choice: "acknowledge_residue" },
    ],
  };

  const plan = await planShowsToken(request, body, XTAR);
  expect(plan.status).toBe("ready");
  const steps = plan.steps as Array<{
    type: string;
    title: string;
    operationCount: number;
    affectedAsset?: string;
  }>;
  const tokenStep = steps.find((s) => s.affectedAsset === XTAR);
  expect(tokenStep).toMatchObject({
    type: "HANDLE_ASSETS",
    title: "Leave XTAR with this address",
    operationCount: 0,
  });

  // No token transaction at all: every transaction is classic, and the merge happens.
  const covered = await runClose(request, body, source, (closeTx) => {
    const ops = (closeTx.intent as { operations: Array<{ type: string }> }).operations;
    for (const op of ops) expect(op.type).not.toBe("invoke_host_function");
  });
  expect(covered.flat()).toContain("MERGE");

  // On-chain: the account is gone; the balance is still bound to its key, exactly as acknowledged.
  await expect.poll(() => accountExists(source.publicKey()), settled).toBe(false);
  expect(await tokenBalanceOf(XTAR, source.publicKey())).toBe(balance);
});
