import { ApiProperty } from "@nestjs/swagger";
import type { RegistryEntry, ServedRegistry } from "@/lib/exchange-registry";

// Documentation-only (see close/dto/close-requests.dto.ts's header comment for why).

export class RegistryEntryDto implements RegistryEntry {
  @ApiProperty({ description: "The exchange's deposit address (G...).", example: "GABC...XYZ" })
  address!: string;

  @ApiProperty({ description: "The exchange's display name.", example: "Example Exchange" })
  name!: string;

  @ApiProperty({ description: "The exchange's domain.", example: "example.com" })
  domain!: string;

  @ApiProperty({ description: "Whether closing into this exchange needs the mediator flow." })
  requiresMediator!: boolean;

  @ApiProperty({ description: "Whether a deposit memo is required." })
  requiresMemo!: boolean;

  @ApiProperty({
    description: "The required memo type, if requiresMemo is true.",
    enum: ["text", "id", "hash"],
  })
  memoType!: "text" | "id" | "hash";
}

export class ServedRegistryDto implements ServedRegistry {
  @ApiProperty({ description: "Registry file version.", example: "1.0.0" })
  version!: string;

  @ApiProperty({
    description:
      "The date a human last checked every entry against the exchanges' own deposit docs.",
    example: "2026-08-01",
  })
  lastVerified!: string;

  @ApiProperty({
    description: "After this date the data is treated as unusable, not merely old.",
    example: "2027-02-01",
  })
  validUntil!: string;

  @ApiProperty({ description: "Where this registry data was sourced from." })
  source!: string;

  @ApiProperty({ type: [RegistryEntryDto] })
  entries!: RegistryEntry[];
}
