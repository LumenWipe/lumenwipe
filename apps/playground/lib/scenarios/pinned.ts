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
 * the registry's constant-product pool code (`d691135a…`). The pool keeps its shares in a separate
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
