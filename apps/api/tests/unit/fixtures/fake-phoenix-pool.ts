/**
 * A ledger stand-in for a Phoenix pool and its stake contract, share token, and reserve tokens -
 * the entries the Phoenix exit adapter reads - served through `getLedgerEntries`. Every read here
 * is a direct persistent-storage read (unlike Aquarius/Soroswap's instance storage), so no
 * simulation stand-in is needed for `readLive`; `simulateTransaction` only ever answers the
 * runner's own post-build simulation of the assembled step.
 */
import {
  Address,
  Contract,
  Keypair,
  SorobanDataBuilder,
  StrKey,
  nativeToScVal,
  xdr,
  type rpc,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { ExitRpc } from "@/lib/defi-exits";

const contractAddr = (byte: number): string => StrKey.encodeContract(Buffer.alloc(32, byte));

export const PHX_POOL_HASH = "aa".repeat(32);
export const PHX_STAKE_HASH = "bb".repeat(32);
export const POOL = contractAddr(1);
export const STAKE_CONTRACT = contractAddr(2);
export const SHARE_TOKEN = contractAddr(3);
/** XLM's Stellar Asset Contract stand-in. */
export const XLM_SAC = contractAddr(4);
/** A classic asset's Stellar Asset Contract stand-in (needs a trustline to receive). */
export const USDC_SAC = contractAddr(5);
/** A Soroban-native token (wasm executable, no trustline concept). */
export const SOROBAN_TOKEN = contractAddr(6);

export interface FakePhoenixStake {
  amount: bigint;
  timestamp: bigint;
}

export interface FakePhoenixOptions {
  account: string;
  tokens?: [string, string];
  reserves?: [bigint, bigint];
  totalShares?: bigint;
  /** The account's unstaked LP shares; the entry is present even at 0, `shareBalanceMissing`
   *  leaves it out entirely. */
  shares?: bigint;
  shareBalanceMissing?: boolean;
  /** The account's individual stakes; `bondingInfoMissing` leaves the whole entry out. */
  stakes?: FakePhoenixStake[];
  bondingInfoMissing?: boolean;
  /** Which tokens are Stellar Asset Contracts; the rest are wasm tokens. */
  stellarAssets?: string[];
  poolHash?: string;
  stakeHash?: string;
  poolMissing?: boolean;
  simulation?: "ok" | "error" | "restore";
}

type Entry = { key: xdr.LedgerKey; val: xdr.LedgerEntryData };

const wasm = (hex: string): xdr.ContractExecutable =>
  xdr.ContractExecutable.contractExecutableWasm(Buffer.from(hex, "hex"));
const addr = (a: string): xdr.ScVal => new Address(a).toScVal();
const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });
const u64 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "u64" });
const u128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "u128" });
const symbol = (s: string): xdr.ScVal => xdr.ScVal.scvSymbol(s);

function instanceEntry(contract: string, executable: xdr.ContractExecutable): Entry {
  const key = new Contract(contract).getFootprint();
  const val = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable, storage: null })),
    })
  );
  return { key, val };
}

/** A persistent `contractData` entry for an arbitrary (already-encoded) storage key/value pair. */
function persistentEntry(contract: string, key: xdr.ScVal, val: xdr.ScVal): Entry {
  return {
    key: xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(contract).toScAddress(),
        key,
        durability: xdr.ContractDataDurability.persistent(),
      })
    ),
    val: xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: new xdr.ExtensionPoint(0),
        contract: new Address(contract).toScAddress(),
        key,
        durability: xdr.ContractDataDurability.persistent(),
        val,
      })
    ),
  };
}

const balanceScKey = (account: string): xdr.ScVal =>
  xdr.ScVal.scvVec([symbol("Balance"), addr(account)]);

function configVal(
  tokenA: string,
  tokenB: string,
  shareToken: string,
  stakeContract: string
): xdr.ScVal {
  const fields: Array<[string, xdr.ScVal]> = [
    ["token_a", addr(tokenA)],
    ["token_b", addr(tokenB)],
    ["share_token", addr(shareToken)],
    ["stake_contract", addr(stakeContract)],
  ];
  return xdr.ScVal.scvMap(fields.map(([k, v]) => new xdr.ScMapEntry({ key: symbol(k), val: v })));
}

function stakeVal(stake: FakePhoenixStake): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: symbol("stake"), val: i128(stake.amount) }),
    new xdr.ScMapEntry({ key: symbol("stake_timestamp"), val: u64(stake.timestamp) }),
  ]);
}

