/**
 * Live-testnet seeding for the DeFi exit E2Es: one real position per protocol the exit adapters
 * support, placed on a throwaway account, plus the on-chain reads that prove a close took it out.
 * Everything here talks to the public testnet RPC and Horizon; nothing touches mainnet.
 */
import { expect } from "@playwright/test";
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

export const HORIZON = "https://horizon-testnet.stellar.org";
export const FRIENDBOT = "https://friendbot.stellar.org";
export const SOROBAN_RPC = "https://soroban-testnet.stellar.org";
export const XLM_SAC = Asset.native().contractId(Networks.TESTNET);

/** The registry's Blend V2 testnet pool (apps/api/src/config/contract-registry.json). */
export const BLEND_POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
/** The registry's Soroswap testnet router and factory. */
export const SOROSWAP_ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";
export const SOROSWAP_FACTORY = "CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY";
/** The registry's Aquarius testnet router, its test-asset issuer, and a deep XLM/AQUA pool. */
export const AQUARIUS_ROUTER = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
export const AQUA = new Asset("AQUA", "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER");
export const AQUA_SAC = AQUA.contractId(Networks.TESTNET);
export const AQUARIUS_POOL = "CCSXYUVLYALKJGIIYMGYLZI447VS6TDWFTVDL43B4IKK2WERHLWUVCRC";

export const server = new rpc.Server(SOROBAN_RPC);
export const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });
export const u128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "u128" });
export const addr = (a: string): xdr.ScVal => new Address(a).toScVal();

export async function fund(pub: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`friendbot ${res.status}: ${await res.text()}`);
}

/** Whether Horizon knows the account. Only a 404 means gone; any other trouble is an error. */
export async function accountExists(id: string): Promise<boolean> {
  const res = await fetch(`${HORIZON}/accounts/${id}`);
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`horizon ${res.status} for ${id}`);
}

/** Waits until the RPC serves the account (friendbot answers before every node has ingested it). */
export async function ingested(id: string): Promise<void> {
  await expect
    .poll(
      () =>
        server.getAccount(id).then(
          () => true,
          () => false
        ),
      { timeout: 30_000, intervals: [1_000] }
    )
    .toBe(true);
}

/** Waits for the transaction to succeed; a failure is reported at once with its result. */
export async function confirmed(hash: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const result = await server.getTransaction(hash);
        if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
          throw new Error(`transaction ${hash} failed: ${result.resultXdr.toXDR("base64")}`);
        }
        return result.status;
      },
      { timeout: 60_000, intervals: [2_000] }
    )
    .toBe(rpc.Api.GetTransactionStatus.SUCCESS);
}

/** Signs and submits a classic transaction built from `ops`. */
export async function classic(signer: Keypair, ...ops: xdr.Operation[]): Promise<void> {
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
export async function soroban(signer: Keypair, op: xdr.Operation): Promise<unknown> {
  const account = await server.getAccount(signer.publicKey());
  const raw = new TransactionBuilder(account, { fee: "1000", networkPassphrase: Networks.TESTNET })
    .addOperation(op)
    .setTimeout(120)
    .build();
  const simulation = await server.simulateTransaction(raw);
  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new Error(`simulation failed: ${JSON.stringify(simulation)}`);
  }
  if (rpc.Api.isSimulationRestore(simulation)) {
    throw new Error("simulation needs a ledger-entry restore first; the seed cannot proceed");
  }
  const tx = rpc.assembleTransaction(raw, simulation).build();
  tx.sign(signer);
  const sent = await server.sendTransaction(tx);
  if (sent.status !== "PENDING") throw new Error(`send: ${sent.status} ${JSON.stringify(sent)}`);
  await confirmed(sent.hash);
  return simulation.result ? scValToNative(simulation.result.retval) : undefined;
}

/** A read-only call's raw result value, by simulation. */
export async function readOnlyRaw(
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

export async function readOnly(
  from: string,
  contract: string,
  fn: string,
  ...args: xdr.ScVal[]
): Promise<unknown> {
  return scValToNative(await readOnlyRaw(from, contract, fn, ...args));
}

/** A SEP-41 token's `Balance(owner)` entry, or 0 when there is none. */
export async function tokenBalanceOf(token: string, owner: string): Promise<bigint> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(token).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), addr(owner)]),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
  const res = await server.getLedgerEntries(key);
  if (res.entries.length === 0) return BigInt(0);
  return scValToNative(res.entries[0]!.val.contractData().val()) as bigint;
}

// ─── Blend ───────────────────────────────────────────────────────────────────

