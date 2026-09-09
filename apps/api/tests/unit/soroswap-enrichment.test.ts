import { describe, expect, test } from "bun:test";
import type { SoroswapLpPosition } from "@lumenwipe/types";
import {
  soroswapPositionEnricher,
  type SoroswapEnrichDeps,
  type SoroswapPairView,
} from "@/lib/defi-positions/enrich/soroswap";
import { positionKey, type EnrichContext } from "@/lib/defi-positions/enrich";

const ACCOUNT = "GBUYBKHUCCAKG4LM76DONHABFRZSZEHK7ARNEEXBZ3CMVIYKZXPLPVRG";
const PAIR = "CAAZMNZDUPXEPLLJOGVQYQOJPXFYDZRYX2AMSXFYNP7Q5IKY7WCH2ZV4";
const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const OTHER = "CBRQHWJDLPYVR4BSVUUWJCZGG4N4FF3CUZKDGRVTE36FAWNEJZEMQRME";

const position: SoroswapLpPosition = {
  protocol: "soroswap",
  positionType: "lp",
  contractAddress: PAIR,
  shareAmount: "100000000",
  usdValue: null,
  tokens: [XLM_SAC, OTHER],
};

function view(over: Partial<SoroswapPairView> = {}): SoroswapPairView {
  return {
    token0: XLM_SAC,
    token1: OTHER,
    reserve0: 1_000_000_000n, // 100 XLM
    reserve1: 2_000_000n, // 2 OTHER at 6 decimals
    totalSupply: 1_000_000_000n,
    shares: 100_000_000n, // 10%
    name: "XLM-OTHER Soroswap LP Token",
    ...over,
  };
}

function deps(
  pair: SoroswapPairView | null,
  over: Partial<SoroswapEnrichDeps> = {}
): SoroswapEnrichDeps {
  return {
    readPair: async () => pair,
    tokenMetadata: async (_n, id) => {
      if (id === OTHER) return { symbol: "OTHER", decimals: 6 };
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

describe("soroswap enricher", () => {
  test("names the pair by its token symbols and says what the shares are worth in both reserves", async () => {
    const displays = await soroswapPositionEnricher(deps(view()))([position], ctx);
    expect(displays.get(positionKey(position))).toEqual({
      pool: "XLM/OTHER pair",
      asset: "shares",
      amount: "10",
      collateralAmount: null,
      yieldPct: null,
      yieldKind: null,
      detail: "worth 10 XLM + 0.2 OTHER",
    });
  });

  test("without token metadata it falls back to the LP token's name and short contract ids", async () => {
    const d = deps(view(), {
      tokenMetadata: async () => {
        throw new Error("no metadata");
      },
    });
    const display = (await soroswapPositionEnricher(d)([position], ctx)).get(positionKey(position));
    expect(display?.pool).toBe("XLM-OTHER");
    expect(display?.detail).toBe("worth 10 XLM + 200000 base units of CBRQ…QRME");
  });

  test("an empty pair has no worth to state; an unreadable pair leaves the position undescribed", async () => {
    const empty = (
      await soroswapPositionEnricher(deps(view({ totalSupply: 0n })))([position], ctx)
    ).get(positionKey(position));
    expect(empty?.detail).toBeNull();
    const unreadable = await soroswapPositionEnricher(deps(null))([position], ctx);
    expect(unreadable.size).toBe(0);
    const throwing = await soroswapPositionEnricher(
      deps(null, {
        readPair: async () => {
          throw new Error("rpc down");
        },
      })
    )([position], ctx);
    expect(throwing.size).toBe(0);
  });
});
