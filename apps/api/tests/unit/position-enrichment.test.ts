import { describe, expect, test } from "bun:test";
import { Positions, Version } from "@blend-capital/blend-sdk";
import type {
  BlendBorrowPosition,
  BlendSupplyPosition,
  DefiPositionsResult,
  SoroswapLpPosition,
} from "@lumenwipe/types";
import {
  blendPositionEnricher,
  type BlendEnrichDeps,
  type BlendEnrichPoolView,
  type BlendEnrichReserveView,
} from "@/lib/defi-positions/enrich/blend";
import type { ContractRegistryEntry } from "@/lib/contract-registry";
import {
  enrichDefiPositions,
  formatUnits,
  knownTokensFor,
  positionKey,
  type EnrichContext,
} from "@/lib/defi-positions/enrich";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const USER = "GBUYBKHUCCAKG4LM76DONHABFRZSZEHK7ARNEEXBZ3CMVIYKZXPLPVRG";
const POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const OTHER_TOKEN = "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V";

function reserve(
  assetId: string,
  index: number,
  over: Partial<BlendEnrichReserveView> = {}
): BlendEnrichReserveView {
  return {
    assetId,
    config: { index, decimals: 7 },
    // bTokens convert at 1.05, dTokens at 1.02 - hand-computable expectations below.
    toAssetFromBToken: (b) => ((b ?? 0n) * 105n) / 100n,
    toAssetFromDToken: (d) => ((d ?? 0n) * 102n) / 100n,
    // Fractions, as the SDK reports them.
    estSupplyApy: 0.0398644,
    estBorrowApy: 0.055,
    ...over,
  };
}

function pool(state: {
  supply?: Record<number, bigint>;
  collateral?: Record<number, bigint>;
  liabilities?: Record<number, bigint>;
  name?: string | null;
}): BlendEnrichPoolView {
  const toMap = (m: Record<number, bigint> = {}) =>
    new Map(Object.entries(m).map(([i, v]) => [Number(i), v]));
  return {
    name: state.name === undefined ? "Comet" : state.name,
    reserves: [reserve(XLM_SAC, 0), reserve(OTHER_TOKEN, 1, { config: { index: 1, decimals: 6 } })],
    loadUser: async () => ({
      positions: new Positions(
        toMap(state.liabilities),
        toMap(state.collateral),
        toMap(state.supply)
      ),
    }),
  };
}

const REGISTRY: ContractRegistryEntry[] = [
  {
    network: "testnet",
    protocol: "blend",
    kind: "pool",
    address: POOL,
    wasmHash: "a".repeat(64),
    version: "v2",
    label: "Registry test pool",
    verifiedLive: true,
  },
];

function depsWith(view: BlendEnrichPoolView, over: Partial<BlendEnrichDeps> = {}): BlendEnrichDeps {
  return {
    loadPool: async () => view,
    tokenMetadata: async () => {
      throw new Error("no metadata");
    },
    registryEntries: () => REGISTRY,
    ...over,
  };
}

const supply: BlendSupplyPosition = {
  protocol: "blend",
  positionType: "supply",
  contractAddress: POOL,
  assetAddress: XLM_SAC,
  bTokenAmount: "300000000",
  usdValue: null,
};
const borrow: BlendBorrowPosition = {
  protocol: "blend",
  positionType: "borrow",
  contractAddress: POOL,
  assetAddress: OTHER_TOKEN,
  dTokenAmount: "1000000",
  usdValue: null,
};
const lp: SoroswapLpPosition = {
  protocol: "soroswap",
  positionType: "lp",
  contractAddress: OTHER_TOKEN,
  shareAmount: "5",
  usdValue: null,
};

function ctx(over: Partial<EnrichContext> = {}): EnrichContext {
  return {
    network: "testnet",
    account: USER,
    knownTokens: { [XLM_SAC]: { symbol: "XLM", decimals: 7 } },
    ...over,
  };
}

function result(positions: DefiPositionsResult["positions"]): DefiPositionsResult {
  return { ...emptyDefiPositionsResult(USER), positions, source: "testnet-direct-read" };
}

