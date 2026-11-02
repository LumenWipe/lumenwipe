import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type { CloseStatusRemaining, CloseStatusResponse, SubmitResponse } from "@lumenwipe/types";

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
