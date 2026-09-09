import { ApiProperty } from "@nestjs/swagger";
import type { MediatorCheckResult, MediatorSignResponse } from "@lumenwipe/types";

// Documentation-only (see close/dto/close-requests.dto.ts's header comment for why).

export class MediatorSignResponseDto implements MediatorSignResponse {
  @ApiProperty({
    description: "The mediator-co-signed transaction envelope (base64 XDR).",
    example: "AAAAAgAAAAB...",
  })
  transaction!: string;
}

export class MediatorCheckResultDto implements MediatorCheckResult {
  @ApiProperty({ description: "Whether closing into this destination needs the mediator flow." })
  requiresMediator!: boolean;

  @ApiProperty({ description: "Plain-language reason for the requiresMediator value." })
  reason!: string;

  @ApiProperty({ description: "Whether the exchange requires a deposit memo." })
  requiresMemo!: boolean;

  @ApiProperty({
    description: "The memo type the exchange requires, or null if none/not applicable.",
    enum: ["text", "id", "hash"],
    nullable: true,
  })
  memoType!: "text" | "id" | "hash" | null;

  @ApiProperty({
    description: "The matched exchange's name, or null if the destination isn't a known exchange.",
    type: "string",
    nullable: true,
  })
  exchangeName!: string | null;

  @ApiProperty({
    description: "Whether the server can actually perform the mediator flow (secret configured).",
  })
  available!: boolean;
}
