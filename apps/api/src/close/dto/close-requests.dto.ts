import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type { DecisionAnswer } from "@lumenwipe/types";
import { BATCH_PLAN_MAX_ADDRESSES } from "@/lib/close-api/batch-plan";

// Documentation-only DTOs: they shape the OpenAPI spec (and the generated SDK
// types). Validation stays manual in the controllers to preserve the exact
// error-body contract, so these are intentionally not wired to a ValidationPipe.

export class ClosePlanRequestDto {
  @ApiProperty({ description: "Account to close (G...).", example: "GABC...XYZ" })
  source!: string;

  @ApiPropertyOptional({
    description: "Destination for the recovered XLM (G...). Omit to preview without a destination.",
    example: "GDEF...UVW",
  })
  destination?: string;

  @ApiPropertyOptional({
    description: "Answers to the plan's decision points (per-asset dispositions, etc.).",
    type: "array",
    items: { type: "object" },
  })
  decisions?: DecisionAnswer[];
}

export class BatchPlanRequestDto {
  @ApiProperty({
    description: `Accounts to plan (G...), up to ${BATCH_PLAN_MAX_ADDRESSES} per call.`,
    type: [String],
    example: ["GABC...XYZ", "GDEF...UVW"],
  })
  addresses!: string[];

  @ApiPropertyOptional({
    description: "Shared destination for the recovered XLM (G...). Omit to preview without one.",
    example: "GDEF...UVW",
  })
  destination?: string;
}

export class CloseTransactionsRequestDto {
  @ApiProperty({ description: "Account to close (G...).", example: "GABC...XYZ" })
  source!: string;

  @ApiProperty({ description: "Destination for the recovered XLM (G...).", example: "GDEF...UVW" })
  destination!: string;

  @ApiPropertyOptional({
    description: "Resolved decision answers; every balance-bearing asset must have a disposition.",
    type: "array",
    items: { type: "object" },
  })
  decisions?: DecisionAnswer[];

  @ApiPropertyOptional({
    description:
      "Deposit memo value for exchange destinations that require one. The memo type is taken from the exchange registry, not the client.",
    example: "1234567890",
  })
  memo?: string;

  @ApiPropertyOptional({
    description:
      "The planHash of the plan the user reviewed, sent with the first call after it. If the account's sequence or the answers differ from those the plan was built from, the call answers 409 state_changed. Omit it once a transaction of the close has confirmed.",
    pattern: "^[0-9a-f]{64}$",
  })
  planHash?: string;
}

export class SubmitRequestDto {
  @ApiProperty({
    description: "Signed transaction envelope (base64 XDR) produced by the client.",
    example: "AAAAAgAAAAB...",
  })
  signedXdr!: string;
}
