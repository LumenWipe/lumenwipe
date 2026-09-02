import type { Network } from "./network";

/**
 * Protocols LumenWipe actually knows how to exit (architecture.md §9's table). OctoPos itself
 * indexes more than this (e.g. "untangled-vault", "stellar-wallet") - those are dropped by the
 * adapter rather than represented here, since the type system should not claim LumenWipe can act
 * on a protocol it has no exit path for.
 */
export type DefiProtocol = "blend" | "aquarius" | "soroswap" | "phoenix" | "fxdao";

/**
 * Lowercased from OctoPos's own SUPPLY/BORROW/LP/STAKE tags. FxDAO's COLLATERAL+BORROW pair is
 * one vault - one exit unit per architecture.md §9.7 - so it collapses to a single "cdp" position
 * carrying both legs rather than two positions. WALLET positions are out of scope: classic
 * balances already come from AccountState.trustlines, and Soroban token balance handling is a
 * separate Phase-2 deliverable, not this epic.
 */
export type DefiPositionType = "supply" | "borrow" | "lp" | "cdp" | "stake";

/**
 * What a person should read about a position, in the protocol's own terms, resolved by the API
 * from a live read at analysis time (issue #197). Presentation only: every field is nullable, a
 * failed read leaves the whole object absent, and nothing here feeds the plan, the gate, or an
 * exit - those re-read the ledger themselves.
 */
export interface DefiPositionDisplay {
  /** The pool, pair, or vault by name (the protocol's own metadata or the registry label). */
  pool: string | null;
  /** Symbol of the position's asset; for an LP position the pair, e.g. "XLM/USDC". */
  asset: string | null;
  /** Underlying amount in the asset's own units as a decimal string - not shares or bTokens. */
  amount: string | null;
  /** The part of `amount` posted as collateral (lending protocols), decimal string; null when
   *  the protocol has no such distinction. */
  collateralAmount: string | null;
  /** Current yield as a percentage with two decimals ("3.99"): earned on a supply, paid on debt. */
  yieldPct: string | null;
  yieldKind: "earned" | "paid" | null;
}

interface DefiPositionBase {
  protocol: DefiProtocol;
  /** Pool, market, or vault contract this position lives in. */
  contractAddress: string;
  /** Human-readable view of the position, when the analysis could resolve one. */
  display?: DefiPositionDisplay;
  /** Left as an optional hook: the wasmHash -> protocol-version contract registry
   *  architecture.md describes does not exist in code yet (a later contribution). */
  wasmHash?: string;
  usdValue: string | null;
}

export interface BlendSupplyPosition extends DefiPositionBase {
  protocol: "blend";
  positionType: "supply";
  assetAddress: string;
  bTokenAmount: string;
  /** True when this supply is also posted as backstop collateral. */
  isBackstop?: boolean;
}

export interface BlendBorrowPosition extends DefiPositionBase {
  protocol: "blend";
  positionType: "borrow";
  assetAddress: string;
  dTokenAmount: string;
  healthFactor?: string;
}

export interface AquariusLpPosition extends DefiPositionBase {
  protocol: "aquarius";
  positionType: "lp";
  shareAmount: string;
  /** Reported by OctoPos alongside the LP position rather than as its own position. */
  claimableAquaAmount?: string;
}

export interface SoroswapLpPosition extends DefiPositionBase {
  protocol: "soroswap";
  positionType: "lp";
  shareAmount: string;
}

export interface PhoenixLpPosition extends DefiPositionBase {
  protocol: "phoenix";
  positionType: "lp";
  shareAmount: string;
}

export interface PhoenixStakePosition extends DefiPositionBase {
  protocol: "phoenix";
  positionType: "stake";
  stakedAmount: string;
  /** Unix seconds; unbonding requires the original stake's timestamp (architecture.md §9.6). */
  stakedAtEpoch: string;
}

export interface FxdaoCdpPosition extends DefiPositionBase {
  protocol: "fxdao";
  positionType: "cdp";
  denomination: string;
  collateralAmount: string;
  debtAmount: string;
}

export type DefiPosition =
  | BlendSupplyPosition
  | BlendBorrowPosition
  | AquariusLpPosition
  | SoroswapLpPosition
  | PhoenixLpPosition
  | PhoenixStakePosition
  | FxdaoCdpPosition;

/**
 * A position tagged with a supported protocol whose shape the adapter could not validate. Kept
 * distinct from "no position" so a caller (issue #147's gating) can surface it rather than treat
 * a parse failure as an account with nothing to unwind - the "no silent skips" invariant applied
 * to a provider field OctoPos does not formally type.
 */
export interface UnrecognizedDefiPosition {
  protocol: DefiProtocol;
  /** OctoPos's raw type tag (e.g. "SUPPLY"), kept for diagnostics even though it didn't parse. */
  rawType: string;
  reason: string;
}

/** Keyed by asset/contract address. Built from OctoPos's queryKeys.tokenInfos. */
export interface DefiEnrichmentEntry {
  symbol: string;
  decimals: number;
  usdPrice: string | null;
  priceSource: string | null;
}

/** A public Soroban RPC endpoint OctoPos suggests for a direct getLedgerEntries read. */
export interface DefiRpcEndpoint {
  url: string;
  health: string;
  avgLatencyMs: number;
}

export interface DefiRpcPolicy {
  maxKeysPerCall: number;
  recommendedConcurrency: number;
  backoffOn429Ms: number[];
  timeoutMs: number;
}

/**
 * Ready-made ledger keys plus pool/vault metadata for one protocol, letting a caller read
 * positions directly over RPC without OctoPos storing anything server-side (architecture.md
 * §7.1). Passed through typed rather than discarded, since issue #148's RPC fallback needs
 * exactly this and would otherwise have to refetch it.
 */
export interface DefiQueryKeysSlice {
  protocol: string;
  ledgerKeys: string[];
  poolAddresses: string[];
}

export interface DefiQueryKeys {
  rpcEndpoints: DefiRpcEndpoint[];
  rpcPolicy: DefiRpcPolicy;
  slices: Partial<Record<DefiProtocol, DefiQueryKeysSlice>>;
}

/**
 * The normalized DeFi position model every downstream consumer (exit adapters, plan preview)
 * depends on - no OctoPos-specific field names beyond this boundary (architecture.md §7.1).
 */
export interface DefiPositionsResult {
  address: string;
  network: Network;
  positions: DefiPosition[];
  unrecognizedPositions: UnrecognizedDefiPosition[];
  enrichment: Record<string, DefiEnrichmentEntry>;
  /** OctoPos's own freshness/provenance signal ("snapshot" | "empty" | "cache" | "not-tracked").
   *  Passed through verbatim rather than architecture.md's described (but not actually shipped)
   *  partial_result/attribution_confidence fields - see issue #147 for the gating that consumes
   *  this. */
  source: string;
  timestamp: string | null;
  queryKeys: DefiQueryKeys;
}
