/**
 * Maps OctoPos's raw portfolio JSON onto LumenWipe's normalized DefiPositionsResult
 * (architecture.md §7.1), so every downstream consumer sees one shape regardless of provider.
 *
 * OctoPos's own OpenAPI spec types `positions[]` as `items: {}` - genuinely untyped. This
 * mapper cannot assume a shape from the vendor, so it validates each position defensively:
 * a supported protocol with an unparseable shape is flagged in `unrecognizedPositions` rather
 * than dropped or guessed at, mirroring the codebase's existing "unknown wasmHash -> flag for
 * manual review, never guess" philosophy (architecture.md §9.9).
 */

import type {
  DefiEnrichmentEntry,
  DefiPosition,
  DefiPositionsResult,
  DefiProtocol,
  DefiQueryKeys,
  UnrecognizedDefiPosition,
} from "@lumenwipe/types";
import type { Network } from "@lumenwipe/types";

const SUPPORTED_PROTOCOLS: readonly DefiProtocol[] = [
  "blend",
  "aquarius",
  "soroswap",
  "phoenix",
  "fxdao",
];

function isSupportedProtocol(value: unknown): value is DefiProtocol {
  return typeof value === "string" && (SUPPORTED_PROTOCOLS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

interface RawPosition {
  protocol: unknown;
  type: unknown;
  [key: string]: unknown;
}

/** Validates and maps one position object; null means "doesn't parse for this protocol/type". */
function mapPosition(raw: RawPosition): DefiPosition | null {
  const protocol = raw.protocol;
  const type = raw.type;

  if (protocol === "blend" && type === "SUPPLY") {
    if (
      isNonEmptyString(raw.poolAddress) &&
      isNonEmptyString(raw.assetAddress) &&
      isNonEmptyString(raw.bTokenAmount)
    ) {
      return {
        protocol: "blend",
        positionType: "supply",
        contractAddress: raw.poolAddress,
        assetAddress: raw.assetAddress,
        bTokenAmount: raw.bTokenAmount,
        usdValue: typeof raw.usdValue === "string" ? raw.usdValue : null,
      };
    }
    return null;
  }

  if (protocol === "blend" && type === "BORROW") {
    if (
      isNonEmptyString(raw.poolAddress) &&
      isNonEmptyString(raw.assetAddress) &&
      isNonEmptyString(raw.dTokenAmount)
    ) {
      return {
        protocol: "blend",
        positionType: "borrow",
        contractAddress: raw.poolAddress,
        assetAddress: raw.assetAddress,
        dTokenAmount: raw.dTokenAmount,
        healthFactor: typeof raw.healthFactor === "string" ? raw.healthFactor : undefined,
        usdValue: typeof raw.usdValue === "string" ? raw.usdValue : null,
      };
    }
    return null;
  }

  if (protocol === "aquarius" && type === "LP") {
    if (isNonEmptyString(raw.poolAddress) && isNonEmptyString(raw.shareAmount)) {
      return {
        protocol: "aquarius",
        positionType: "lp",
        contractAddress: raw.poolAddress,
        shareAmount: raw.shareAmount,
        claimableAquaAmount:
          typeof raw.claimableAquaAmount === "string" ? raw.claimableAquaAmount : undefined,
        usdValue: typeof raw.usdValue === "string" ? raw.usdValue : null,
      };
    }
    return null;
  }

  if (protocol === "soroswap" && type === "LP") {
    if (isNonEmptyString(raw.poolAddress) && isNonEmptyString(raw.shareAmount)) {
      return {
        protocol: "soroswap",
        positionType: "lp",
        contractAddress: raw.poolAddress,
        shareAmount: raw.shareAmount,
        usdValue: typeof raw.usdValue === "string" ? raw.usdValue : null,
      };
    }
    return null;
  }

  if (protocol === "phoenix" && type === "LP") {
    if (isNonEmptyString(raw.poolAddress) && isNonEmptyString(raw.shareAmount)) {
      return {
        protocol: "phoenix",
        positionType: "lp",
        contractAddress: raw.poolAddress,
        shareAmount: raw.shareAmount,
        usdValue: typeof raw.usdValue === "string" ? raw.usdValue : null,
      };
    }
    return null;
  }

  if (protocol === "phoenix" && type === "STAKE") {
    if (
      isNonEmptyString(raw.poolAddress) &&
      isNonEmptyString(raw.stakedAmount) &&
      isNonEmptyString(raw.stakedAtEpoch)
    ) {
      return {
        protocol: "phoenix",
        positionType: "stake",
        contractAddress: raw.poolAddress,
        stakedAmount: raw.stakedAmount,
        stakedAtEpoch: raw.stakedAtEpoch,
        usdValue: typeof raw.usdValue === "string" ? raw.usdValue : null,
      };
    }
    return null;
  }

  return null;
}

/**
 * FxDAO reports one vault as two positions (COLLATERAL, BORROW); this is one exit unit in
 * architecture.md §9.7, so the two legs merge into a single "cdp" position keyed by vault
 * address. The merged usdValue is the collateral leg's - the two legs' dollar values aren't
 * additive (one is an asset, the other a liability), and no gating logic here needs a net
 * figure; that's for a later issue to define if it needs one.
 */
function mergeFxdaoPositions(raw: RawPosition[]): {
  positions: DefiPosition[];
  unrecognized: UnrecognizedDefiPosition[];
} {
  const byVault = new Map<string, { collateral?: RawPosition; borrow?: RawPosition }>();
  const unrecognized: UnrecognizedDefiPosition[] = [];

  for (const p of raw) {
    const vault = isNonEmptyString(p.vaultAddress) ? p.vaultAddress : null;
    if (!vault || !isNonEmptyString(p.denomination)) {
      unrecognized.push({
        protocol: "fxdao",
        rawType: typeof p.type === "string" ? p.type : "unknown",
        reason: "missing vaultAddress or denomination",
      });
      continue;
    }
    const entry = byVault.get(vault) ?? {};
    if (p.type === "COLLATERAL" && isNonEmptyString(p.collateralAmount)) {
      entry.collateral = p;
    } else if (p.type === "BORROW" && isNonEmptyString(p.debtAmount)) {
      entry.borrow = p;
    } else {
      unrecognized.push({
        protocol: "fxdao",
        rawType: typeof p.type === "string" ? p.type : "unknown",
        reason: "missing collateralAmount or debtAmount for its leg",
      });
      continue;
    }
    byVault.set(vault, entry);
  }

  const positions: DefiPosition[] = [];
  for (const [vault, { collateral, borrow }] of byVault) {
    if (!collateral || !borrow) {
      const present = collateral ? "COLLATERAL" : "BORROW";
      unrecognized.push({
        protocol: "fxdao",
        rawType: present,
        reason: `vault ${vault} is missing its ${collateral ? "BORROW" : "COLLATERAL"} leg`,
      });
      continue;
    }
    positions.push({
      protocol: "fxdao",
      positionType: "cdp",
      contractAddress: vault,
      denomination: collateral.denomination as string,
      collateralAmount: collateral.collateralAmount as string,
      debtAmount: borrow.debtAmount as string,
      usdValue: typeof collateral.usdValue === "string" ? collateral.usdValue : null,
    });
  }

  return { positions, unrecognized };
}

function buildEnrichment(tokenInfos: unknown): Record<string, DefiEnrichmentEntry> {
  const out: Record<string, DefiEnrichmentEntry> = {};
  if (!isRecord(tokenInfos)) return out;
  for (const [address, info] of Object.entries(tokenInfos)) {
    if (!isRecord(info) || typeof info.symbol !== "string" || typeof info.decimals !== "number") {
      continue;
    }
    out[address] = {
      symbol: info.symbol,
      decimals: info.decimals,
      usdPrice: typeof info.priceUsd === "string" ? info.priceUsd : null,
      priceSource: typeof info.priceSource === "string" ? info.priceSource : null,
    };
  }
  return out;
}

function buildQueryKeys(rawQueryKeys: unknown): DefiQueryKeys {
  const empty: DefiQueryKeys = {
    rpcEndpoints: [],
    rpcPolicy: { maxKeysPerCall: 0, recommendedConcurrency: 0, backoffOn429Ms: [], timeoutMs: 0 },
    slices: {},
  };
  if (!isRecord(rawQueryKeys)) return empty;

  const rpcEndpoints = Array.isArray(rawQueryKeys.rpcEndpoints)
    ? rawQueryKeys.rpcEndpoints.filter(isRecord).map((e) => ({
        url: typeof e.url === "string" ? e.url : "",
        health: typeof e.health === "string" ? e.health : "unknown",
        avgLatencyMs: typeof e.avgLatencyMs === "number" ? e.avgLatencyMs : 0,
      }))
    : [];

  const rpcPolicy = isRecord(rawQueryKeys.rpcPolicy)
    ? {
        maxKeysPerCall:
          typeof rawQueryKeys.rpcPolicy.maxKeysPerCall === "number"
            ? rawQueryKeys.rpcPolicy.maxKeysPerCall
            : 0,
        recommendedConcurrency:
          typeof rawQueryKeys.rpcPolicy.recommendedConcurrency === "number"
            ? rawQueryKeys.rpcPolicy.recommendedConcurrency
            : 0,
        backoffOn429Ms: Array.isArray(rawQueryKeys.rpcPolicy.backoffOn429Ms)
          ? (rawQueryKeys.rpcPolicy.backoffOn429Ms as number[])
          : [],
        timeoutMs:
          typeof rawQueryKeys.rpcPolicy.timeoutMs === "number"
            ? rawQueryKeys.rpcPolicy.timeoutMs
            : 0,
      }
    : empty.rpcPolicy;

  const slices: DefiQueryKeys["slices"] = {};
  for (const protocol of SUPPORTED_PROTOCOLS) {
    const slice = rawQueryKeys[protocol];
    if (!isRecord(slice)) continue;
    slices[protocol] = {
      protocol,
      ledgerKeys: Array.isArray(slice.ledgerKeys) ? (slice.ledgerKeys as string[]) : [],
      poolAddresses: Array.isArray(slice.poolAddresses) ? (slice.poolAddresses as string[]) : [],
    };
  }

  return { rpcEndpoints, rpcPolicy, slices };
}

export function normalizeOctoPosPortfolio(
  raw: unknown,
  address: string,
  network: Network
): DefiPositionsResult {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.positions) ||
    typeof raw.source !== "string" ||
    !("timestamp" in raw)
  ) {
    throw new Error(
      "OctoPos response is not a recognizable Portfolio (missing positions[]/source/timestamp)"
    );
  }

  const rawPositions = raw.positions as RawPosition[];
  const fxdaoRaw = rawPositions.filter((p) => p.protocol === "fxdao");
  const otherSupported = rawPositions.filter(
    (p) => p.protocol !== "fxdao" && isSupportedProtocol(p.protocol)
  );

  const positions: DefiPosition[] = [];
  const unrecognizedPositions: UnrecognizedDefiPosition[] = [];

  for (const p of otherSupported) {
    const mapped = mapPosition(p);
    if (mapped) {
      positions.push(mapped);
    } else {
      unrecognizedPositions.push({
        protocol: p.protocol as DefiProtocol,
        rawType: typeof p.type === "string" ? p.type : "unknown",
        reason: "required fields missing or malformed for this protocol/type",
      });
    }
  }

  const { positions: fxdaoPositions, unrecognized: fxdaoUnrecognized } =
    mergeFxdaoPositions(fxdaoRaw);
  positions.push(...fxdaoPositions);
  unrecognizedPositions.push(...fxdaoUnrecognized);

  const queryKeysRaw = isRecord(raw.queryKeys) ? raw.queryKeys : {};

  return {
    address,
    network,
    positions,
    unrecognizedPositions,
    enrichment: buildEnrichment(queryKeysRaw.tokenInfos),
    source: raw.source,
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : null,
    queryKeys: buildQueryKeys(queryKeysRaw),
  };
}
