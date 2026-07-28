import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type { DecisionAnswer } from "@lumenwipe/types";

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
}

export class SubmitRequestDto {
  @ApiProperty({
    description: "Signed transaction envelope (base64 XDR) produced by the client.",
    example: "AAAAAgAAAAB...",
  })
  signedXdr!: string;
}