describe("formatUnits", () => {
  test("renders base units in the token's own decimals, exactly, without trailing zeros", () => {
    expect(formatUnits(100_100_015n, 7)).toBe("10.0100015");
    expect(formatUnits(100_000_000n, 7)).toBe("10");
    expect(formatUnits(5n, 7)).toBe("0.0000005");
    expect(formatUnits(0n, 7)).toBe("0");
    expect(formatUnits(1_500_000n, 6)).toBe("1.5");
    expect(formatUnits(42n, 0)).toBe("42");
  });
});

describe("knownTokensFor", () => {
  test("names XLM and every trustline by its Stellar Asset Contract id", () => {
    const known = knownTokensFor(
      [
        {
          asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
          code: "USDC",
          issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
          balance: "1",
          authorized: true,
        },
      ],
      "testnet"
    );
    expect(known[XLM_SAC]).toEqual({ symbol: "XLM", decimals: 7 });
    expect(
      Object.values(known)
        .map((t) => t.symbol)
        .sort()
    ).toEqual(["USDC", "XLM"]);
  });
});

describe("blend enricher", () => {
  test("a supply shows the underlying total, the collateral part, the pool name, the symbol, and the supply APY", async () => {
    // 2 XLM of bTokens supplied plainly + 1 XLM of bTokens as collateral, both at 1.05.
    const view = pool({ supply: { 0: 200_000_000n }, collateral: { 0: 100_000_000n } });
    const displays = await blendPositionEnricher(depsWith(view))([supply], ctx());
    expect(displays.get(positionKey(supply))).toEqual({
      pool: "Comet",
      asset: "XLM",
      amount: "31.5",
      collateralAmount: "10.5",
      yieldPct: "3.99",
      yieldKind: "earned",
    });
  });

  test("a borrow shows the debt in the reserve's own decimals and the borrow APY as paid", async () => {
    const view = pool({ liabilities: { 1: 1_000_000n } });
    const displays = await blendPositionEnricher(depsWith(view))([borrow], ctx());
    expect(displays.get(positionKey(borrow))).toEqual({
      pool: "Comet",
      asset: null, // not a held token and metadata failed: honest null, not a guess
      amount: "1.02", // 6 decimals
      collateralAmount: null,
      yieldPct: "5.50",
      yieldKind: "paid",
    });
  });

  test("a token the account does not hold is named through on-chain metadata, once per asset", async () => {
    let calls = 0;
    const view = pool({ liabilities: { 1: 1_000_000n } });
    const deps = depsWith(view, {
      tokenMetadata: async () => {
        calls++;
        return { symbol: "USDC", decimals: 6 };
      },
    });
    const displays = await blendPositionEnricher(deps)([borrow, { ...borrow }], ctx());
    expect(displays.get(positionKey(borrow))?.asset).toBe("USDC");
    expect(calls).toBe(1);
  });

  test("a pool the SDK cannot load leaves its positions undescribed, without throwing", async () => {
    const deps = depsWith(pool({}), {
      loadPool: async () => {
        throw new Error("rpc down");
      },
    });
    const displays = await blendPositionEnricher(deps)([supply], ctx());
    expect(displays.size).toBe(0);
  });

  test("the registry version is passed to the loader; an unregistered pool asks for null (try V2 then V1)", async () => {
    const seen: (Version | null)[] = [];
    const deps = depsWith(pool({}), {
      loadPool: async (_n, _id, version) => {
        seen.push(version);
        return pool({});
      },
    });
    await blendPositionEnricher(deps)([supply], ctx());
    expect(seen).toEqual([Version.V2]);
    seen.length = 0;
    await blendPositionEnricher(deps)([{ ...supply, contractAddress: OTHER_TOKEN }], ctx());
    expect(seen).toEqual([null]);
  });

  test("a pool without a name falls back to the registry label, then to nothing", async () => {
    const view = pool({ supply: { 0: 1n }, name: null });
    const displays = await blendPositionEnricher(depsWith(view))([supply], ctx());
    expect(displays.get(positionKey(supply))?.pool).toBe("Registry test pool");
    const unregistered = { ...supply, contractAddress: OTHER_TOKEN };
    const none = await blendPositionEnricher(depsWith(view))([unregistered], ctx());
    expect(none.get(positionKey(unregistered))?.pool).toBeNull();
  });

  test("a backstop deposit is left undescribed and never shares a key with the plain supply", async () => {
    const view = pool({ supply: { 0: 100_000_000n } });
    const backstop: BlendSupplyPosition = { ...supply, isBackstop: true };
    const displays = await blendPositionEnricher(depsWith(view))([supply, backstop], ctx());
    expect(positionKey(backstop)).not.toBe(positionKey(supply));
    expect(displays.has(positionKey(supply))).toBe(true);
    expect(displays.has(positionKey(backstop))).toBe(false);
  });

  test("one position the SDK cannot describe leaves the others intact", async () => {
    const view = pool({ supply: { 0: 100_000_000n }, liabilities: { 1: 1_000_000n } });
    const broken = [...view.reserves].map((r) =>
      r.assetId === OTHER_TOKEN
        ? {
            ...r,
            toAssetFromDToken: () => {
              throw new Error("bad reserve");
            },
          }
        : r
    );
    const displays = await blendPositionEnricher(depsWith({ ...view, reserves: broken }))(
      [supply, borrow],
      ctx()
    );
    expect(displays.has(positionKey(supply))).toBe(true);
    expect(displays.has(positionKey(borrow))).toBe(false);
  });
});

