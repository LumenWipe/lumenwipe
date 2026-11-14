// Testnet contracts and assets the protocol scenarios use, restated rather than imported (the
// playground never imports apps/api) and checked live on 2026-11-10. They are existing public
// testnet instances, never ones a session or an operator creates: the e2e server runs with a fresh
// issuer and market maker each night, a pair created per session would grow the factory toward
// the API's enumeration cap, and lib/soroban-submit.ts refuses to create a contract by design.
//
// Isomorphic like the rest of lib/scenarios: plain strings, no Stellar SDK. The verifier and the
// executors both read them from here; tests/unit/pinned-contracts.test.ts derives each asset
// contract from its asset with the SDK, so a typo cannot pin the wrong token.

import type { FeatureSetId } from "./types";

/** XLM's Stellar Asset Contract on testnet. */
export const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

/** An asset no playground key issues, bought on the testnet DEX when a scenario needs it. */
export interface PinnedAsset {
  code: string;
  issuer: string;
  /** Its Stellar Asset Contract on testnet. */
  contract: string;
  /** How the scene and the plan name it. */
  label: string;
}

export type PinnedAssetId = "circle-usdc";

export const PINNED_ASSETS: Readonly<Record<PinnedAssetId, PinnedAsset>> = {
  // Circle's testnet USDC: the one asset with deep XLM liquidity on both the testnet DEX and the
  // Soroswap and Aquarius testnet pools.
  "circle-usdc": {
    code: "USDC",
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    label: "USDC (Circle)",
  },
};

export const PINNED_ASSET_IDS = Object.keys(PINNED_ASSETS) as PinnedAssetId[];

/** The pinned asset `CODE:ISSUER` names, or null for any other asset. */
export function pinnedAssetOf(asset: string): PinnedAssetId | null {
  return (
    PINNED_ASSET_IDS.find(
      (id) => `${PINNED_ASSETS[id].code}:${PINNED_ASSETS[id].issuer}` === asset
    ) ?? null
  );
}

/**
 * Soroswap on testnet: the router the registry vouches for (apps/api/src/config/
 * contract-registry.json, `soroswap` / `router`), and its Circle-USDC/XLM pair, which the
 * registry's factory lists (`get_pair`) and which runs the registry's pair code (`8447525e…`).
 * `tokens` is the pair's own order, token_0 then token_1.
 */
export const SOROSWAP = {
  router: "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD",
  pair: "CCBX3NZTCQLQFSPG7HBOKL4P2RVPOPVFHDNRTOSCCJWBTPL2GHEH7RQS",
  tokens: [PINNED_ASSETS["circle-usdc"].contract, XLM_SAC],
} as const;

/** What the Soroswap scenario buys and pairs. The pool prices USDC near 2.2 XLM and the DEX near
 *  1.3, so each ceiling leaves room for the market to move without a large loss. */
export const SOROSWAP_SEED = {
  /** USDC bought on the DEX, all of which goes into the pair. */
  usdc: "2",
  /** The most XLM the purchase may spend. */
  buyMaxXlm: "4",
  /** The most XLM the deposit may pair with the USDC; the router takes only what the price needs. */
  depositMaxXlm: "5",
} as const;

/**
 * Aquarius on testnet: the router the registry vouches for (apps/api/src/config/
 * contract-registry.json, `aquarius` / `router`), and its Circle-USDC/XLM constant-product pool
 * (30 bps), which the router lists under `pool_index` (`get_pools([USDC, XLM])`) and which runs
 * the registry's constant-product pool code (`70476939…`, through the release owner's
 * `amm.constant` tag). The pool keeps its shares in a separate
 * token contract, `shareToken` (`share_id`). `tokens` is the pool's own order (`get_tokens`): the
 * order `deposit` takes its amounts in and `withdraw` pays out and takes its floors in.
 */
export const AQUARIUS = {
  router: "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD",
  pool: "CAYBMZYJCOMMOHOGOGBK7ANIKF3JPZAL4D7SWAPVPHC4WBMOUT5DJN5B",
  poolIndex: "9ac7a9cde23ac2ada11105eeaa42e43c2ea8332ca0aa8f41f58d7160274d718e",
  shareToken: "CDEUHPEUQAQNLCHFVBX3ZOSIR2FUWD2COYTSHUPQPJWK2BCLLQCW66FY",
  tokens: [PINNED_ASSETS["circle-usdc"].contract, XLM_SAC],
} as const;

/** What the Aquarius scenario buys and pairs. The pool prices USDC near 2.1 XLM and the DEX near
 *  1.3, so each ceiling leaves room for the market to move without a large loss. */
export const AQUARIUS_SEED = {
  /** USDC bought on the DEX, all of which goes into the pool. */
  usdc: "2",
  /** The most XLM the purchase may spend. */
  buyMaxXlm: "4",
  /** The most XLM the deposit may pair with the USDC; the pool takes only what its price needs. */
  depositMaxXlm: "5",
} as const;

