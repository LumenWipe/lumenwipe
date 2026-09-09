import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from "@nestjs/swagger";
import type {
  AccountSigner,
  AccountState,
  AccountThresholds,
  ClaimableBalance,
  ClaimPredicate,
  DataEntry,
  DefiPositionsResult,
  OpenOffer,
  PlanBlocker,
  PoolShareEntry,
  SponsoredEntry,
  SorobanTokenBalance,
  SorobanTokenCoverage,
  SorobanTokenSource,
  SorobanTokensResult,
  Trustline,
} from "@lumenwipe/types";
import { PlanBlockerDto } from "@/common/dto/plan-blocker.dto";
import { DefiPositionsResultDto } from "./defi-position-responses.dto";

// Documentation-only (see close/dto/close-requests.dto.ts's header comment for why).

export class AccountSignerDto implements AccountSigner {
  @ApiProperty()
  key!: string;

  @ApiProperty()
  weight!: number;

  @ApiProperty({ enum: ["ed25519_public_key", "hash_x", "preauth_tx", "ed25519_signed_payload"] })
  type!: "ed25519_public_key" | "hash_x" | "preauth_tx" | "ed25519_signed_payload";
}

export class AccountThresholdsDto implements AccountThresholds {
  @ApiProperty()
  low!: number;

  @ApiProperty()
  med!: number;

  @ApiProperty()
  high!: number;
}

export class DataEntryDto implements DataEntry {
  @ApiProperty()
  key!: string;

  @ApiProperty({ description: "Base64-encoded value." })
  value!: string;
}

export class TrustlineDto implements Trustline {
  @ApiProperty({ description: '"CODE:ISSUER" or "native".' })
  asset!: string;

  @ApiProperty()
  balance!: string;

  @ApiPropertyOptional({
    description:
      "Only from the Horizon-compatible reader; RPC's getAssetBalance doesn't expose it.",
  })
  limit?: string;

  @ApiProperty()
  authorized!: boolean;

  @ApiProperty()
  issuer!: string;

  @ApiProperty()
  code!: string;
}

export class OpenOfferDto implements OpenOffer {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: '"CODE:ISSUER" or "native".' })
  selling!: string;

  @ApiProperty()
  buying!: string;

  @ApiProperty()
  amount!: string;

  @ApiProperty()
  price!: string;
}

export class PoolShareEntryDto implements PoolShareEntry {
  @ApiProperty({ description: "64-char hex, without the L prefix." })
  poolId!: string;
}

abstract class SponsoredEntryBaseDto {
  @ApiProperty({
    enum: ["account", "trustline", "offer", "data_entry", "signer", "claimable_balance"],
  })
  kind!: SponsoredEntry["kind"];
}

export class SponsoredAccountDto extends SponsoredEntryBaseDto {
  @ApiProperty({ enum: ["account"] })
  override kind!: "account";

  @ApiProperty()
  owner!: string;
}

export class SponsoredTrustlineDto extends SponsoredEntryBaseDto {
  @ApiProperty({ enum: ["trustline"] })
  override kind!: "trustline";

  @ApiProperty()
  owner!: string;

  @ApiProperty()
  asset!: string;
}

export class SponsoredOfferDto extends SponsoredEntryBaseDto {
  @ApiProperty({ enum: ["offer"] })
  override kind!: "offer";

  @ApiProperty()
  owner!: string;

  @ApiProperty()
  offerId!: string;
}

export class SponsoredDataEntryDto extends SponsoredEntryBaseDto {
  @ApiProperty({ enum: ["data_entry"] })
  override kind!: "data_entry";

  @ApiProperty()
  owner!: string;

  @ApiProperty()
  name!: string;
}

export class SponsoredSignerDto extends SponsoredEntryBaseDto {
  @ApiProperty({ enum: ["signer"] })
  override kind!: "signer";

  @ApiProperty()
  owner!: string;

  @ApiProperty()
  signerKey!: string;
}

export class SponsoredClaimableBalanceDto extends SponsoredEntryBaseDto {
  @ApiProperty({ enum: ["claimable_balance"] })
  override kind!: "claimable_balance";

