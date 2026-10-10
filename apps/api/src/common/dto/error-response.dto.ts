import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type { ErrorCode } from "@lumenwipe/types";
import { ERROR_CODES } from "../error-codes";

export class ErrorBodyDto {
  @ApiProperty({
    enum: ERROR_CODES,
    description: "Stable machine-readable code. Branch on this, never on the message.",
  })
  code!: ErrorCode;

  @ApiProperty({ description: "Plain-language explanation. May be reworded." })
  message!: string;

  @ApiPropertyOptional({
    description: "Extra structured context, present only when there is more to say.",
  })
  details?: unknown;

  @ApiPropertyOptional({
    description:
      "The id of this request, also returned in the x-request-id header. Quote it when reporting a problem.",
  })
  requestId?: string;
}

export class ErrorResponseDto {
  @ApiProperty({ type: ErrorBodyDto })
  error!: ErrorBodyDto;
}
