/**
 * A ledger stand-in for an FxDAO vaults contract - `VaultsInfo`, `CoreState`, and a chain of
 * `Vault` entries linked by `next_key` - served through `getLedgerEntries`, plus a simulated
 * oracle `lastprice` and `calculate_deposit_ratio` for the undercollateralization gate. Every
 * storage read the adapter does is a direct persistent-storage read; only the price/ratio lookup
 * and the runner's own post-build simulation go through `simulateTransaction`.
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

export const FXDAO_VAULT_HASH = "cc".repeat(32);
export const VAULT = contractAddr(10);
export const ORACLE = contractAddr(11);
export const STABLE_ISSUER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 12)).publicKey();
export const DENOMINATION = "USDx";

const symbol = (s: string): xdr.ScVal => xdr.ScVal.scvSymbol(s);
const addr = (a: string): xdr.ScVal => new Address(a).toScVal();
const u128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "u128" });
const u64 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "u64" });
const variant = (tag: string, ...fields: xdr.ScVal[]): xdr.ScVal =>
  xdr.ScVal.scvVec([symbol(tag), ...fields]);

export interface FakeVaultKey {
  account: string;
  denomination: string;
  index: bigint;
}

const optionalKey = (key: FakeVaultKey | null): xdr.ScVal =>
  key === null
    ? variant("None")
    : variant(
        "Some",
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({ key: symbol("account"), val: addr(key.account) }),
          new xdr.ScMapEntry({ key: symbol("denomination"), val: symbol(key.denomination) }),
          new xdr.ScMapEntry({ key: symbol("index"), val: u128(key.index) }),
        ])
      );

export interface FakeVault {
  account: string;
  denomination: string;
  index: bigint;
  nextKey: FakeVaultKey | null;
  totalCollateral: bigint;
  totalDebt: bigint;
}

type Entry = { key: xdr.LedgerKey; val: xdr.LedgerEntryData };

const wasm = (hex: string): xdr.ContractExecutable =>
  xdr.ContractExecutable.contractExecutableWasm(Buffer.from(hex, "hex"));

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

const vaultsInfoKey = (denomination: string): xdr.ScVal =>
  variant("VaultsInfo", symbol(denomination));
const vaultKeyScVal = (account: string, denomination: string): xdr.ScVal =>
  variant("Vault", xdr.ScVal.scvVec([addr(account), symbol(denomination)]));
const coreStateKey = (): xdr.ScVal => variant("CoreState");

function vaultVal(vault: FakeVault): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: symbol("account"), val: addr(vault.account) }),
    new xdr.ScMapEntry({ key: symbol("denomination"), val: symbol(vault.denomination) }),
    new xdr.ScMapEntry({ key: symbol("index"), val: u128(vault.index) }),
    new xdr.ScMapEntry({ key: symbol("next_key"), val: optionalKey(vault.nextKey) }),
    new xdr.ScMapEntry({ key: symbol("total_collateral"), val: u128(vault.totalCollateral) }),
    new xdr.ScMapEntry({ key: symbol("total_debt"), val: u128(vault.totalDebt) }),
  ]);
}

function vaultsInfoVal(
  lowestKey: FakeVaultKey | null,
  minColRate: bigint,
  totalVaults: bigint
): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: symbol("lowest_key"), val: optionalKey(lowestKey) }),
    new xdr.ScMapEntry({ key: symbol("min_col_rate"), val: u128(minColRate) }),
    new xdr.ScMapEntry({ key: symbol("total_vaults"), val: u64(totalVaults) }),
  ]);
}

function coreStateVal(oracle: string, stableIssuer: string): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: symbol("oracle"), val: addr(oracle) }),
    new xdr.ScMapEntry({ key: symbol("stable_issuer"), val: addr(stableIssuer) }),
  ]);
}

function priceData(price: bigint | null): xdr.ScVal {
  if (price === null) return xdr.ScVal.scvVoid();
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: symbol("price"), val: u128(price) }),
    new xdr.ScMapEntry({ key: symbol("timestamp"), val: u64(1_700_000_000n) }),
  ]);
}

function simulationResponse(
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

function decodeInvocation(tx: Transaction): { contract: string; fn: string } | null {
  const op = tx.operations[0];
  if (!op || op.type !== "invokeHostFunction") return null;
  const invocation = op.func.invokeContract();
  return {
    contract: Address.fromScAddress(invocation.contractAddress()).toString(),
    fn: invocation.functionName().toString(),
  };
}

export interface FakeFxdaoOptions {
  account: string;
  denomination?: string;
  /** The account's own vault; `ownVaultMissing` leaves the entry out entirely (position gone). */
  totalCollateral?: bigint;
  totalDebt?: bigint;
  ownVaultMissing?: boolean;
  /** Other vaults in the same denomination's sorted list, lowest first, ending in ours. Leave
   *  empty (default) to make the account's own vault the list's only (and lowest) entry. */
  precedingVaults?: FakeVault[];
  minColRate?: bigint;
  /** The oracle's raw price for `calculate_deposit_ratio`; `null` simulates an oracle with no rate. */
  price?: bigint | null;
  /** The ratio `calculate_deposit_ratio` returns; compared against `minColRate`. */
  ratio?: bigint;
  vaultInfoMissing?: boolean;
  coreStateMissing?: boolean;
  vaultHash?: string;
  simulation?: "ok" | "error" | "restore";
}

