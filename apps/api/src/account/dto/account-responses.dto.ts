import { ApiProperty } from "@nestjs/swagger";
import type { ConversionPath, PathResponse, RevokeAllowanceResponse } from "@lumenwipe/types";

// Documentation-only (see close/dto/close-requests.dto.ts's header comment for why): these
// mirror @lumenwipe/types exactly and exist purely to give Swagger a real response schema.

export class ConversionPathDto implements ConversionPath {
  @ApiProperty({ description: "Asset code:issuer, or `native`.", example: "USDC:GA2H...ISSUER" })
  fromAsset!: string;

  @ApiProperty({ description: "Asset code:issuer, or `native`.", example: "native" })
  toAsset!: string;

  @ApiProperty({
    description: "Intermediate assets the path routes through, in order.",
    type: [String],
  })
  path!: string[];

  @ApiProperty({
    description: "Estimated amount received, before slippage floor.",
    example: "42.5000000",
  })
  estimatedReceive!: string;

  @ApiProperty({
    description: "The minimum accepted after slippage - the actual on-chain floor.",
    example: "42.0000000",
  })
  destMin!: string;
}

export class PathResponseDto implements PathResponse {
  // Always present in the response - possibly null, never omitted - so @ApiProperty with
  // nullable:true, not @ApiPropertyOptional (which would mark it omittable in the schema and
  // mislead a generated client into treating a missing `path` key as valid).
  @ApiProperty({
    description: "The conversion path, or null if none was found.",
    type: ConversionPathDto,
    nullable: true,
  })
  path!: ConversionPath | null;
}

export class RevokeAllowanceResponseDto implements RevokeAllowanceResponse {
  @ApiProperty({
    description: "Unsigned revocation transaction envelope (base64 XDR).",
    example: "AAAAAgAAAAB...",
  })
  transaction!: string;
}
