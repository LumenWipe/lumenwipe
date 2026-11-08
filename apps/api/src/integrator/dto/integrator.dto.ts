import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { OwnerUsageDto } from "@/admin/dto/api-key-admin.dto";

// Documentation-only DTOs: validation stays manual in the controller to preserve the exact
// error-body contract (see admin/dto/api-key-admin.dto.ts).

export class ChallengeRequestDto {
  @ApiProperty({ description: "The Stellar account (G...) that will sign the challenge." })
  address!: string;
}

export class ChallengeResponseDto {
  @ApiProperty({ description: "The message to sign, per SEP-53." })
  message!: string;

  @ApiProperty({ description: "ISO 8601 time after which the challenge is rejected." })
  expiresAt!: string;
}

export class SessionRequestDto {
  @ApiProperty({ description: "The Stellar account (G...) that signed the challenge." })
  address!: string;

  @ApiProperty({ description: "The challenge message exactly as returned by the challenge call." })
  message!: string;

  @ApiProperty({ description: "Base64 ed25519 signature over the SEP-53 digest of the message." })
  signature!: string;
}

export class SessionResponseDto {
  @ApiProperty({ description: "Bearer token for the key-management endpoints." })
  token!: string;

  @ApiProperty({
    description: "ISO 8601 time after which the token is rejected, 30 minutes after issue.",
  })
  expiresAt!: string;
}

export class CreateIntegratorKeyRequestDto {
  @ApiPropertyOptional({
    description: "A name for the key, 1 to 64 printable characters after trimming.",
    maxLength: 64,
  })
  label?: string;

  @ApiPropertyOptional({
    description:
      "The networks the key may call. Omit for every network. A scoped key is refused on routes without a network.",
    enum: ["mainnet", "testnet"],
    isArray: true,
    minItems: 1,
  })
  networks?: ("mainnet" | "testnet")[];
}

export class IntegratorKeyRecordDto {
  @ApiProperty({
    description: "The key's id (the SHA-256 hash of the secret) - never the raw key.",
  })
  id!: string;

  @ApiProperty({ description: "ISO 8601." })
  createdAt!: string;

  @ApiProperty({ description: "ISO 8601, or null if still active.", nullable: true, type: String })
  revokedAt!: string | null;

  @ApiProperty({
    description: "The previous key's id, if this key replaced one.",
    nullable: true,
    type: String,
  })
  rotatedFrom!: string | null;

  @ApiProperty({ description: "The key's name, or null.", nullable: true, type: String })
  label!: string | null;

  @ApiProperty({
    description: "The networks the key may call, or null for every network.",
    nullable: true,
    enum: ["mainnet", "testnet"],
    isArray: true,
  })
  networks!: ("mainnet" | "testnet")[] | null;

  @ApiProperty({
    description:
      "ISO 8601 time the key last authenticated a request, or null. Written at most once a minute, so it can trail real use by about a minute.",
    nullable: true,
    type: String,
  })
  lastUsedAt!: string | null;
}

export class IntegratorKeyUsageDto {
  @ApiProperty({ description: "Successful requests with this key today (UTC)." })
  today!: number;

  @ApiProperty({ description: "Successful requests with this key over the last 30 UTC days." })
  last30Days!: number;

  @ApiProperty({
    description:
      "Requests with this key refused with 429 over the last 30 UTC days. Not part of the request counts.",
  })
  rateLimitedLast30Days!: number;
}

export class IntegratorKeyListEntryDto extends IntegratorKeyRecordDto {
  @ApiProperty({
    type: IntegratorKeyUsageDto,
    nullable: true,
    description: "This key's counts; null if unavailable.",
  })
  usage!: IntegratorKeyUsageDto | null;
}

export class ListIntegratorKeysResponseDto {
  @ApiProperty({ type: [IntegratorKeyListEntryDto] })
  keys!: IntegratorKeyListEntryDto[];

  @ApiProperty({
    type: OwnerUsageDto,
    nullable: true,
    description: "The wallet's request counts, shared by all its keys; null if unavailable.",
  })
  usage!: OwnerUsageDto | null;
}

export class IssuedIntegratorKeyResponseDto {
  @ApiProperty({ description: "The raw secret - shown exactly once, never retrievable again." })
  key!: string;

  @ApiProperty({ type: IntegratorKeyRecordDto })
  record!: IntegratorKeyRecordDto;
}

export class RevokeIntegratorKeyResponseDto {
  @ApiProperty({ enum: ["revoked"] })
  status!: "revoked";
}
