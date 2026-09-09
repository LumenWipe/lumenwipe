import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from "@nestjs/swagger";
import type {
  AquariusLpPosition,
  AquariusPoolType,
  BlendBorrowPosition,
  BlendSupplyPosition,
  DefiEnrichmentEntry,
  DefiPosition,
  DefiPositionDisplay,
  DefiPositionsResult,
  DefiProtocol,
  DefiQueryKeys,
  DefiQueryKeysSlice,
  DefiRpcEndpoint,
  DefiRpcPolicy,
  FxdaoCdpPosition,
  PhoenixLpPosition,
  PhoenixStakePosition,
  SoroswapLpPosition,
  UnrecognizedDefiPosition,
} from "@lumenwipe/types";

// Documentation-only (see close/dto/close-requests.dto.ts's header comment for why).

const DEFI_PROTOCOLS: DefiProtocol[] = ["blend", "aquarius", "soroswap", "phoenix", "fxdao"];

export class DefiPositionDisplayDto implements DefiPositionDisplay {
  @ApiProperty({ description: "The pool, pair, or vault by name.", type: "string", nullable: true })
  pool!: string | null;

  @ApiProperty({
    description: 'Symbol of the position\'s asset; for an LP position, the pair (e.g. "XLM/USDC").',
    type: "string",
    nullable: true,
  })
  asset!: string | null;

  @ApiProperty({
    description: "Underlying amount in the asset's own units, decimal string - not shares/bTokens.",
    type: "string",
    nullable: true,
  })
  amount!: string | null;

  @ApiProperty({
    description: "The part of `amount` posted as collateral, when the protocol distinguishes it.",
    type: "string",
    nullable: true,
  })
  collateralAmount!: string | null;

  @ApiProperty({
    description: 'Current yield as a percentage with two decimals ("3.99").',
    type: "string",
    nullable: true,
  })
  yieldPct!: string | null;

  @ApiProperty({ enum: ["earned", "paid"], nullable: true, type: "string" })
  yieldKind!: "earned" | "paid" | null;

  @ApiPropertyOptional({
    description:
      'One protocol-specific closing clause, e.g. "9.95 XLM + 19.90 USDC". Null/absent when there is nothing to add.',
    type: "string",
    nullable: true,
  })
  detail?: string | null;
}

/** Fields common to every DefiPosition variant - not exported/decorated on its own since the
 *  union itself (below) is what a response ever actually contains. */
abstract class DefiPositionBaseDto {
  @ApiProperty({ enum: DEFI_PROTOCOLS })
  protocol!: DefiProtocol;

  @ApiProperty({ description: "Pool, market, or vault contract this position lives in." })
  contractAddress!: string;

  @ApiPropertyOptional({ type: DefiPositionDisplayDto })
  display?: DefiPositionDisplay;

  @ApiPropertyOptional({
    description: "wasmHash -> protocol-version registry hook (not yet populated).",
  })
  wasmHash?: string;

  @ApiProperty({ type: "string", nullable: true })
  usdValue!: string | null;
}

export class BlendSupplyPositionDto extends DefiPositionBaseDto implements BlendSupplyPosition {
  @ApiProperty({ enum: ["blend"] })
  override protocol!: "blend";

  @ApiProperty({ enum: ["supply"] })
  positionType!: "supply";

  @ApiProperty()
  assetAddress!: string;

  @ApiProperty()
  bTokenAmount!: string;

  @ApiPropertyOptional({
    description: "True when this supply is also posted as backstop collateral.",
  })
  isBackstop?: boolean;
}

export class BlendBorrowPositionDto extends DefiPositionBaseDto implements BlendBorrowPosition {
  @ApiProperty({ enum: ["blend"] })
  override protocol!: "blend";

  @ApiProperty({ enum: ["borrow"] })
  positionType!: "borrow";

  @ApiProperty()
  assetAddress!: string;

  @ApiProperty()
  dTokenAmount!: string;

  @ApiPropertyOptional()
  healthFactor?: string;
}

const AQUARIUS_POOL_TYPES: AquariusPoolType[] = ["constant_product", "stable", "concentrated"];

export class AquariusLpPositionDto extends DefiPositionBaseDto implements AquariusLpPosition {
  @ApiProperty({ enum: ["aquarius"] })
  override protocol!: "aquarius";

  @ApiProperty({ enum: ["lp"] })
  positionType!: "lp";

  @ApiProperty()
  shareAmount!: string;

  @ApiPropertyOptional({ description: "Reported by OctoPos alongside the LP position." })
  claimableAquaAmount?: string;

  @ApiPropertyOptional({
    description: "The pool's tokens in the pool's own order.",
    type: [String],
  })
  tokens?: string[];

  @ApiPropertyOptional({ description: "The pool's separate LP share token contract." })
  shareToken?: string;

  @ApiPropertyOptional({ enum: AQUARIUS_POOL_TYPES })
  poolType?: AquariusPoolType;
}

export class SoroswapLpPositionDto extends DefiPositionBaseDto implements SoroswapLpPosition {
  @ApiProperty({ enum: ["soroswap"] })
  override protocol!: "soroswap";

  @ApiProperty({ enum: ["lp"] })
  positionType!: "lp";

  @ApiProperty()
  shareAmount!: string;

  @ApiPropertyOptional({
    description: "The pair's two token contracts (token_0, token_1).",
    type: [String],
  })
  tokens?: [string, string];
}

export class PhoenixLpPositionDto extends DefiPositionBaseDto implements PhoenixLpPosition {
  @ApiProperty({ enum: ["phoenix"] })
  override protocol!: "phoenix";

