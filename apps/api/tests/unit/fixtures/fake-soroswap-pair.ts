/**
 * A ledger stand-in for a Soroswap pair, its two tokens, and the router - the exact entries the
 * Soroswap exit adapter and the runner read - served through `getLedgerEntries`, with a canned
 * simulation. Real XDR throughout, so the adapter's decode path is the one under test.
 */
import {
  Address,
  Contract,
  Keypair,
  StrKey,
  nativeToScVal,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { ExitRpc } from "@/lib/defi-exits";
import { rawSimulation } from "./fake-exit-adapter";

export const SOROSWAP_PAIR_HASH =
  "8447525edd62f72ffaf52136358034657ea0511a8fec1cd0ebde649f86cca464";
export const SOROSWAP_ROUTER_HASH =
  "4b95bbf9caec2c6e00c786f53c5f392c2fcdb8435ac0a862ab5e0645eb65824c";
export const PAIR = "CAAZMNZDUPXEPLLJOGVQYQOJPXFYDZRYX2AMSXFYNP7Q5IKY7WCH2ZV4";
export const ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";
export const FACTORY = "CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY";
export const SOROSWAP_FACTORY_HASH =
  "86285a9234d3f0d687eaf88efe8d5d72172b38c9a86624c9934c0cbf2aff2993";
/** XLM's Stellar Asset Contract on testnet. */
export const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
/** A classic asset's Stellar Asset Contract (needs a trustline to receive). */
export const USDC_SAC = "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V";
/** A Soroban-native token (wasm executable, no trustline concept). */
export const SOROBAN_TOKEN = "CBRQHWJDLPYVR4BSVUUWJCZGG4N4FF3CUZKDGRVTE36FAWNEJZEMQRME";

export interface FakePairOptions {
  account: string;
  token0?: string;
  token1?: string;
  reserve0?: bigint;
  reserve1?: bigint;
  totalSupply?: bigint;
  /** The account's LP tokens. The entry is present even at 0, as the pair leaves it after a
   *  full withdrawal; `balanceMissing` leaves it out entirely (archived, or a bad key). */
  shares?: bigint;
  balanceMissing?: boolean;
  /** The factory the pair names in its instance (key 4). */
  pairFactory?: string;
  /** The pair's KLast (key 5) and the factory's fee switch. */
  kLast?: bigint;
  feesEnabled?: boolean;
  /** Which tokens are Stellar Asset Contracts; the rest are wasm tokens. */
  stellarAssets?: string[];
  /** Override the pair's or router's code hash (to make the registry disagree). */
  pairHash?: string;
  routerHash?: string;
  /** Leave the pair's instance out entirely. */
  pairMissing?: boolean;
  simulation?: "ok" | "error" | "restore";
}

type Entry = { key: xdr.LedgerKey; val: xdr.LedgerEntryData };

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

const wasm = (hex: string): xdr.ContractExecutable =>
  xdr.ContractExecutable.contractExecutableWasm(Buffer.from(hex, "hex"));
const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });

export function fakeSoroswapRpc(
  options: FakePairOptions
): ExitRpc & { simulateCalls: Transaction[] } {
  const token0 = options.token0 ?? XLM_SAC;
  const token1 = options.token1 ?? USDC_SAC;
  const stellarAssets = new Set(options.stellarAssets ?? [XLM_SAC, USDC_SAC]);
  const entries: Entry[] = [];

  if (!options.pairMissing) {
    entries.push(
      instanceEntry(PAIR, wasm(options.pairHash ?? SOROSWAP_PAIR_HASH), [
        [xdr.ScVal.scvU32(0), new Address(token0).toScVal()],
        [xdr.ScVal.scvU32(1), new Address(token1).toScVal()],
        [xdr.ScVal.scvU32(2), i128(options.reserve0 ?? 1_000_000_000n)],
        [xdr.ScVal.scvU32(3), i128(options.reserve1 ?? 2_000_000_000n)],
        [xdr.ScVal.scvU32(4), new Address(options.pairFactory ?? FACTORY).toScVal()],
        [xdr.ScVal.scvU32(5), i128(options.kLast ?? 0n)],
        [
          xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("TotalSupply")]),
          i128(options.totalSupply ?? 1_000_000_000n),
        ],
      ])
    );
  }
  entries.push(
    instanceEntry(FACTORY, wasm(SOROSWAP_FACTORY_HASH), [
      [
        xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("FeesEnabled")]),
        xdr.ScVal.scvBool(options.feesEnabled ?? false),
      ],
    ])
  );
  const shares = options.shares ?? 100_000_000n;
  if (!options.balanceMissing) {
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(PAIR).toScAddress(),
        key: xdr.ScVal.scvVec([
          xdr.ScVal.scvSymbol("Balance"),
          new Address(options.account).toScVal(),
        ]),
        durability: xdr.ContractDataDurability.persistent(),
      })
    );
    entries.push({
      key,
      val: xdr.LedgerEntryData.contractData(
        new xdr.ContractDataEntry({
          ext: new xdr.ExtensionPoint(0),
          contract: new Address(PAIR).toScAddress(),
          key: xdr.ScVal.scvVec([
            xdr.ScVal.scvSymbol("Balance"),
            new Address(options.account).toScVal(),
          ]),
          durability: xdr.ContractDataDurability.persistent(),
          val: i128(shares),
        })
      ),
    });
  }
  for (const token of [token0, token1]) {
    entries.push(
      instanceEntry(
        token,
        stellarAssets.has(token)
          ? xdr.ContractExecutable.contractExecutableStellarAsset()
          : wasm("ab".repeat(32))
      )
    );
  }
  entries.push(instanceEntry(ROUTER, wasm(options.routerHash ?? SOROSWAP_ROUTER_HASH)));

  const simulateCalls: Transaction[] = [];
  return {
    simulateCalls,
    async getLedgerEntries(...keys: xdr.LedgerKey[]) {
      const wanted = new Set(keys.map((k) => k.toXDR("base64")));
      return {
        latestLedger: 1,
        entries: entries
          .filter((e) => wanted.has(e.key.toXDR("base64")))
          .map((e) => ({ ...e, lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: 100 })),
      };
    },
    async simulateTransaction(tx: Transaction) {
      simulateCalls.push(tx);
      return rawSimulation(options.simulation ?? "ok", [], "12345");
    },
  };
}

/** A fresh account id for a scenario. */
export const randomAccount = (): string => Keypair.random().publicKey();
export const isContract = (id: string): boolean => StrKey.isValidContract(id);
