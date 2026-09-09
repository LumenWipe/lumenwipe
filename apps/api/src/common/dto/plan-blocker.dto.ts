import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type { PlanBlocker } from "@lumenwipe/types";

// Documentation-only (see close/dto/close-requests.dto.ts's header comment for why). Shared
// across every response that carries PlanBlocker (allowances, account, plan) so it's decorated
// once rather than once per consumer.

export class PlanBlockerDto implements PlanBlocker {
  @ApiProperty({ description: "Plain-language explanation." })
  message!: string;

  @ApiPropertyOptional({ description: "A docs link with more detail." })
  helpUrl?: string;

  @ApiPropertyOptional({
    description:
      "Distinguishes an acknowledged, non-trapping warning (e.g. a chosen forfeit) from a hard " +
      "blocker. Absent means the generic hard-blocking case.",
  })
  code?: string;
}
