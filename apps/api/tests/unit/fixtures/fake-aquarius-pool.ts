/**
 * A ledger stand-in for an Aquarius pool, its share token, its tokens, and its reward token - the
 * entries the Aquarius exit adapter reads - served through `getLedgerEntries`, plus a simulation
 * that answers `get_user_reward` with a canned amount and every other call with a canned result.
 * Real XDR throughout, so the adapter's decode path is the one under test.
 */
import {
  Address,
  Contract,
  Keypair,
  SorobanDataBuilder,
  nativeToScVal,
  xdr,
  type Transaction,
  type rpc,
} from "@stellar/stellar-sdk";
import type { ExitRpc } from "@/lib/defi-exits";

export const AQ_CONSTANT_HASH = "d691135aade93ff0f7c229e009cde042130a05124cf7202b03d11246b4f9b473";
export const AQ_STABLE_HASH = "22dff7242d2bc0ea4a4727b4b2cac33b188304d5945740ad24d8a33a5d22741e";
export const AQ_CONCENTRATED_HASH =
  "155a17b9929ffb1f9e84bd6ef5c00a4d613c1ab5f4ad4c502d84515250cc2907";
export const POOL = "CDLYWB5CCSNOEXPGHSKYO4FW3R4XFQVI2HR2QC735YDVCSEQJABQDFXI";
export const SHARE_TOKEN = "CAN7DMIQH7FGKNYCUQMWECJJ74EKN5JATVVUOVTXOWLQGZCWAFWANG5P";
/** XLM's Stellar Asset Contract on testnet. */
export const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
/** The testnet AQUA Stellar Asset Contract - the reward token. */
export const AQUA_SAC = "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE";
/** A classic asset's Stellar Asset Contract (needs a trustline to receive). */
export const USDC_SAC = "CAZRY5GSFBFXD7H6GAFBA5YGYQTDXU4QKWKMYFWBAZFUCURN3WKX6LF5";
/** A Soroban-native token (wasm executable, no trustline concept). */
export const SOROBAN_TOKEN = "CBRQHWJDLPYVR4BSVUUWJCZGG4N4FF3CUZKDGRVTE36FAWNEJZEMQRME";

export interface FakeAquariusOptions {
  account: string;
  /** "constant_product" lays tokens out as TokenA/TokenB, "stable" as a Tokens vector. */
  layout?: "constant_product" | "stable";
  tokens?: string[];
  reserves?: bigint[];
  totalShares?: bigint;
  /** The account's LP tokens; the entry is present even at 0, `balanceMissing` leaves it out. */
  shares?: bigint;
  balanceMissing?: boolean;
  /** Accrued AQUA; `rewardReadFails` makes the simulated read fail instead. */
  reward?: bigint;
  rewardReadFails?: boolean;
  claimKilled?: boolean;
  /** Which tokens are Stellar Asset Contracts; the rest are wasm tokens. */
  stellarAssets?: string[];
  poolHash?: string;
  poolMissing?: boolean;
  simulation?: "ok" | "error" | "restore";
  /** Reward gauges whose `UserRewardData(account)` the simulation records as read-only. */
  rewardGauges?: string[];
}

type Entry = { key: xdr.LedgerKey; val: xdr.LedgerEntryData };

const wasm = (hex: string): xdr.ContractExecutable =>
  xdr.ContractExecutable.contractExecutableWasm(Buffer.from(hex, "hex"));
const sym = (s: string): xdr.ScVal => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(s)]);
const addr = (a: string): xdr.ScVal => new Address(a).toScVal();
const u128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "u128" });
const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });

function instanceEntry(
  contract: string,
  executable: xdr.ContractExecutable,
  storage: Array<[xdr.ScVal, xdr.ScVal]> = []
): Entry {
  const key = new Contract(contract).getFootprint();
  const val = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable,
          storage:
            storage.length === 0
              ? null
              : storage.map(([k, v]) => new xdr.ScMapEntry({ key: k, val: v })),
        })
      ),
    })
  );
  return { key, val };
}

function balanceEntry(token: string, account: string, amount: bigint): Entry {
  const key = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), addr(account)]);
  return {
    key: xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(token).toScAddress(),
        key,
        durability: xdr.ContractDataDurability.persistent(),
      })
    ),
    val: xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: new xdr.ExtensionPoint(0),
        contract: new Address(token).toScAddress(),
        key,
        durability: xdr.ContractDataDurability.persistent(),
        val: i128(amount),
      })
    ),
  };
}

/** A fixed other account, for keys that must not be mistaken for the closing account's. */
const STRANGER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();

/** A persistent contract-data ledger key. */
export function dataKey(contract: string, key: xdr.ScVal): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contract).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
}

/** The footprint a withdraw simulation records in the same reward period as the account's last
 *  interaction: the gauges' per-account reward data read but not written. */
