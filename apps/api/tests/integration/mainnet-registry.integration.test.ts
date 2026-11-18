import { expect, test } from "bun:test";
import {
  Account,
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc as stellarRpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { codeMatchesEntry, entriesForNetwork, entriesForProtocol } from "@/lib/contract-registry";
import { readLiveCodeIdentity, type CodeIdentity } from "@/lib/stellar/contract-instance";
import { contractDataEntry } from "@/lib/stellar/contract-data";
import { getRpcServer } from "@/lib/stellar/rpc";
import { UpstreamError } from "@/lib/stellar/upstream-client";
import {
  PHOENIX_BLENDED_VERSION,
  phoenixConfigKey,
  phoenixNewLpKey,
  phoenixShareToken,
  phoenixStakeConfigKey,
  phoenixStakeContract,
  phoenixUnbondToken,
  phoenixWithdrawArgs,
} from "@/lib/defi-exits/phoenix";

// Read-only against live mainnet RPC: no account, no transaction, no funds. Every verifiedLive
// mainnet entry must still run the code it was verified as, or exits on that protocol would halt
// at the registry gate (or, worse, a redeploy would be building against the wrong interface).
// Opt-in like every integration test: `bun run test:integration`.
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;

test.skipIf(!RUN_INTEGRATION)(
  "every verifiedLive mainnet registry entry still resolves on live mainnet with its recorded wasmHash",
  async () => {
    const rpc = getRpcServer("mainnet");
    const entries = entriesForNetwork("mainnet").filter((e) => e.verifiedLive);
    expect(entries.length).toBeGreaterThan(0);
    const mismatches: string[] = [];
    for (const entry of entries) {
      let live: CodeIdentity | null | string;
      try {
        live = await readLiveCodeIdentity(rpc, entry.address);
      } catch (err) {
        live = `error: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (live === null || typeof live === "string" || !codeMatchesEntry(entry, live)) {
        mismatches.push(
          `${entry.protocol} ${entry.kind} ${entry.address}: live ${JSON.stringify(live)}, registry ${entry.wasmHash}`
        );
      }
    }
    expect(mismatches).toEqual([]);
  },
  120_000
);

/** A contract's instance storage by the JSON form of each key. */
async function instanceStorage(contract: string): Promise<Map<string, unknown>> {
  const rpc = getRpcServer("mainnet");
  const response = await rpc.getLedgerEntries(new Contract(contract).getFootprint());
  const storage = new Map<string, unknown>();
  const data = response.entries[0]?.val;
  const instance =
    data?.type === "contractData" && data.contractData.val.type === "scvContractInstance"
      ? data.contractData.val.instance
      : null;
  for (const entry of instance?.storage ?? []) {
    storage.set(JSON.stringify(scValToNative(entry.key)), scValToNative(entry.val));
  }
  return storage;
}

const hex = (value: unknown): string =>
  Buffer.from(value as Uint8Array | { data: number[] } as never).toString("hex");

test.skipIf(!RUN_INTEGRATION)(
  "the code the mainnet factories deploy today is the code the registry's representative pools run",
  async () => {
    // A registry that only re-reads its own representatives would stay green after a protocol
    // rotated its pool code: every new pool would run a hash the registry does not know, and
    // positions in them would be unexitable. So the deployers' current hashes are checked too.
    const aquariusRouter = entriesForProtocol("mainnet", "aquarius").find(
      (e) => e.kind === "router"
    )!;
    const router = await instanceStorage(aquariusRouter.address);
    const aquariusPools = entriesForProtocol("mainnet", "aquarius").filter(
      (e) => e.kind === "pool"
    );
    const byType = (version: string): string[] =>
      aquariusPools.filter((e) => e.version === version).map((e) => e.wasmHash ?? "missing");
    expect(byType("constant_product")).toContain(hex(router.get('["ConstantPoolHash"]')));
    expect(byType("stable")).toContain(hex(router.get('["StableSwapPoolHash"]')));
    expect(byType("concentrated")).toContain(hex(router.get('["ConcentratedPoolHash"]')));

    for (const version of ["v1", "v2"]) {
      const blend = entriesForProtocol("mainnet", "blend").filter((e) => e.version === version);
      const factory = blend.find((e) => e.kind === "factory")!;
      const pool = blend.find((e) => e.kind === "pool")!;
      const meta = (await instanceStorage(factory.address)).get('"PoolMeta"') as {
        pool_hash: unknown;
      };
      expect(hex(meta.pool_hash)).toBe(pool.wasmHash ?? "missing");
    }
  },
  120_000
);

/** One provider call, retried once after a pause if the provider is busy, never otherwise. */
async function onceMoreIfRateLimited<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!(err instanceof UpstreamError) || err.kind !== "rate_limited") throw err;
    await Bun.sleep(20_000);
    return call();
  }
}

/** Ledger entries by key in one request, retried once after a pause if the provider is busy. */
async function entriesByKey(keys: xdr.LedgerKey[]): Promise<Map<string, xdr.LedgerEntryData>> {
  const rpc = getRpcServer("mainnet");
  const res = await onceMoreIfRateLimited(() => rpc.getLedgerEntries(...keys));
  return new Map(res.entries.map((e) => [e.key.toXdr("base64"), e.val]));
}

const poolStorageKey = (pool: string, key: number): xdr.LedgerKey =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(pool).toScAddress(),
      key: xdr.ScVal.scvU32(key),
      durability: xdr.ContractDataDurability.persistent,
    })
  );

let phoenixPoolEntries: Promise<Map<string, xdr.LedgerEntryData>> | null = null;

/** Every listed mainnet Phoenix pool's CONFIG and reserves, in one request shared by the tests. */
function readPhoenixPools(): Promise<Map<string, xdr.LedgerEntryData>> {
  phoenixPoolEntries ??= entriesByKey(
    entriesForProtocol("mainnet", "phoenix")
      .filter((e) => e.kind === "pool")
      .flatMap((e) => [
        phoenixConfigKey(e.address),
        poolStorageKey(e.address, 1),
        poolStorageKey(e.address, 2),
      ])
  );
  return phoenixPoolEntries;
}

test.skipIf(!RUN_INTEGRATION)(
  "every listed mainnet Phoenix pool names, in its own CONFIG, a stake contract the registry lists, and that stake pays the pool's share_token on unbond; only a blended pool names itself",
  async () => {
    // A stake paying another token would make an unbond-then-withdraw chain hand the pool a token
    // it does not take; the adapter blocks that live, and this catches the registry drifting there.
    // A pool that names itself has no staking: only the blended code is registered that way.
    const phoenix = entriesForProtocol("mainnet", "phoenix");
    const poolEntries = await readPhoenixPools();
    const stakes = new Set(phoenix.filter((e) => e.kind === "stake").map((e) => e.address));
    const named = new Set<string>();
    const missing: string[] = [];
    const selfStaked: string[] = [];
    const unbondMismatches: string[] = [];
    const pairs: Array<{ pool: string; stake: string; shareToken: string }> = [];
    for (const pool of phoenix.filter((e) => e.kind === "pool")) {
      const data = poolEntries.get(phoenixConfigKey(pool.address).toXdr("base64"));
      const config =
        data?.type === "contractData"
          ? (scValToNative(data.contractData.val) as { stake_contract?: string })
          : {};
      const stake = config.stake_contract ?? "unreadable";
      if (stake === pool.address) {
        selfStaked.push(`${pool.version} ${pool.address}`);
        continue;
      }
      named.add(stake);
      if (!stakes.has(stake)) missing.push(`${pool.address}: ${stake}`);
      const shareToken = data ? phoenixShareToken(data) : null;
      const stakeContract = data ? phoenixStakeContract(data) : null;
      if (!shareToken || !stakeContract)
        unbondMismatches.push(`${pool.address}: CONFIG unreadable`);
      else pairs.push({ pool: pool.address, stake: stakeContract, shareToken });
    }
    const stakeKeys = [...new Set(pairs.map((p) => p.stake))].flatMap((stake) => [
      phoenixStakeConfigKey(stake),
      phoenixNewLpKey(stake),
    ]);
    const stakeEntries = stakeKeys.length > 0 ? await entriesByKey(stakeKeys) : new Map();
    for (const { pool, stake, shareToken } of pairs) {
      const pays = phoenixUnbondToken(
        stakeEntries.get(phoenixStakeConfigKey(stake).toXdr("base64")),
        stakeEntries.get(phoenixNewLpKey(stake).toXdr("base64"))
      );
      if (pays !== shareToken) {
        unbondMismatches.push(
          `${pool} -> ${stake}: unbond pays ${pays ?? "unreadable"}, share_token ${shareToken}`
        );
      }
    }
    expect(missing).toEqual([]);
    expect(selfStaked.filter((s) => !s.startsWith(`${PHOENIX_BLENDED_VERSION} `))).toEqual([]);
    expect(selfStaked.length).toBe(
      phoenix.filter((e) => e.kind === "pool" && e.version === PHOENIX_BLENDED_VERSION).length
    );
    expect([...stakes].filter((s) => !named.has(s))).toEqual([]);
    expect(unbondMismatches).toEqual([]);
  },
  120_000
);

test.skipIf(!RUN_INTEGRATION)(
  "withdraw_liquidity built with the adapter's own arguments simulates on one listed mainnet Phoenix pool of each code",
  async () => {
    // A pool given another argument count than its code declares answers
    // Error(WasmVm, UnexpectedSize), so every exit from it would fail at simulation. Each pool is
    // withdrawn from as a real holder of its shares: its stake contract, which holds every bonded
    // share, or the pool itself when it names itself as its stake contract. Only simulated: the
    // source is a fresh public key with no secret anywhere, and nothing is submitted.
    const rpc = getRpcServer("mainnet");
    const poolEntries = await readPhoenixPools();
    const byCode = new Map<string, string>();
    for (const pool of entriesForProtocol("mainnet", "phoenix").filter((e) => e.kind === "pool")) {
      if (pool.wasmHash && !byCode.has(pool.wasmHash)) byCode.set(pool.wasmHash, pool.address);
    }
    expect(byCode.size).toBeGreaterThan(1);
    const source = new Account(Keypair.random().publicKey(), "0");
    const results: Record<string, unknown> = {};
    for (const [hash, pool] of byCode) {
      const config = poolEntries.get(phoenixConfigKey(pool).toXdr("base64"));
      const holder = config ? phoenixStakeContract(config) : null;
      const reserve = (key: number) =>
        scValToNative(
          contractDataEntry(poolEntries.get(poolStorageKey(pool, key).toXdr("base64"))!).val
        ) as bigint;
      const empty = reserve(1) === 0n && reserve(2) === 0n;
      const floor = empty ? 0n : 1n;
      const tx = new TransactionBuilder(source, {
        fee: "100",
        networkPassphrase: NETWORK_PASSPHRASES.mainnet,
      })
        .addOperation(
          new Contract(pool).call(
            "withdraw_liquidity",
            ...phoenixWithdrawArgs(holder ?? pool, 1_000n, floor, floor)
          )
        )
        .setTimeout(0)
        .build();
      const simulation = await onceMoreIfRateLimited(() => rpc.simulateTransaction(tx));
      results[`${hash} ${pool}`] = stellarRpc.Api.isSimulationSuccess(simulation)
        ? (scValToNative(simulation.result!.retval) as bigint[]).map(String)
        : `error: ${String((simulation as { error?: unknown }).error).split("\n")[0]}`;
      if (empty) expect(results[`${hash} ${pool}`]).toEqual(["0", "0"]);
      await Bun.sleep(2_000);
    }
    for (const [key, result] of Object.entries(results)) {
      expect({ [key]: Array.isArray(result) && result.length === 2 }).toEqual({ [key]: true });
    }
  },
  180_000
);
