import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type {
  CloseDeliveredEntry,
  CloseDeliveredResponse,
  CloseStatusRemaining,
  CloseStatusResponse,
  SubmitResponse,
} from "@lumenwipe/types";

// Documentation-only, same convention as close-requests.dto.ts: these exist purely to give
// Swagger a real, navigable response schema instead of a prose description. They mirror
// @lumenwipe/types exactly - interfaces are erased at compile time, so a real class is the only
// thing that can carry this metadata, but the controller keeps returning/typing against the
// original interface; this is documentation, never what a handler actually builds.

export class SubmitResponseDto implements SubmitResponse {
  @ApiProperty({ enum: ["success"], example: "success" })
  status!: "success";

  @ApiProperty({ description: "The submitted transaction's hash.", example: "a1b2c3...d4e5f6" })
  hash!: string;

  @ApiProperty({ description: "The ledger the transaction was included in.", example: 123456 })
  ledger!: number;
}

class LookupSearchedDto {
  @ApiProperty({ example: 5395712 })
  oldestLedger!: number;

  @ApiProperty({ description: "Unix seconds.", example: 1793002147 })
  oldestLedgerCloseTime!: number;

  @ApiProperty({ example: 5516671 })
  latestLedger!: number;

  @ApiProperty({ description: "Unix seconds.", example: 1793606995 })
  latestLedgerCloseTime!: number;
}

export class TransactionLookupResponseDto {
  @ApiProperty({ enum: ["confirmed", "failed", "not_found"], example: "confirmed" })
  status!: "confirmed" | "failed" | "not_found";

  @ApiProperty({
    description: "The hash that was looked up, lowercase.",
    example: "a1b2c3...d4e5f6",
  })
  hash!: string;

  @ApiPropertyOptional({ description: "Set when confirmed or failed.", example: 123456 })
  ledger?: number;

  @ApiPropertyOptional({ description: "Set when failed: why, in plain language." })
  message?: string;

  @ApiPropertyOptional({ description: "Set when failed, if it could be decoded." })
  resultCode?: string;

  @ApiPropertyOptional({
    description: "Set when not_found: the ledger window this provider searched.",
    type: LookupSearchedDto,
  })
  searched?: LookupSearchedDto;
}

class CloseStatusRemainingDto implements CloseStatusRemaining {
  @ApiProperty({ example: 3 })
  subentries!: number;

  @ApiProperty({ example: 0 })
  sponsoring!: number;

  @ApiProperty({ example: 0 })
  sponsored!: number;
}

export class CloseStatusResponseDto implements CloseStatusResponse {
  @ApiProperty({ description: "The account asked about." })
  source!: string;

  @ApiProperty({ enum: ["open", "ready_to_merge", "closed", "unknown"], example: "open" })
  phase!: CloseStatusResponse["phase"];

  @ApiPropertyOptional({
    description: "Present while the account is on the ledger.",
    type: CloseStatusRemainingDto,
  })
  remaining?: CloseStatusRemaining;
}

class CloseDeliveredEntryDto {
  @ApiProperty({ description: "The hash asked about, lowercase.", example: "a1b2c3...d4e5f6" })
  hash!: string;

  @ApiProperty({ enum: ["delivered", "unavailable"], example: "delivered" })
  status!: CloseDeliveredEntry["status"];

  @ApiPropertyOptional({
    description:
      "Set when delivered: the XLM the transaction credited to the destination, in stroops, " +
      "from the ledger's result.",
    example: "52345000",
  })
  amountStroops?: string;

  @ApiPropertyOptional({
    enum: ["not_found", "failed", "no_delivery"],
    description:
      "Set when unavailable. `not_found`: no provider holds the hash. `failed`: the " +
      "transaction failed. `no_delivery`: it confirmed without a merge into the destination " +
      "or a forward of a merged balance to it.",
  })
  reason?: "not_found" | "failed" | "no_delivery";

  @ApiPropertyOptional({
    description: "The ledger the transaction is in; absent for not_found.",
    example: 123456,
  })
  ledger?: number;
}

export class CloseDeliveredResponseDto implements CloseDeliveredResponse {
  @ApiProperty({ description: "The destination asked about." })
  destination!: string;

  @ApiProperty({
    description: "One entry per requested hash, in the order asked.",
    type: [CloseDeliveredEntryDto],
  })
  entries!: CloseDeliveredEntry[];

  @ApiPropertyOptional({
    description:
      "The sum of every entry's amount, in stroops. Present only when every entry is delivered.",
    example: "52345000",
  })
  totalStroops?: string;
}
