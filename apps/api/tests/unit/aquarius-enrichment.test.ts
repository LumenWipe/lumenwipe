import { describe, expect, test } from "bun:test";
import type { AquariusLpPosition } from "@lumenwipe/types";
import { Address, Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  aquariusPositionEnricher,
  readAquariusPool,
  type AquariusEnrichDeps,
  type AquariusPoolView,
} from "@/lib/defi-positions/enrich/aquarius";
import { positionKey, type EnrichContext } from "@/lib/defi-positions/enrich";

const ACCOUNT = "GBUYBKHUCCAKG4LM76DONHABFRZSZEHK7ARNEEXBZ3CMVIYKZXPLPVRG";
const POOL = "CDLYWB5CCSNOEXPGHSKYO4FW3R4XFQVI2HR2QC735YDVCSEQJABQDFXI";
const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const OTHER = "CAZRY5GSFBFXD7H6GAFBA5YGYQTDXU4QKWKMYFWBAZFUCURN3WKX6LF5";

const position: AquariusLpPosition = {
  protocol: "aquarius",
  positionType: "lp",
  contractAddress: POOL,
  shareAmount: "100000000",
  usdValue: null,
  tokens: [XLM_SAC, OTHER],
  poolType: "constant_product",
};

function view(over: Partial<AquariusPoolView> = {}): AquariusPoolView {
  return {
    tokens: [XLM_SAC, OTHER],
    reserves: [1_000_000_000n, 2_000_000n], // 100 XLM, 2 OTHER at 6 decimals
    totalShares: 1_000_000_000n,
    shares: 100_000_000n, // 10%
    poolType: null,
    ...over,
  };
}

function deps(
  pool: AquariusPoolView | null,
  over: Partial<AquariusEnrichDeps> = {}
): AquariusEnrichDeps {
  return {
    readPool: async () => pool,
    tokenMetadata: async (_n, id) => {
      if (id === OTHER) return { symbol: "USDC", decimals: 6 };
      throw new Error("unknown token");
    },
    ...over,
  };
}

/** A constant-product pool instance naming XLM/OTHER, reserves, total shares, and a share token. */
function poolInstance(): xdr.LedgerEntryData {
  const sym = (s: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(s)]);
  const addr = (a: string) => new Address(a).toScVal();
  const u128 = (v: bigint) => nativeToScVal(v, { type: "u128" });
  const entry = (k: xdr.ScVal, v: xdr.ScVal) => new xdr.ScMapEntry({ key: k, val: v });
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(POOL).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32, 1)),
          storage: [
            entry(sym("TokenA"), addr(XLM_SAC)),
            entry(sym("TokenB"), addr(OTHER)),
            entry(sym("ReserveA"), u128(1_000_000_000n)),
            entry(sym("ReserveB"), u128(2_000_000n)),
            entry(sym("TotalShares"), u128(1_000_000_000n)),
            entry(
              sym("TokenShare"),
              addr("CAN7DMIQH7FGKNYCUQMWECJJ74EKN5JATVVUOVTXOWLQGZCWAFWANG5P")
            ),
          ],
        })
      ),
    })
  );
}

const ctx: EnrichContext = {
  network: "testnet",
  account: ACCOUNT,
  knownTokens: { [XLM_SAC]: { symbol: "XLM", decimals: 7 } },
};

describe("aquarius enricher", () => {
  test("names the pool by its token symbols and type, and says what the shares are worth in every reserve", async () => {
    const displays = await aquariusPositionEnricher(deps(view()))([position], ctx);
    expect(displays.get(positionKey(position))).toEqual({
      pool: "XLM/USDC pool",
      asset: "shares",
      amount: "10",
      collateralAmount: null,
      yieldPct: null,
      yieldKind: null,
      detail: "worth 10 XLM + 0.2 USDC",
    });
  });

  test("a stableswap position says so, and an unknown token is shown in base units, never under a guessed scale", async () => {
    const stable = { ...position, poolType: "stable" as const };
    const d = deps(view(), {
      tokenMetadata: async () => {
        throw new Error("no metadata");
      },
    });
    const display = (await aquariusPositionEnricher(d)([stable], ctx)).get(positionKey(stable));
    expect(display?.pool).toBeNull();
    expect(display?.detail).toBe("worth 10 XLM + 200000 base units of CAZR…6LF5");
  });

  test("a share balance absent from the ledger leaves the position undescribed rather than at zero", async () => {
    const rpc = {
      getLedgerEntries: async (...keys: xdr.LedgerKey[]) => ({
        latestLedger: 1,
        entries: keys
          .filter((k) => k.toXDR("base64") === new Contract(POOL).getFootprint().toXDR("base64"))
          .map((key) => ({ key, val: poolInstance(), lastModifiedLedgerSeq: 1 })),
      }),
    };
    expect(await readAquariusPool(rpc as never, POOL, ACCOUNT, null)).toBeNull();
  });

  test("an empty pool has no worth to state; an unreadable or throwing read leaves the position undescribed", async () => {
    const empty = (
      await aquariusPositionEnricher(deps(view({ totalShares: 0n })))([position], ctx)
    ).get(positionKey(position));
    expect(empty?.detail).toBeNull();
    expect((await aquariusPositionEnricher(deps(null))([position], ctx)).size).toBe(0);
    const throwing = await aquariusPositionEnricher(
      deps(null, {
        readPool: async () => {
          throw new Error("rpc down");
        },
      })
    )([position], ctx);
    expect(throwing.size).toBe(0);
  });
});