describe("enrichDefiPositions", () => {
  test("attaches display to what an enricher resolved, leaves everything else untouched, never mutates the input", async () => {
    const input = result([supply, lp]);
    const enriched = await enrichDefiPositions(input, ctx(), {
      enrichers: {
        blend: blendPositionEnricher(depsWith(pool({ supply: { 0: 100_000_000n } }))),
      },
    });
    expect(enriched.positions[0]!.display?.amount).toBe("10.5");
    expect(enriched.positions[1]!.display).toBeUndefined();
    expect(enriched.positions[1]).toEqual(lp);
    expect(enriched.unrecognizedPositions).toEqual(input.unrecognizedPositions);
    expect(enriched.timestamp).toBe(input.timestamp);
    expect(input.positions[0]!.display).toBeUndefined();
    expect(input.enrichment).toEqual({});
  });

  test("completes the provider's enrichment map with held tokens, never overriding a provider entry", async () => {
    const input = result([]);
    input.enrichment[XLM_SAC] = {
      symbol: "XLM",
      decimals: 7,
      usdPrice: "0.1",
      priceSource: "octopos",
    };
    const enriched = await enrichDefiPositions(
      input,
      ctx({
        knownTokens: {
          [XLM_SAC]: { symbol: "XLM", decimals: 7 },
          [OTHER_TOKEN]: { symbol: "USDC", decimals: 7 },
        },
      }),
      { enrichers: {} }
    );
    expect(enriched.enrichment[XLM_SAC]?.usdPrice).toBe("0.1");
    expect(enriched.enrichment[OTHER_TOKEN]).toEqual({
      symbol: "USDC",
      decimals: 7,
      usdPrice: null,
      priceSource: null,
    });
  });

  test("an enricher that throws or hangs is skipped with a warning; positions stay as detected", async () => {
    const warnings: string[] = [];
    const logger = { warn: (m: string) => void warnings.push(m) };
    const throwing = await enrichDefiPositions(result([supply]), ctx(), {
      enrichers: {
        blend: async () => {
          throw new Error("boom");
        },
      },
      logger,
    });
    expect(throwing.positions[0]).toEqual(supply);
    const hanging = await enrichDefiPositions(result([supply]), ctx(), {
      enrichers: { blend: () => new Promise(() => {}) },
      timeoutMs: 20,
      logger,
    });
    expect(hanging.positions[0]).toEqual(supply);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("timed out");
  });

  test("no positions means no enricher runs at all", async () => {
    let ran = false;
    await enrichDefiPositions(result([]), ctx(), {
      enrichers: {
        blend: async () => {
          ran = true;
          return new Map();
        },
      },
    });
    expect(ran).toBe(false);
  });
});