  @ApiProperty()
  balanceId!: string;
}

// Paired explicitly with each model's real `kind` literal - constructing an instance and
// reading `.kind` off it does NOT work here (there is no runtime initializer behind the `!`
// definite-assignment fields these DTOs use purely for typing, so it reads back `undefined`
// for every model, collapsing the discriminator mapping to one bogus "undefined" entry).
const SPONSORED_ENTRY_MODELS = [
  { kind: "account", model: SponsoredAccountDto },
  { kind: "trustline", model: SponsoredTrustlineDto },
  { kind: "offer", model: SponsoredOfferDto },
  { kind: "data_entry", model: SponsoredDataEntryDto },
  { kind: "signer", model: SponsoredSignerDto },
  { kind: "claimable_balance", model: SponsoredClaimableBalanceDto },
] as const;

function sponsoredEntrySchema() {
  return {
    oneOf: SPONSORED_ENTRY_MODELS.map(({ model }) => ({ $ref: getSchemaPath(model) })),
    discriminator: {
      propertyName: "kind",
      mapping: Object.fromEntries(
        SPONSORED_ENTRY_MODELS.map(({ kind, model }) => [kind, getSchemaPath(model)])
      ),
    },
  };
}

/**
 * ClaimPredicate is a recursive discriminated union (and/or/not wrap other predicates). OpenAPI
 * can express recursive oneOf, but the result is materially harder to read in Swagger UI than
 * the shape it is documenting, for a field nothing in this API's own client code branches on
 * structurally (verify.ts treats a claimable balance as a black box until it is actually
 * claimed). Documented as one flexible object instead - every field optional, so a reader still
 * sees every possible key across every variant in one place.
 */
export class ClaimPredicateDto implements Record<string, unknown> {
  [key: string]: unknown;

  @ApiProperty({
    enum: ["unconditional", "and", "or", "not", "before_absolute_time", "before_relative_time"],
  })
  type!: ClaimPredicate["type"];

  @ApiPropertyOptional({
    description: '"and"/"or" only: the combined sub-predicates.',
    type: () => [ClaimPredicateDto],
  })
  predicates?: ClaimPredicate[];

  @ApiPropertyOptional({
    description: '"not" only: the negated sub-predicate.',
    type: () => ClaimPredicateDto,
  })
  predicate?: ClaimPredicate;

  @ApiPropertyOptional({
    description: '"before_absolute_time" only: Unix epoch seconds, as a string.',
  })
  absBeforeEpoch?: string;

  @ApiPropertyOptional({
    description: '"before_relative_time" only: seconds after claim creation.',
  })
  relBeforeSeconds?: string;

  @ApiPropertyOptional({
    description: '"before_relative_time" only: absolute deadline this resolves to.',
  })
  deadlineEpoch?: string;
}

export class ClaimableBalanceDto implements ClaimableBalance {
  @ApiProperty({ description: 'Full 72-char hex balance ID ("00000000" + 64-char hash).' })
  id!: string;

  @ApiProperty({ description: '"CODE:ISSUER" or "native".' })
  asset!: string;

  @ApiProperty()
  amount!: string;

  @ApiProperty({
    description: "One entry per claimant, each with its own predicate.",
    type: "array",
    items: {
      type: "object",
      properties: {
        destination: { type: "string" },
        predicate: { $ref: getSchemaPath(ClaimPredicateDto) },
      },
      required: ["destination", "predicate"],
    },
  })
  claimants!: { destination: string; predicate: ClaimPredicate }[];

  @ApiProperty({ type: "string", nullable: true })
  sponsor!: string | null;
}

const SOROBAN_TOKEN_SOURCES: SorobanTokenSource[] = [
  "explorer",
  "positions",
  "list",
  "events",
  "manual",
];

export class SorobanTokenBalanceDto implements SorobanTokenBalance {
  @ApiProperty({ description: "The token contract, C..." })
  contract!: string;

  @ApiProperty({
    description:
      'Base units, integer string. "0" only for a token not yet held whose detected exit will pay out.',
  })
  balance!: string;

