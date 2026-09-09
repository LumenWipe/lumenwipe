import { ApiProperty } from "@nestjs/swagger";
import type {
  Allowance,
  AllowanceCoverage,
  AllowanceSource,
  AllowancesResult,
  DefiProtocol,
  PlanBlocker,
} from "@lumenwipe/types";
import { PlanBlockerDto } from "@/common/dto/plan-blocker.dto";

// Documentation-only (see close/dto/close-requests.dto.ts's header comment for why).

const ALLOWANCE_SOURCES: AllowanceSource[] = ["events", "registry"];
const DEFI_PROTOCOLS: DefiProtocol[] = ["blend", "aquarius", "soroswap", "phoenix", "fxdao"];

export class AllowanceDto implements Allowance {
  @ApiProperty({ description: "The token contract, C...", example: "CABC...XYZ" })
  token!: string;

  @ApiProperty({
    description: "From the token's own symbol(), null when it does not answer.",
    type: "string",
    nullable: true,
    example: "USDC",
  })
  tokenSymbol!: string | null;

  @ApiProperty({
    description: "From the token's own decimals(), null when it does not answer.",
    type: "integer",
    nullable: true,
    example: 7,
  })
  tokenDecimals!: number | null;

  @ApiProperty({
    description:
      "The approved spender - almost always a contract (C...), occasionally an account (G...).",
    example: "CDEF...UVW",
  })
  spender!: string;

  @ApiProperty({
    description:
      "The spender's protocol, when its address resolves to a known DeFi contract registry " +
      "entry. Null does not mean unsafe - most legitimate spenders simply aren't in the registry.",
    type: "string",
    enum: DEFI_PROTOCOLS,
    nullable: true,
  })
  spenderProtocol!: DefiProtocol | null;

  @ApiProperty({
    description: "Base units, integer string, as allowance(from, spender) reports it live.",
    example: "1000000000",
  })
  amount!: string;

  @ApiProperty({
    description:
      "The ledger this allowance expires at, from the approve event that discovered it. Null " +
      "when the amount is confirmed live but no matching approve event was found (e.g. aged out " +
      "of the event scan's retention window) - the amount is still ground truth regardless.",
    type: "integer",
    nullable: true,
    example: 123456,
  })
  expirationLedger!: number | null;

  @ApiProperty({
    description: "Every source that proposed this (token, spender) pair.",
    enum: ALLOWANCE_SOURCES,
    isArray: true,
  })
  sources!: AllowanceSource[];
}

export class AllowanceCoverageDto implements AllowanceCoverage {
  @ApiProperty({ enum: ALLOWANCE_SOURCES })
  source!: AllowanceSource;

  @ApiProperty({ enum: ["ok", "failed", "skipped"] })
  status!: "ok" | "failed" | "skipped";

  @ApiProperty({ required: false, description: "Detail on a failed/skipped source." })
  detail?: string;
}

class EventsScannedDto {
  @ApiProperty({ description: "First ledger the event scan covered." })
  fromLedger!: number;

  @ApiProperty({ description: "Last ledger the event scan covered." })
  toLedger!: number;
}

export class AllowancesResultDto implements AllowancesResult {
  @ApiProperty({ type: [AllowanceDto] })
  allowances!: Allowance[];

  @ApiProperty({ type: [AllowanceCoverageDto] })
  coverage!: AllowanceCoverage[];

  @ApiProperty({
    description:
      "The ledger range the event scan covered, or null if it ran out of budget before starting.",
    type: EventsScannedDto,
    nullable: true,
  })
  eventsScanned!: { fromLedger: number; toLedger: number } | null;

  @ApiProperty({
    description: "Plain-language warnings: a source that failed, candidates dropped by the cap.",
    type: [PlanBlockerDto],
  })
  warnings!: PlanBlocker[];
}
