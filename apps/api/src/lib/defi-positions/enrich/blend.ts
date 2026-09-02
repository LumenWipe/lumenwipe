import { PoolV1, PoolV2, TokenMetadata, Version, type Positions } from "@blend-capital/blend-sdk";
import type { DefiPosition, DefiPositionDisplay, Network } from "@lumenwipe/types";
import { entriesForNetwork } from "@/lib/contract-registry";
import { blendSdkNetwork, blendSdkVersion } from "@/lib/defi-exits/blend";
import type { EnrichContext, KnownToken, PositionEnricher } from "./shared";
import { formatUnits, positionKey } from "./shared";

/**
 * Display data for Blend positions, from the same SDK client the exit adapter uses: underlying
 * amounts through the reserve's live bToken/dToken rates (detection only has share counts), the
 * reserve's current estimated APY, the pool's own name, and the asset's symbol.
 *
 * Detection reports one supply position per asset with plain supply and collateral summed (the
 * pool exits them together); the display keeps that total as `amount` and names the collateral
 * part separately, since that is the part a liquidation could touch.
 */

/** The slice of the SDK's reserve the enricher reads, so a test can supply a stand-in. */
export interface BlendEnrichReserveView {
  assetId: string;
  config: { index: number; decimals: number };
  toAssetFromBToken(bTokens: bigint | undefined): bigint;
  toAssetFromDToken(dTokens: bigint | undefined): bigint;
  /** Percentages, as the SDK estimates them (3.99 means 3.99%). */
  estSupplyApy: number;
  estBorrowApy: number;
}

export interface BlendEnrichPoolView {
  name: string | null;
  reserves: Iterable<BlendEnrichReserveView>;
  loadUser(userId: string): Promise<{ positions: Positions }>;
}

export interface BlendEnrichDeps {
  /** `version` null means "unknown to the registry": try V2, then V1. */
  loadPool(network: Network, poolId: string, version: Version | null): Promise<BlendEnrichPoolView>;
  tokenMetadata(network: Network, assetId: string): Promise<KnownToken>;
}

function view(pool: PoolV1 | PoolV2): BlendEnrichPoolView {
  return {
    name:
      typeof pool.metadata.name === "string" && pool.metadata.name.trim()
        ? pool.metadata.name
        : null,
    reserves: pool.reserves.values(),
    loadUser: (userId) => pool.loadUser(userId),
  };
}

export const defaultBlendEnrichDeps: BlendEnrichDeps = {
  async loadPool(network, poolId, version) {
    const sdkNetwork = blendSdkNetwork(network);
    if (version === Version.V1) return view(await PoolV1.load(sdkNetwork, poolId));
    if (version === Version.V2) return view(await PoolV2.load(sdkNetwork, poolId));
    try {
      return view(await PoolV2.load(sdkNetwork, poolId));
    } catch {
      return view(await PoolV1.load(sdkNetwork, poolId));
    }
  },
  async tokenMetadata(network, assetId) {
    const metadata = await TokenMetadata.load(blendSdkNetwork(network), assetId);
    return { symbol: metadata.symbol, decimals: metadata.decimals };
  },
};

function pct(value: number): string | null {
  return Number.isFinite(value) ? value.toFixed(2) : null;
}

export function blendPositionEnricher(
  deps: BlendEnrichDeps = defaultBlendEnrichDeps
): PositionEnricher {
  return async (positions: DefiPosition[], ctx: EnrichContext) => {
    const displays = new Map<string, DefiPositionDisplay>();
    const registry = entriesForNetwork(ctx.network);
    const symbols = new Map<string, Promise<KnownToken | null>>();
    const symbolFor = (assetId: string): Promise<KnownToken | null> => {
      const known = ctx.knownTokens[assetId];
      if (known) return Promise.resolve(known);
      let pending = symbols.get(assetId);
      if (!pending) {
        pending = deps.tokenMetadata(ctx.network, assetId).catch(() => null);
        symbols.set(assetId, pending);
      }
      return pending;
    };

    const byPool = new Map<string, DefiPosition[]>();
    for (const position of positions) {
      if (position.protocol !== "blend") continue;
      const group = byPool.get(position.contractAddress) ?? [];
      group.push(position);
      byPool.set(position.contractAddress, group);
    }

    await Promise.all(
      [...byPool.entries()].map(async ([poolId, held]) => {
        const entry = registry.find((e) => e.address === poolId && e.protocol === "blend");
        const version = entry ? blendSdkVersion(entry.version) : null;
        // One pool failing to load leaves its positions undescribed; the others still resolve.
        let pool: BlendEnrichPoolView;
        let user: { positions: Positions };
        try {
          pool = await deps.loadPool(ctx.network, poolId, version);
          user = await pool.loadUser(ctx.account);
        } catch {
          return;
        }
        const poolName = pool.name ?? entry?.label ?? null;
        const reserves = new Map<string, BlendEnrichReserveView>();
        for (const reserve of pool.reserves) reserves.set(reserve.assetId, reserve);

        for (const position of held) {
          if (position.positionType !== "supply" && position.positionType !== "borrow") continue;
          const reserve = reserves.get(position.assetAddress);
          if (!reserve) continue;
          const token = await symbolFor(position.assetAddress);
          const decimals = reserve.config.decimals;
          const index = reserve.config.index;
          let display: DefiPositionDisplay;
          if (position.positionType === "supply") {
            const supply = reserve.toAssetFromBToken(user.positions.supply.get(index));
            const collateral = reserve.toAssetFromBToken(user.positions.collateral.get(index));
            display = {
              pool: poolName,
              asset: token?.symbol ?? null,
              amount: formatUnits(supply + collateral, decimals),
              collateralAmount: formatUnits(collateral, decimals),
              yieldPct: pct(reserve.estSupplyApy),
              yieldKind: "earned",
            };
          } else {
            const debt = reserve.toAssetFromDToken(user.positions.liabilities.get(index));
            display = {
              pool: poolName,
              asset: token?.symbol ?? null,
              amount: formatUnits(debt, decimals),
              collateralAmount: null,
              yieldPct: pct(reserve.estBorrowApy),
              yieldKind: "paid",
            };
          }
          displays.set(positionKey(position), display);
        }
      })
    );
    return displays;
  };
}
