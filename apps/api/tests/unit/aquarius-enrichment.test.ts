import { describe, expect, test } from "bun:test";
import type { AquariusLpPosition } from "@lumenwipe/types";
import {
  aquariusPositionEnricher,
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