function bondingInfoVal(stakes: FakePhoenixStake[]): xdr.ScVal {
  const total = stakes.reduce((sum, s) => sum + s.amount, 0n);
  const fields: Array<[string, xdr.ScVal]> = [
    ["stakes", xdr.ScVal.scvVec(stakes.map(stakeVal))],
    ["reward_debt", u128(0n)],
    ["last_reward_time", u64(0n)],
    ["total_stake", i128(total)],
  ];
  return xdr.ScVal.scvMap(fields.map(([k, v]) => new xdr.ScMapEntry({ key: symbol(k), val: v })));
}

function simulation(
  mode: "ok" | "error" | "restore",
  retval: xdr.ScVal = xdr.ScVal.scvVoid()
): rpc.Api.SimulateTransactionResponse {
  const transactionData = new SorobanDataBuilder()
    .setResourceFee(12_345n)
    .setResources(1_000, 2_000, 300)
    .build()
    .toXDR("base64");
  const base = { id: "1", latestLedger: 1, events: [] as string[] };
  const body =
    mode === "error"
      ? { ...base, error: "HostError: Error(Contract, #1)" }
      : {
          ...base,
          minResourceFee: "12345",
          transactionData,
          results: [{ auth: [] as string[], xdr: retval.toXDR("base64") }],
          ...(mode === "restore"
            ? { restorePreamble: { minResourceFee: "500", transactionData } }
            : {}),
        };
  return body as unknown as rpc.Api.SimulateTransactionResponse;
}

export function fakePhoenixRpc(
  options: FakePhoenixOptions
): ExitRpc & { simulateCalls: Transaction[] } {
  const tokens = options.tokens ?? [XLM_SAC, USDC_SAC];
  const reserves = options.reserves ?? [1_000_000_000n, 2_000_000_000n];
  const totalShares = options.totalShares ?? 1_000_000_000n;
  const stellarAssets = new Set(options.stellarAssets ?? [XLM_SAC, USDC_SAC]);
  const entries: Entry[] = [];

  // The instance entry (code hash) stays even when `poolMissing`: that flag means the pool's own
  // CONFIG/reserves cannot be read, not that the contract itself does not exist - the registry
  // gate in run-exit.ts must still resolve the code before the adapter's own read fails.
  entries.push(instanceEntry(POOL, wasm(options.poolHash ?? PHX_POOL_HASH)));
  if (!options.poolMissing) {
    entries.push(
      persistentEntry(
        POOL,
        symbol("CONFIG"),
        configVal(tokens[0]!, tokens[1]!, SHARE_TOKEN, STAKE_CONTRACT)
      )
    );
    entries.push(persistentEntry(POOL, xdr.ScVal.scvU32(0), i128(totalShares)));
    entries.push(persistentEntry(POOL, xdr.ScVal.scvU32(1), i128(reserves[0]!)));
    entries.push(persistentEntry(POOL, xdr.ScVal.scvU32(2), i128(reserves[1]!)));
  }
  entries.push(instanceEntry(STAKE_CONTRACT, wasm(options.stakeHash ?? PHX_STAKE_HASH)));
  if (!options.shareBalanceMissing) {
    entries.push(
      persistentEntry(
        SHARE_TOKEN,
        balanceScKey(options.account),
        i128(options.shares ?? 100_000_000n)
      )
    );
  }
  if (!options.bondingInfoMissing) {
    entries.push(
      persistentEntry(STAKE_CONTRACT, addr(options.account), bondingInfoVal(options.stakes ?? []))
    );
  }
  for (const token of new Set(tokens)) {
    entries.push(
      instanceEntry(
        token,
        stellarAssets.has(token)
          ? xdr.ContractExecutable.contractExecutableStellarAsset()
          : wasm("ab".repeat(32))
      )
    );
  }

  const simulateCalls: Transaction[] = [];
  return {
    simulateCalls,
    async getLedgerEntries(...keys: xdr.LedgerKey[]) {
      const wanted = new Set(keys.map((k) => k.toXDR("base64")));
      if (wanted.size !== keys.length) throw new Error("duplicate ledger keys in one request");
      return {
        latestLedger: 1,
        entries: entries
          .filter((e) => wanted.has(e.key.toXDR("base64")))
          .map((e) => ({ ...e, lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: 100 })),
      };
    },
    async simulateTransaction(tx: Transaction) {
      simulateCalls.push(tx);
      return simulation(options.simulation ?? "ok");
    },
  };
}

export const randomAccount = (): string => Keypair.random().publicKey();