export function fakeFxdaoRpc(
  options: FakeFxdaoOptions
): ExitRpc & { simulateCalls: Transaction[] } {
  const denomination = options.denomination ?? DENOMINATION;
  const totalCollateral = options.totalCollateral ?? 1_150_000_000n; // 115 XLM
  const totalDebt = options.totalDebt ?? 100_000_000n; // 100 USDx
  const minColRate = options.minColRate ?? 1_100_000_000n; // 110%, same 1e9 scale as `index`
  const ratio = options.ratio ?? 1_150_000_000n; // 115%, healthy by default
  const price = options.price === undefined ? 10_000_000n : options.price;
  const preceding = options.precedingVaults ?? [];

  const ownVault: FakeVault = {
    account: options.account,
    denomination,
    index: totalDebt > 0n ? (totalCollateral * 1_000_000_000n) / totalDebt : 0n,
    nextKey: null,
    totalCollateral,
    totalDebt,
  };
  const chain = [...preceding, ownVault];
  for (let i = 0; i < chain.length - 1; i++) {
    const next = chain[i + 1]!;
    chain[i] = {
      ...chain[i]!,
      nextKey: { account: next.account, denomination: next.denomination, index: next.index },
    };
  }
  const lowest = chain[0]!;

  const entries: Entry[] = [instanceEntry(VAULT, wasm(options.vaultHash ?? FXDAO_VAULT_HASH))];
  if (!options.vaultInfoMissing) {
    entries.push(
      persistentEntry(
        VAULT,
        vaultsInfoKey(denomination),
        vaultsInfoVal(
          { account: lowest.account, denomination: lowest.denomination, index: lowest.index },
          minColRate,
          BigInt(chain.length)
        )
      )
    );
  }
  if (!options.coreStateMissing) {
    entries.push(persistentEntry(VAULT, coreStateKey(), coreStateVal(ORACLE, STABLE_ISSUER)));
  }
  if (!options.ownVaultMissing) {
    for (const v of chain) {
      entries.push(persistentEntry(VAULT, vaultKeyScVal(v.account, v.denomination), vaultVal(v)));
    }
  } else {
    for (const v of preceding) {
      entries.push(persistentEntry(VAULT, vaultKeyScVal(v.account, v.denomination), vaultVal(v)));
    }
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
      if (options.simulation && options.simulation !== "ok") {
        // Only the final built-step simulation should hit the configured failure mode; the
        // price/ratio reads above it always succeed so the failure is attributable to the step.
        const invocation = decodeInvocation(tx);
        if (invocation?.fn === "pay_debt") return simulationResponse(options.simulation);
      }
      const invocation = decodeInvocation(tx);
      if (invocation?.contract === ORACLE) return simulationResponse("ok", priceData(price));
      if (invocation?.fn === "calculate_deposit_ratio")
        return simulationResponse("ok", u128(ratio));
      return simulationResponse(options.simulation ?? "ok");
    },
  };
}

export const randomAccount = (): string => Keypair.random().publicKey();
