import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";
import {
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

// E2E for the Soroswap exit, against live TESTNET, API-only (plan -> transactions -> sign ->
// submit, repeated until done). It seeds a real LP position first: a throwaway classic asset gets
// its Stellar Asset Contract deployed, and the router's add_liquidity creates a brand-new XLM/asset
// pair the factory then lists - which is exactly the pair the testnet detection sweep must find.
// It then asserts ON-CHAIN that the close withdrew the liquidity (no shares left) and merged the
// account away. Testnet only, never mainnet.

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const SOROBAN_RPC = "https://soroban-testnet.stellar.org";

/** The registry's Soroswap testnet router and factory (apps/api/src/config/contract-registry.json). */
const ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";
const FACTORY = "CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY";
const XLM_SAC = Asset.native().contractId(Networks.TESTNET);
const LIQUIDITY_XLM = BigInt(50_000_000); // 5 XLM
const LIQUIDITY_ASSET = BigInt(50_000_000); // 5 units of the throwaway asset

const registry = JSON.parse(
  readFileSync(resolve(__dirname, "../../../api/src/config/contract-registry.json"), "utf8")
) as { validUntil: string; entries: { address: string; kind: string; verifiedLive: boolean }[] };
const registryExpired = new Date() > new Date(`${registry.validUntil}T23:59:59Z`);
const routerRegistered = registry.entries.some((e) => e.address === ROUTER && e.verifiedLive);
const factoryRegistered = registry.entries.some((e) => e.address === FACTORY && e.verifiedLive);

const server = new rpc.Server(SOROBAN_RPC);

async function fund(pub: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`friendbot ${res.status}: ${await res.text()}`);
}

async function accountExists(id: string): Promise<boolean> {
  const res = await fetch(`${HORIZON}/accounts/${id}`);
  return res.status === 200;
}

async function confirmed(hash: string): Promise<void> {
  await expect
    .poll(async () => (await server.getTransaction(hash)).status, {
      timeout: 60_000,
      intervals: [2_000],
    })
    .toBe(rpc.Api.GetTransactionStatus.SUCCESS);
}

/** Signs and submits a classic transaction built from `ops`. */
async function classic(signer: Keypair, ...ops: xdr.Operation[]): Promise<void> {
  const account = await server.getAccount(signer.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: "1000",
    networkPassphrase: Networks.TESTNET,
  });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.setTimeout(120).build();
  tx.sign(signer);
  const sent = await server.sendTransaction(tx);
  if (sent.status !== "PENDING") throw new Error(`send: ${sent.status} ${JSON.stringify(sent)}`);
  await confirmed(sent.hash);
}

/** Simulates, assembles, signs, and submits one Soroban operation. */
async function soroban(signer: Keypair, op: xdr.Operation): Promise<void> {
  const account = await server.getAccount(signer.publicKey());
  const raw = new TransactionBuilder(account, { fee: "1000", networkPassphrase: Networks.TESTNET })
    .addOperation(op)
    .setTimeout(120)
    .build();
  const simulation = await server.simulateTransaction(raw);
  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new Error(`simulation failed: ${JSON.stringify(simulation)}`);
  }
  const tx = rpc.assembleTransaction(raw, simulation).build();
  tx.sign(signer);
  const sent = await server.sendTransaction(tx);
  if (sent.status !== "PENDING") throw new Error(`send: ${sent.status} ${JSON.stringify(sent)}`);
  await confirmed(sent.hash);
}

const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });
const addr = (a: string): xdr.ScVal => new Address(a).toScVal();

/**
 * Seeds the LP position: trustline + balance of a throwaway asset, its SAC deployed, then the
 * router's add_liquidity, which creates the XLM/asset pair and mints the account's shares.
 */
