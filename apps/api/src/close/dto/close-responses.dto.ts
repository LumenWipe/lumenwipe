import { ApiProperty } from "@nestjs/swagger";
import type { SubmitResponse } from "@lumenwipe/types";

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