  @ApiProperty({ enum: ["lp"] })
  positionType!: "lp";

  @ApiProperty()
  shareAmount!: string;
}

export class PhoenixStakePositionDto extends DefiPositionBaseDto implements PhoenixStakePosition {
  @ApiProperty({ enum: ["phoenix"] })
  override protocol!: "phoenix";

  @ApiProperty({ enum: ["stake"] })
  positionType!: "stake";

  @ApiProperty()
  stakedAmount!: string;

  @ApiProperty({ description: "Unix seconds; unbonding needs the original stake's timestamp." })
  stakedAtEpoch!: string;
}

export class FxdaoCdpPositionDto extends DefiPositionBaseDto implements FxdaoCdpPosition {
  @ApiProperty({ enum: ["fxdao"] })
  override protocol!: "fxdao";

  @ApiProperty({ enum: ["cdp"] })
  positionType!: "cdp";

  @ApiProperty()
  denomination!: string;

  @ApiProperty()
  collateralAmount!: string;

  @ApiProperty()
  debtAmount!: string;
}

/** Every DefiPosition variant, for @ApiExtraModels registration + the oneOf schema below.
 *  No single discriminator field disambiguates all 7: `protocol` alone collides for Blend's
 *  two variants and Phoenix's two, so this is documented as a plain oneOf list (Swagger UI
 *  still lets a reader browse every shape), not a discriminated oneOf. */
export const DEFI_POSITION_MODELS = [
  BlendSupplyPositionDto,
  BlendBorrowPositionDto,
  AquariusLpPositionDto,
  SoroswapLpPositionDto,
  PhoenixLpPositionDto,
  PhoenixStakePositionDto,
  FxdaoCdpPositionDto,
] as const;

export function defiPositionOneOfSchema() {
  return {
    oneOf: DEFI_POSITION_MODELS.map((model) => ({ $ref: getSchemaPath(model) })),
  };
}

export class UnrecognizedDefiPositionDto implements UnrecognizedDefiPosition {
  @ApiProperty({ enum: DEFI_PROTOCOLS })
  protocol!: DefiProtocol;

  @ApiProperty({ description: 'OctoPos\'s raw type tag (e.g. "SUPPLY"), kept for diagnostics.' })
  rawType!: string;

  @ApiProperty({ description: "Why the shape didn't validate." })
  reason!: string;
}

export class DefiEnrichmentEntryDto implements DefiEnrichmentEntry {
  @ApiProperty()
  symbol!: string;

  @ApiProperty()
  decimals!: number;

  @ApiProperty({ type: "string", nullable: true })
  usdPrice!: string | null;

  @ApiProperty({ type: "string", nullable: true })
  priceSource!: string | null;
}

export class DefiRpcEndpointDto implements DefiRpcEndpoint {
  @ApiProperty()
  url!: string;

  @ApiProperty()
  health!: string;

  @ApiProperty()
  avgLatencyMs!: number;
}

export class DefiRpcPolicyDto implements DefiRpcPolicy {
  @ApiProperty()
  maxKeysPerCall!: number;

  @ApiProperty()
  recommendedConcurrency!: number;

  @ApiProperty({ type: [Number] })
  backoffOn429Ms!: number[];

  @ApiProperty()
  timeoutMs!: number;
}

export class DefiQueryKeysSliceDto implements DefiQueryKeysSlice {
  @ApiProperty()
  protocol!: string;

  @ApiProperty({ type: [String] })
  ledgerKeys!: string[];

  @ApiProperty({ type: [String] })
  poolAddresses!: string[];
}

export class DefiQueryKeysDto implements DefiQueryKeys {
  @ApiProperty({ type: [DefiRpcEndpointDto] })
  rpcEndpoints!: DefiRpcEndpoint[];

  @ApiProperty({ type: DefiRpcPolicyDto })
  rpcPolicy!: DefiRpcPolicy;

  @ApiProperty({
    description: "Keyed by protocol; only protocols with a live slice are present.",
    type: "object",
    additionalProperties: { $ref: getSchemaPath(DefiQueryKeysSliceDto) },
  })
  slices!: Partial<Record<DefiProtocol, DefiQueryKeysSlice>>;
}

@ApiExtraModels(...DEFI_POSITION_MODELS)
export class DefiPositionsResultDto implements DefiPositionsResult {
  @ApiProperty()
  address!: string;

  @ApiProperty({ enum: ["mainnet", "testnet"] })
  network!: "mainnet" | "testnet";

  @ApiProperty({
    description: "Every detected position, in whichever of the 7 known shapes it actually is.",
    type: "array",
    items: defiPositionOneOfSchema(),
  })
  positions!: DefiPosition[];

  @ApiProperty({ type: [UnrecognizedDefiPositionDto] })
  unrecognizedPositions!: UnrecognizedDefiPosition[];

  @ApiProperty({
    description: "Keyed by asset/contract address.",
    type: "object",
    additionalProperties: { $ref: getSchemaPath(DefiEnrichmentEntryDto) },
  })
  enrichment!: Record<string, DefiEnrichmentEntry>;

  @ApiProperty({
    description:
      'OctoPos\'s own freshness/provenance signal ("snapshot" | "empty" | "cache" | "not-tracked").',
  })
  source!: string;

  @ApiProperty({ type: "string", nullable: true })
  timestamp!: string | null;

  @ApiProperty({ type: DefiQueryKeysDto })
  queryKeys!: DefiQueryKeys;
}