  @ApiProperty({ type: "string", nullable: true })
  symbol!: string | null;

  @ApiProperty({ type: "integer", nullable: true })
  decimals!: number | null;

  @ApiProperty({ enum: SOROBAN_TOKEN_SOURCES, isArray: true })
  sources!: SorobanTokenSource[];
}

export class SorobanTokenCoverageDto implements SorobanTokenCoverage {
  @ApiProperty({ enum: SOROBAN_TOKEN_SOURCES })
  source!: SorobanTokenSource;

  @ApiProperty({ enum: ["ok", "failed", "skipped"] })
  status!: "ok" | "failed" | "skipped";

  @ApiPropertyOptional()
  detail?: string;
}

class EventsScannedRangeDto {
  @ApiProperty()
  fromLedger!: number;

  @ApiProperty()
  toLedger!: number;
}

export class SorobanTokensResultDto implements SorobanTokensResult {
  @ApiProperty({ type: [SorobanTokenBalanceDto] })
  tokens!: SorobanTokenBalance[];

  @ApiProperty({
    description: "Candidate contracts whose balance could not be read.",
    type: [String],
  })
  unreadable!: string[];

  @ApiProperty({ type: [SorobanTokenCoverageDto] })
  coverage!: SorobanTokenCoverage[];

  @ApiProperty({ type: EventsScannedRangeDto, nullable: true })
  eventsScanned!: { fromLedger: number; toLedger: number } | null;

  @ApiProperty({ type: [PlanBlockerDto] })
  warnings!: PlanBlocker[];
}

@ApiExtraModels(...SPONSORED_ENTRY_MODELS.map(({ model }) => model), ClaimPredicateDto)
export class AccountStateDto implements AccountState {
  @ApiProperty()
  address!: string;

  @ApiProperty({ enum: ["mainnet", "testnet"] })
  network!: "mainnet" | "testnet";

  @ApiProperty()
  sequence!: string;

  @ApiProperty()
  nativeBalanceLumens!: string;

  @ApiProperty({ type: [DataEntryDto] })
  dataEntries!: DataEntry[];

  @ApiProperty({ type: [AccountSignerDto] })
  signers!: AccountSigner[];

  @ApiProperty({ type: AccountThresholdsDto })
  thresholds!: AccountThresholds;

  @ApiProperty()
  numSubEntries!: number;

  @ApiProperty()
  numSponsoring!: number;

  @ApiProperty({
    description: "Ledger entries this account currently sponsors, on another account or itself.",
    type: "array",
    items: sponsoredEntrySchema(),
  })
  sponsoredEntries!: SponsoredEntry[];

  @ApiProperty({
    description: "True when sponsoredEntries could not be enumerated completely.",
  })
  sponsorshipEnumerationIncomplete!: boolean;

  @ApiProperty({ type: "string", nullable: true })
  sponsoredBy!: string | null;

  @ApiProperty({ description: "AUTH_IMMUTABLE is set - ACCOUNT_MERGE is permanently blocked." })
  authImmutable!: boolean;

  @ApiProperty({ type: [TrustlineDto] })
  trustlines!: Trustline[];

  @ApiProperty({ type: [OpenOfferDto] })
  openOffers!: OpenOffer[];

  @ApiProperty({ type: [PoolShareEntryDto] })
  poolShares!: PoolShareEntry[];

  @ApiProperty({ type: [ClaimableBalanceDto] })
  claimableBalances!: ClaimableBalance[];

  @ApiProperty({
    description:
      "True when the enumerated subentry count is lower than numSubEntries from the ledger.",
  })
  subEntryMismatch!: boolean;

  @ApiProperty({ type: DefiPositionsResultDto })
  defiPositions!: DefiPositionsResult;

  @ApiProperty({ type: [PlanBlockerDto] })
  defiPositionsWarnings!: PlanBlocker[];

  @ApiPropertyOptional({
    type: SorobanTokensResultDto,
    description:
      'Absent on account reads produced before this field existed - treat absence as "nothing known", never "nothing held".',
  })
  sorobanTokens?: SorobanTokensResult;
}
