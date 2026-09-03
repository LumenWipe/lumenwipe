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

// E2E for the Aquarius exit, against live TESTNET, API-only (plan -> transactions -> sign ->
// submit, repeated until done). It seeds a real LP position in an existing XLM/AQUA
// constant-product pool: the account opens an AQUA trustline, swaps a little XLM for AQUA through
// the router, deposits both, and holds the pool's share tokens. It then asserts ON-CHAIN that the
// close withdrew the shares (balance 0) and merged the account away. Testnet only, never mainnet.

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const SOROBAN_RPC = "https://soroban-testnet.stellar.org";

/** The registry's Aquarius testnet router (apps/api/src/config/contract-registry.json). */
const ROUTER = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
/** Aquarius's testnet asset issuer (docs.aqua.network, Addresses & Networks). */
const AQUA = new Asset("AQUA", "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER");
const XLM_SAC = Asset.native().contractId(Networks.TESTNET);
const AQUA_SAC = AQUA.contractId(Networks.TESTNET);
/** The XLM/AQUA constant-product pool with the deepest liquidity on testnet at the time of writing. */
const POOL = "CCSXYUVLYALKJGIIYMGYLZI447VS6TDWFTVDL43B4IKK2WERHLWUVCRC";
const SWAP_XLM = BigInt(20_000_000); // 2 XLM -> AQUA
const DEPOSIT_XLM = BigInt(10_000_000); // 1 XLM alongside the AQUA received

const registry = JSON.parse(
  readFileSync(resolve(__dirname, "../../../api/src/config/contract-registry.json"), "utf8")
) as { validUntil: string; entries: { address: string; verifiedLive: boolean }[] };
const registryExpired = new Date() > new Date(`${registry.validUntil}T23:59:59Z`);
const routerRegistered = registry.entries.some((e) => e.address === ROUTER && e.verifiedLive);

const server = new rpc.Server(SOROBAN_RPC);
const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });
const u128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "u128" });
const addr = (a: string): xdr.ScVal => new Address(a).toScVal();
/** Aquarius requires the token vector sorted by address. */
const TOKENS = [XLM_SAC, AQUA_SAC].sort();
const tokensVal = xdr.ScVal.scvVec(TOKENS.map(addr));

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

/** Simulates, assembles, signs, submits one Soroban operation, and returns its result value. */
async function soroban(signer: Keypair, op: xdr.Operation): Promise<unknown> {
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
  return simulation.result ? scValToNative(simulation.result.retval) : undefined;
}

async function readOnly(
  from: string,
  contract: string,
  fn: string,
  ...args: xdr.ScVal[]
): Promise<unknown> {
  const account = await server.getAccount(from);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(contract).call(fn, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(`${fn} simulation failed`);
  return scValToNative(sim.result!.retval);
}

/** A read-only call's raw result value. */
async function readOnlyRaw(
  from: string,
  contract: string,
  fn: string,
  ...args: xdr.ScVal[]
): Promise<xdr.ScVal> {
  const account = await server.getAccount(from);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(contract).call(fn, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error(`${fn} simulation failed`);
  return sim.result.retval;
}

/** The router's index (a 32-byte hash) for the pool under test, read from the raw map so the bytes
 *  survive - scValToNative would turn them into a lossy string. */
async function poolIndex(from: string): Promise<Buffer> {
  const pools = await readOnlyRaw(from, ROUTER, "get_pools", tokensVal);
  for (const entry of pools.map() ?? []) {
    if (Address.fromScAddress(entry.val().address()).toString() === POOL) {
      return Buffer.from(entry.key().bytes());
    }
  }
  throw new Error(`pool ${POOL} is not in the router's XLM/AQUA set`);
}

/** Seeds the LP position: AQUA trustline, XLM -> AQUA swap, deposit of both. Returns the share token. */
async function seedAquariusLiquidity(source: Keypair): Promise<string> {
  await classic(source, Operation.changeTrust({ asset: AQUA, limit: "1000000" }));
  const index = await poolIndex(source.publicKey());
  const user = addr(source.publicKey());
  await soroban(
    source,
    new Contract(ROUTER).call(
      "swap",
      user,
      tokensVal,
      addr(XLM_SAC),
      addr(AQUA_SAC),
      xdr.ScVal.scvBytes(index),
      u128(SWAP_XLM),
      u128(BigInt(1))
    )
  );
  const aquaBalance = (await readOnly(source.publicKey(), AQUA_SAC, "balance", user)) as bigint;
  expect(aquaBalance).toBeGreaterThan(BigInt(0));
  const desired = TOKENS.map((t) => (t === XLM_SAC ? DEPOSIT_XLM : aquaBalance));
  await soroban(
    source,
    new Contract(ROUTER).call(
      "deposit",
      user,
      tokensVal,
      xdr.ScVal.scvBytes(index),
      xdr.ScVal.scvVec(desired.map(u128)),
      u128(BigInt(1))
    )
  );
  return (await readOnly(source.publicKey(), POOL, "share_id")) as string;
}

async function sharesOf(shareToken: string, owner: string): Promise<bigint> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(shareToken).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), addr(owner)]),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
  const res = await server.getLedgerEntries(key);
  if (res.entries.length === 0) return BigInt(0);
  return scValToNative(res.entries[0]!.val.contractData().val()) as bigint;
}

