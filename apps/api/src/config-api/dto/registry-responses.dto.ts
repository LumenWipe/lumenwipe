import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type { RegistryEntry, RegistrySignature, ServedRegistry } from "@/lib/exchange-registry";

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

  @ApiPropertyOptional({
    description:
      "Present only when the entry applies on testnet alone. Absent means it applies on every network.",
    enum: ["testnet"],
  })
  network?: "testnet";
}

export class RegistrySignatureDto implements RegistrySignature {
  @ApiProperty({ description: "Envelope version.", enum: [1], example: 1 })
  format!: 1;

  @ApiProperty({
    description:
      "Rises by one with every signed registry. A client never accepts a sequence below the one bundled with it.",
    example: 1,
  })
  sequence!: number;

  @ApiProperty({ description: "The day (UTC) the registry was signed.", example: "2026-11-27" })
  issuedAt!: string;

  @ApiProperty({
    description:
      "Base64 of the 64-byte Ed25519 signature, by one of the keys pinned in the clients, over a fixed label and the canonical JSON of the registry fields, the sequence and the issue date.",
  })
  signature!: string;
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

  @ApiPropertyOptional({
    type: RegistrySignatureDto,
    description:
      "The maintainers' signature over this registry. A client that verifies it may accept an exchange added after its release that needs the shared intermediary; without it, or when it does not verify, the registry can only make a client stricter.",
  })
  signature?: RegistrySignature;
}