/**
 * Blend V2 on testnet: the pool the registry vouches for (apps/api/src/config/
 * contract-registry.json, `blend` / `pool`, code `a41fc53d…`), the official TestnetV2 pool.
 * `reserve` is its reserve 0, XLM, the only asset the scenario supplies or borrows: collateral
 * and liability factors 0.9, and no emissions on either of its token ids (0 and 1), so the exit
 * claims nothing before it leaves. The pool is active (status 0) with up to eight positions and no
 * minimum collateral.
 */
export const BLEND = {
  pool: "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF",
  reserve: XLM_SAC,
} as const;

/** Blend's `submit` request types the scenario and its exit use (the pool's `RequestType`). */
export const BLEND_REQUEST = {
  supplyCollateral: 2,
  withdrawCollateral: 3,
  borrow: 4,
  repay: 5,
} as const;

/** What the Blend scenario supplies, and borrows against it in its borrow variant. */
export const BLEND_SEED = {
  /** XLM supplied as collateral, locked until the exit withdraws it. */
  supplyXlm: "20",
  /** XLM borrowed against it, well inside the 0.9 factors; the exit repays it first. */
  borrowXlm: "2",
} as const;

/**
 * Phoenix on testnet: the XYK pool the registry vouches for (apps/api/src/config/
 * contract-registry.json, `phoenix` / `pool`, code `14ed2bb1…`), and the stake contract its own
 * config names (`phoenix` / `stake`, code `a27578aa…`), which bonds with a minimum of one share
 * and unbonds at once. The pool's token_a is LWPHX, a custom SEP-41 token with 7 decimals and no
 * trustline, and token_b is XLM; it keeps its shares in a separate token contract, `shareToken`.
 * Its fee is 30 bps, and it allows at most 500 bps of spread and of slippage.
 */
export const PHOENIX = {
  pool: "CCVEHSVGFYL5SKLO3BSRZCWRHDWKVB5KX6LYT66GX6QNCRJEPYHF6FIV",
  stake: "CCELNFRXYUDJ5545AM7KIMHDHII5PQEGDVYHA3HSR7HXWUNH67EWBFXP",
  tokenA: "CDI3UIVKFNJAFBWOUMWQ6AO34BQ5JMFBHG4EUB3ZVKCKH5FINXE6QGGZ",
  tokenB: XLM_SAC,
  shareToken: "CC53IRMBHWTXE4BWPD5N4LH2L43YSYBMOFD6UARPMZBTWPSODFFKW2EG",
} as const;

/**
 * What the Phoenix scenario swaps and pairs. No key mints LWPHX for it: the demo buys it from the
 * pinned pool itself, then pairs all of it back with XLM at the pool's price.
 */
export const PHOENIX_SEED = {
  /** XLM swapped for LWPHX in the pool. */
  swapXlm: "0.5",
  /** The least LWPHX the swap must quote, in base units, or the pool is too thin to use. */
  minSwapOut: BigInt(10_000),
  /** The most spread the swap may quote, and the most it may take on chain, in bps. */
  maxSpreadBps: 300,
  /** How far under the quote the swap's minimum sits, in bps. */
  swapFloorBps: 100,
  /** What the deposit offers over the XLM the pool's ratio needs, in bps. */
  depositMarginBps: 200,
  /** The most XLM the deposit may pair with the LWPHX. */
  depositMaxXlm: "1",
  /** The deposit's own slippage bound, the pool's maximum. */
  depositSlippageBps: 500,
} as const;

/**
 * What the allowances scenario approves on XLM's asset contract (`XLM_SAC`), one amount per
 * spender in order. The first spender's allowance lives as long as the network allows: the latest
 * ledger plus the network's maximum entry TTL, less one, read live when the step runs. The others
 * live `ALLOWANCE_LIVE_LEDGERS`. An approval moves nothing: the demo keeps its XLM.
 */
export const ALLOWANCE_SEED = {
  amountsXlm: ["10", "25", "50"],
  /** About a week of ledgers, far past a session and its reaper. */
  liveLedgers: 120_960,
} as const;

/**
 * What one `approve` call costs in fees, as an honest estimate rather than a ceiling: testnet
 * charged 0.038 XLM for the farthest expiry on 2026-11-10, and a revoke costs less. The executor's
 * own ceiling is `MAX_SOROBAN_FEE_STROOPS` (1 XLM).
 */
export const ALLOWANCE_FEE_ESTIMATE_XLM = 0.2;

/** Protocol scenarios testnet cannot run, each with the reason, shown beside the ones it can. */
export const TESTNET_UNAVAILABLE: readonly {
  featureSet: FeatureSetId;
  label: string;
  reason: string;
}[] = [
  {
    featureSet: "protocol",
    label: "Soroban token conversion",
    reason:
      "Not on testnet: converting a Soroban token to XLM needs a quoted route, and the route " +
      "source the API uses indexes no testnet pools, so there is no route to show.",
  },
];