test.skip(
  registryExpired || !routerRegistered,
  registryExpired
    ? `contract registry expired on ${registry.validUntil}; re-verify it before running this spec`
    : "the Aquarius testnet router is no longer a verifiedLive registry entry"
);

test("close API: an Aquarius LP position is withdrawn from its pool, then the account is merged", async ({
  request,
}) => {
  test.setTimeout(600_000);

  const source = Keypair.random();
  const destination = Keypair.random();
  await Promise.all([fund(source.publicKey()), fund(destination.publicKey())]);
  const shareToken = await seedAquariusLiquidity(source);
  expect(await sharesOf(shareToken, source.publicKey())).toBeGreaterThan(BigInt(0));

  const body = {
    source: source.publicKey(),
    destination: destination.publicKey(),
    decisions: [
      { id: `destination:${destination.publicKey()}`, choice: "i_control_this_address" },
      // The withdrawal pays AQUA back into the trustline; it then goes to its issuer.
      { id: `asset:AQUA-${AQUA.getIssuer()}`, choice: "return_to_issuer" },
    ],
  };

  // 1. Plan: the router sweep finds the pool and the plan leads with the Aquarius exit.
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
    .toMatch(/^ready:EXIT_POSITIONS:Exit Aquarius /);

  // 2. Rounds: every exit transaction is a call on the pool itself - a reward claim if any
  //    accrued, then the withdrawal - acting only for the account being closed and naming only
  //    the pool's tokens and share token; later rounds close classically.
  // Rewards accrue to the position from the moment it exists, when the pool has emissions on.
  // Both pool calls checkpoint them, and the checkpoint writes the account's reward entries at
  // execution, so every exit transaction must declare them writable whether or not the simulation
  // that priced it saw the write coming.
  const reward = (await readOnly(
    source.publicKey(),
    POOL,
    "get_user_reward",
    addr(source.publicKey())
  )) as bigint;
  const rewardKeyOf = (key: xdr.LedgerKey): boolean => {
    if (key.switch().name !== "contractData") return false;
    const val = key.contractData().key();
    if (val.switch().name !== "scvVec") return false;
    const [name, who] = val.vec() ?? [];
    return (
      name?.switch().name === "scvSymbol" &&
      name.sym().toString() === "UserRewardData" &&
      who?.switch().name === "scvAddress" &&
      Address.fromScAddress(who.address()).toString() === source.publicKey()
    );
  };

  const covered: string[][] = [];
  const exitFunctions: string[] = [];
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
          contract: POOL,
          accountsReferenced: [source.publicKey()],
          unsupportedAddressCount: 0,
          authorizesBeyondSelf: false,
        });
        expect(["withdraw", "claim"]).toContain(op.function);
        exitFunctions.push(op.function);
        for (const contract of op.contractsReferenced as string[]) {
          expect([POOL, shareToken, XLM_SAC, AQUA_SAC]).toContain(contract);
        }
        if (reward > BigInt(0)) {
          const footprint = xdr.TransactionEnvelope.fromXDR(closeTx.xdr, "base64")
            .v1()
            .tx()
            .ext()
            .sorobanData()
            .resources()
            .footprint();
          expect(footprint.readOnly().some(rewardKeyOf)).toBe(false);
          expect(footprint.readWrite().some(rewardKeyOf)).toBe(true);
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
      // On a failure, name the step and keep the envelope so the trap can be simulated by hand.
      const label = `${closeTx.covers.join("+")} · ${closeTx.intent.summary} · source ${source.publicKey()} · xdr ${closeTx.xdr}`;
      expect(submitRes.ok(), `${label}\n${await submitRes.text()}`).toBeTruthy();
      expect((await submitRes.json()).status).toBe("success");
    }
    if (!remaining.requiresAnotherCall) break;
  }

  expect(covered[0]).toContain("EXIT_POSITIONS");
  expect(exitFunctions).toContain("withdraw");
  expect(covered.flat()).toContain("MERGE");

  // 3. On-chain: no shares left, and the account is gone.
  expect(await sharesOf(shareToken, source.publicKey())).toBe(BigInt(0));
  await expect
    .poll(() => accountExists(source.publicKey()), { timeout: 30_000, intervals: [2_000] })
    .toBe(false);
});