export function sameperiodFootprint(account: string, gauges: string[]) {
  const readOnly = [
    new Contract(POOL).getFootprint(),
    ...gauges.map((g) =>
      dataKey(g, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("UserRewardData"), addr(account)]))
    ),
    // Someone else's reward data, and an unrelated key of the account's, stay where they are.
    dataKey(
      gauges[0] ?? POOL,
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("UserRewardData"), addr(STRANGER)])
    ),
    dataKey(XLM_SAC, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), addr(account)])),
  ];
  const readWrite = [
    dataKey(SHARE_TOKEN, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), addr(account)])),
  ];
  return { readOnly, readWrite };
}

function simulation(
  mode: "ok" | "error" | "restore",
  retval: xdr.ScVal,
  footprint?: { readOnly: xdr.LedgerKey[]; readWrite: xdr.LedgerKey[] }
): rpc.Api.SimulateTransactionResponse {
  const builder = new SorobanDataBuilder().setResourceFee(12_345n).setResources(1_000, 2_000, 300);
  if (footprint) builder.setFootprint(footprint.readOnly, footprint.readWrite);
  const transactionData = builder.build().toXDR("base64");
  const base = { id: "1", latestLedger: 1, events: [] as string[] };
  const body =
    mode === "error"
      ? { ...base, error: "HostError: Error(Contract, #3)" }
      : {
          ...base,
          minResourceFee: "12345",
          transactionData,
          results: [{ auth: [], xdr: retval.toXDR("base64") }],
          ...(mode === "restore"
            ? { restorePreamble: { minResourceFee: "500", transactionData } }
            : {}),
        };
  return body as unknown as rpc.Api.SimulateTransactionResponse;
}

/** The contract function a simulated transaction's single invocation calls, or null. */
function calledFunction(tx: Transaction): string | null {
  const op = tx.toEnvelope().v1().tx().operations()[0];
  if (!op || op.body().switch() !== xdr.OperationType.invokeHostFunction()) return null;
  const fn = op.body().invokeHostFunctionOp().hostFunction();
  if (fn.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) return null;
  return fn.invokeContract().functionName().toString();
}

export function fakeAquariusRpc(
  options: FakeAquariusOptions
): ExitRpc & { simulateCalls: Transaction[] } {
  const tokens = options.tokens ?? [XLM_SAC, USDC_SAC];
  const reserves = options.reserves ?? [1_000_000_000n, 2_000_000_000n];
  const stellarAssets = new Set(options.stellarAssets ?? [XLM_SAC, USDC_SAC, AQUA_SAC]);
  const entries: Entry[] = [];

  if (!options.poolMissing) {
    const layout: Array<[xdr.ScVal, xdr.ScVal]> =
      (options.layout ?? "constant_product") === "stable"
        ? [
            [sym("Tokens"), xdr.ScVal.scvVec(tokens.map(addr))],
            [sym("Reserves"), xdr.ScVal.scvVec(reserves.map(u128))],
          ]
        : [
            [sym("TokenA"), addr(tokens[0]!)],
            [sym("TokenB"), addr(tokens[1]!)],
            [sym("ReserveA"), u128(reserves[0]!)],
            [sym("ReserveB"), u128(reserves[1]!)],
          ];
    entries.push(
      instanceEntry(POOL, wasm(options.poolHash ?? AQ_CONSTANT_HASH), [
        ...layout,
        [sym("TotalShares"), u128(options.totalShares ?? 1_000_000_000n)],
        [sym("TokenShare"), addr(SHARE_TOKEN)],
        [sym("RewardToken"), addr(AQUA_SAC)],
        ...(options.claimKilled !== undefined
          ? ([[sym("IsKilledClaim"), xdr.ScVal.scvBool(options.claimKilled)]] as Array<
              [xdr.ScVal, xdr.ScVal]
            >)
          : []),
      ])
    );
  }
  entries.push(instanceEntry(SHARE_TOKEN, wasm("72".repeat(32))));
  if (!options.balanceMissing) {
    entries.push(balanceEntry(SHARE_TOKEN, options.account, options.shares ?? 100_000_000n));
  }
  for (const token of new Set([...tokens, AQUA_SAC])) {
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
      // Stellar RPC rejects a request that names the same key twice; so does this stand-in.
      if (wanted.size !== keys.length) throw new Error("duplicate ledger keys in one request");
      return {
        latestLedger: 1,
        entries: entries
          .filter((e) => wanted.has(e.key.toXDR("base64")))
          .map((e) => ({ ...e, lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: 100 })),
      };
    },
    async simulateTransaction(tx: Transaction) {
      if (calledFunction(tx) === "get_user_reward") {
        return options.rewardReadFails
          ? simulation("error", xdr.ScVal.scvVoid())
          : simulation("ok", u128(options.reward ?? 0n));
      }
      simulateCalls.push(tx);
      return simulation(
        options.simulation ?? "ok",
        xdr.ScVal.scvVoid(),
        options.rewardGauges
          ? sameperiodFootprint(options.account, options.rewardGauges)
          : undefined
      );
    },
  };
}

export const randomAccount = (): string => Keypair.random().publicKey();