async function seedSoroswapLiquidity(
  source: Keypair,
  issuer: Keypair,
  asset: Asset
): Promise<string> {
  await classic(source, Operation.changeTrust({ asset, limit: "1000" }));
  await classic(
    issuer,
    Operation.payment({ destination: source.publicKey(), asset, amount: "100" })
  );
  await soroban(source, Operation.createStellarAssetContract({ asset }));
  const assetSac = asset.contractId(Networks.TESTNET);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  await soroban(
    source,
    new Contract(ROUTER).call(
      "add_liquidity",
      addr(XLM_SAC),
      addr(assetSac),
      i128(LIQUIDITY_XLM),
      i128(LIQUIDITY_ASSET),
      i128(BigInt(0)),
      i128(BigInt(0)),
      addr(source.publicKey()),
      nativeToScVal(deadline, { type: "u64" })
    )
  );
  return assetSac;
}

/** The pair the factory created for (XLM, asset), read through get_pair. */
async function pairFor(assetSac: string, from: string): Promise<string> {
  const account = await server.getAccount(from);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(FACTORY).call("get_pair", addr(XLM_SAC), addr(assetSac)))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error("get_pair simulation failed");
  return scValToNative(sim.result!.retval) as string;
}

async function sharesOf(pair: string, owner: string): Promise<bigint> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(pair).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), addr(owner)]),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
  const res = await server.getLedgerEntries(key);
  if (res.entries.length === 0) return BigInt(0);
  return scValToNative(res.entries[0]!.val.contractData().val()) as bigint;
}

test.skip(
  registryExpired || !routerRegistered || !factoryRegistered,
  registryExpired
    ? `contract registry expired on ${registry.validUntil}; re-verify it before running this spec`
    : "the Soroswap testnet router or factory is no longer a verifiedLive registry entry"
);

test("close API: a Soroswap LP position is withdrawn through the router, then the account is merged", async ({
  request,
}) => {
  test.setTimeout(600_000);

  const issuer = Keypair.random();
  const source = Keypair.random();
  const destination = Keypair.random();
  await Promise.all([
    fund(issuer.publicKey()),
    fund(source.publicKey()),
    fund(destination.publicKey()),
  ]);
  const asset = new Asset("LWTEST", issuer.publicKey());
  const assetSac = await seedSoroswapLiquidity(source, issuer, asset);
  const pair = await pairFor(assetSac, source.publicKey());
  expect(await sharesOf(pair, source.publicKey())).toBeGreaterThan(BigInt(0));

  const body = {
    source: source.publicKey(),
    destination: destination.publicKey(),
    decisions: [
      { id: `destination:${destination.publicKey()}`, choice: "i_control_this_address" },
      // The withdrawal pays the throwaway asset back into the trustline; it then goes to its issuer.
      { id: `asset:LWTEST-${issuer.publicKey()}`, choice: "return_to_issuer" },
    ],
  };

  // 1. Plan: the factory sweep finds the new pair and the plan leads with the Soroswap exit.
  await expect
    .poll(
      async () => {
        const res = await request.post("/api/v1/testnet/close/plan", { data: body });
        if (!res.ok()) return `http ${res.status()}`;
        const plan = await res.json();
        return `${plan.status}:${plan.steps?.[0]?.type ?? "?"}:${plan.steps?.[0]?.title ?? ""}`;
      },
      { timeout: 90_000, intervals: [5_000] }
    )
    .toMatch(/^ready:EXIT_POSITIONS:Exit Soroswap /);

  // 2. Rounds: the first transaction is the router call, alone, acting only for the account
  //    being closed and naming only the pair's two tokens; later rounds close classically.
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
        const op = closeTx.intent.operations[0];
        expect(op).toMatchObject({
          type: "invoke_host_function",
          contract: ROUTER,
          function: "remove_liquidity",
          accountsReferenced: [source.publicKey()],
          unsupportedAddressCount: 0,
          authorizesBeyondSelf: false,
        });
        for (const contract of op.contractsReferenced as string[]) {
          expect([ROUTER, pair, XLM_SAC, assetSac]).toContain(contract);
        }
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

  // 3. On-chain: no shares left in the pair, and the account is gone.
  expect(await sharesOf(pair, source.publicKey())).toBe(BigInt(0));
  await expect
    .poll(() => accountExists(source.publicKey()), { timeout: 30_000, intervals: [2_000] })
    .toBe(false);
});
