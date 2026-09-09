import { ApiProperty } from "@nestjs/swagger";
import type { FeeBumpSponsorResponse } from "@lumenwipe/types";

// Documentation-only (see close/dto/close-requests.dto.ts's header comment for why).

export class FeeBumpSponsorResponseDto implements FeeBumpSponsorResponse {
  @ApiProperty({
    description: "The fee-bumped transaction envelope (base64 XDR), signed by the sponsor.",
    example: "AAAABQAAAAB...",
  })
  transaction!: string;
}
