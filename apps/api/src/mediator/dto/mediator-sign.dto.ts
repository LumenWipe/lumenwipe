import { ApiProperty } from "@nestjs/swagger";

// Documentation-only DTO (see the note in close-requests.dto.ts).
export class MediatorSignRequestDto {
  @ApiProperty({
    description:
      "Unsigned atomic transaction (base64 XDR): op0 accountMerge into the mediator, op1 payment from the mediator to the destination.",
    example: "AAAAAgAAAAB...",
  })
  transaction!: string;
}
