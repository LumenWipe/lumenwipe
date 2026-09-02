import { test, expect } from "@playwright/test";
import {
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

// E2E for the DeFi exit round, against live TESTNET, API-only (plan -> transactions -> sign ->
// submit, repeated until done). It seeds a real Blend position first - 10 XLM supplied to the
// official Blend V2 testnet pool the contract registry lists - and then asserts ON-CHAIN that
// the close exited it (the position entry is gone) and merged the account away.
//
// This is the one test where the exit adapter, the runner, the registry, the round builder, the
// intent serializer, and the Soroban simulation all run for real, end to end. Per repo rules:
// testnet only, never mainnet.

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const SOROBAN_RPC = "https://soroban-testnet.stellar.org";

/** The registry's Blend V2 testnet pool (apps/api/src/config/contract-registry.json). */
const BLEND_POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
/** Blend's `RequestType.Supply`. */
const REQUEST_SUPPLY = 0;
const SUPPLY_XLM_STROOPS = BigInt(100_000_000); // 10 XLM

async function fund(pub: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`friendbot ${res.status}: ${await res.text()}`);
}

async function accountExists(id: string): Promise<boolean> {
  const res = await fetch(`${HORIZON}/accounts/${id}`);
  return res.status !== 404;
}

/** Blend's `Request` struct, encoded the way the pool contract decodes it (fields sorted). */
function supplyRequest(asset: string, amount: bigint): xdr.ScVal {
  return nativeToScVal(
    { address: asset, amount, request_type: REQUEST_SUPPLY },
    {
      type: {
        address: ["symbol", "address"],
        amount: ["symbol", "i128"],
        request_type: ["symbol", "u32"],
      },
    }
  );
}

/** Supplies XLM into the pool for `owner` - a real position for the close to find and exit. */
async function seedBlendSupply(owner: Keypair): Promise<void> {
  const server = new rpc.Server(SOROBAN_RPC);
  const account = await server.getAccount(owner.publicKey());
  const xlmSac = Asset.native().contractId(Networks.TESTNET);
  const who = new Address(owner.publicKey()).toScVal();
  const raw = new TransactionBuilder(account, { fee: "1000", networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.invokeContractFunction({
        contract: BLEND_POOL,
        function: "submit",
        args: [who, who, who, xdr.ScVal.scvVec([supplyRequest(xlmSac, SUPPLY_XLM_STROOPS)])],
      })
    )
    .setTimeout(120)
    .build();
  const simulation = await server.simulateTransaction(raw);
  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new Error(`seed simulation failed: ${JSON.stringify(simulation)}`);
  }
  const tx = rpc.assembleTransaction(raw, simulation).build();
  tx.sign(owner);
  const sent = await server.sendTransaction(tx);
  if (sent.status !== "PENDING") throw new Error(`seed send: ${sent.status}`);
  await expect
    .poll(async () => (await server.getTransaction(sent.hash)).status, {
      timeout: 60_000,
      intervals: [2_000],
    })
    .toBe(rpc.Api.GetTransactionStatus.SUCCESS);
}

async function poolPositionExists(owner: string): Promise<boolean> {
  const server = new rpc.Server(SOROBAN_RPC);
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(BLEND_POOL).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Positions"), new Address(owner).toScVal()]),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
  const res = await server.getLedgerEntries(key);
  if (res.entries.length === 0) return false;
  // Blend keeps the Positions entry after a full exit, with every map emptied.
  const native = scValToNative(res.entries[0]!.val.contractData().val()) as Record<string, unknown>;
  const held = (v: unknown): number =>
    v instanceof Map ? v.size : v && typeof v === "object" ? Object.keys(v).length : 0;
  return ["supply", "collateral", "liabilities"].some((k) => held(native[k]) > 0);
}

test("close API: a Blend supply position is exited, then the account is merged", async ({
  request,
}) => {
  test.setTimeout(420_000);

  const source = Keypair.random();
  const destination = Keypair.random();
  await fund(source.publicKey());
  await fund(destination.publicKey());
  await seedBlendSupply(source);
  expect(await poolPositionExists(source.publicKey())).toBe(true);

  const acknowledgement = {
    id: `destination:${destination.publicKey()}`,
    choice: "i_control_this_address",
  };
  const body = {
    source: source.publicKey(),
    destination: destination.publicKey(),
    decisions: [acknowledgement],
  };

  // 1. Plan: detection (the testnet direct read) sees the position and the plan leads with an
  //    EXIT_POSITIONS step. Detection reads live ledger state, so allow the ledger to settle.
  await expect
    .poll(
      async () => {
        const res = await request.post("/api/v1/testnet/close/plan", { data: body });
        if (!res.ok()) return `http ${res.status()}`;
        const plan = await res.json();
        return `${plan.status}:${plan.steps?.[0]?.type ?? "?"}`;
      },
      { timeout: 90_000, intervals: [5_000] }
    )
    .toBe("ready:EXIT_POSITIONS");

  // 2. Rounds: the first transaction is the Soroban exit, alone in its transaction, acting only
  //    for the account being closed; later rounds close the account classically.
  const covered: string[][] = [];
  for (let round = 0; round < 10; round++) {
    const txRes = await request.post("/api/v1/testnet/close/transactions", { data: body });
    expect(txRes.ok(), await txRes.text()).toBeTruthy();
    const { transactions, remaining } = await txRes.json();
    expect(transactions.length).toBeGreaterThan(0);

    for (const closeTx of transactions) {
      covered.push(closeTx.covers);
      if (closeTx.covers.includes("EXIT_POSITIONS")) {
        expect(closeTx.intent.operations).toHaveLength(1);
        expect(closeTx.intent.operations[0]).toMatchObject({
          type: "invoke_host_function",
          contract: BLEND_POOL,
          function: "submit",
          accountsReferenced: [source.publicKey()],
        });
      }
      const tx = TransactionBuilder.fromXDR(
        closeTx.xdr,
        closeTx.networkPassphrase ?? Networks.TESTNET
      );
      tx.sign(source);
      const submitRes = await request.post("/api/v1/testnet/submit", {
        data: { signedXdr: tx.toEnvelope().toXDR("base64") },
      });
      expect(submitRes.ok(), await submitRes.text()).toBeTruthy();
      expect((await submitRes.json()).status).toBe("success");
    }
    if (!remaining.requiresAnotherCall) break;
  }

  expect(covered[0]).toContain("EXIT_POSITIONS");
  expect(covered.flat()).toContain("MERGE");

  // 3. On-chain: the pool no longer holds a position for the account, and the account is gone.
  await expect
    .poll(() => accountExists(source.publicKey()), { timeout: 30_000, intervals: [2_000] })
    .toBe(false);
  expect(await poolPositionExists(source.publicKey())).toBe(false);
});