/** Blend's `RequestType.Supply`. */
const REQUEST_SUPPLY = 0;

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

/** Supplies XLM into the registry's Blend pool for `owner`. */
export async function seedBlendSupply(owner: Keypair, stroops: bigint): Promise<void> {
  const who = addr(owner.publicKey());
  await soroban(
    owner,
    Operation.invokeContractFunction({
      contract: BLEND_POOL,
      function: "submit",
      args: [who, who, who, xdr.ScVal.scvVec([supplyRequest(XLM_SAC, stroops)])],
    })
  );
}

/** Whether the pool still records any supply, collateral, or debt for `owner`. */
export async function blendPositionExists(owner: string): Promise<boolean> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(BLEND_POOL).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Positions"), addr(owner)]),
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

// ─── Soroswap ────────────────────────────────────────────────────────────────

/**
 * Seeds a Soroswap LP position: trustline and balance of a throwaway classic asset, its Stellar
 * Asset Contract deployed, then the router's add_liquidity, which creates the XLM/asset pair and
 * mints the account's shares. Returns the asset's contract.
 */
export async function seedSoroswapLiquidity(
  source: Keypair,
  issuer: Keypair,
  asset: Asset,
  xlmStroops: bigint,
  assetUnits: bigint
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
    new Contract(SOROSWAP_ROUTER).call(
      "add_liquidity",
      addr(XLM_SAC),
      addr(assetSac),
      i128(xlmStroops),
      i128(assetUnits),
      i128(BigInt(0)),
      i128(BigInt(0)),
      addr(source.publicKey()),
      nativeToScVal(deadline, { type: "u64" })
    )
  );
  return assetSac;
}

/** The pair the factory created for (XLM, asset), read through get_pair. */
export async function soroswapPairFor(assetSac: string, from: string): Promise<string> {
  return (await readOnly(
    from,
    SOROSWAP_FACTORY,
    "get_pair",
    addr(XLM_SAC),
    addr(assetSac)
  )) as string;
}

// ─── Aquarius ────────────────────────────────────────────────────────────────

/** Aquarius requires the token vector sorted by address. */
export const AQUARIUS_TOKENS = [XLM_SAC, AQUA_SAC].sort();
const aquariusTokensVal = xdr.ScVal.scvVec(AQUARIUS_TOKENS.map(addr));

/** The router's index (a 32-byte hash) for the pool under test, read from the raw map so the bytes
 *  survive - scValToNative would turn them into a lossy string. */
async function aquariusPoolIndex(from: string): Promise<Buffer> {
  const pools = await readOnlyRaw(from, AQUARIUS_ROUTER, "get_pools", aquariusTokensVal);
  for (const entry of pools.map() ?? []) {
    if (Address.fromScAddress(entry.val().address()).toString() === AQUARIUS_POOL) {
      return Buffer.from(entry.key().bytes());
    }
  }
  throw new Error(`pool ${AQUARIUS_POOL} is not in the router's XLM/AQUA set`);
}

/**
 * Seeds an Aquarius LP position in the XLM/AQUA pool: AQUA trustline, an XLM -> AQUA swap through
 * the router, then a deposit of both. Returns the pool's share token.
 */
export async function seedAquariusLiquidity(
  source: Keypair,
  swapXlmStroops: bigint,
  depositXlmStroops: bigint
): Promise<string> {
  await classic(source, Operation.changeTrust({ asset: AQUA, limit: "1000000" }));
  const index = await aquariusPoolIndex(source.publicKey());
  const user = addr(source.publicKey());
  await soroban(
    source,
    new Contract(AQUARIUS_ROUTER).call(
      "swap",
      user,
      aquariusTokensVal,
      addr(XLM_SAC),
      addr(AQUA_SAC),
      xdr.ScVal.scvBytes(index),
      u128(swapXlmStroops),
      u128(BigInt(1))
    )
  );
  const aquaBalance = (await readOnly(source.publicKey(), AQUA_SAC, "balance", user)) as bigint;
  expect(aquaBalance).toBeGreaterThan(BigInt(0));
  const desired = AQUARIUS_TOKENS.map((t) => (t === XLM_SAC ? depositXlmStroops : aquaBalance));
  await soroban(
    source,
    new Contract(AQUARIUS_ROUTER).call(
      "deposit",
      user,
      aquariusTokensVal,
      xdr.ScVal.scvBytes(index),
      xdr.ScVal.scvVec(desired.map(u128)),
      u128(BigInt(1))
    )
  );
  return (await readOnly(source.publicKey(), AQUARIUS_POOL, "share_id")) as string;
}
