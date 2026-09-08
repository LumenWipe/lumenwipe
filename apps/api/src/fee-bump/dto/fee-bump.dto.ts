import { ApiProperty } from "@nestjs/swagger";

// Documentation-only DTO (see the note in close-requests.dto.ts).
export class FeeBumpRequestDto {
  @ApiProperty({
    description:
      "The unsigned or user-signed wind-down transaction to sponsor (base64 XDR), inner fee set to zero.",
    example: "AAAAAgAAAAB...",
  })
  transaction!: string;
}
