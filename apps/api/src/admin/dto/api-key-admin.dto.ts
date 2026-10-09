import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

// Documentation-only DTOs (see close/dto/close-requests.dto.ts's header comment for why):
// validation stays manual in the controller to preserve the exact error-body contract.

export class RateLimitOverrideDto {
  @ApiProperty({ description: "Max requests per window for this key." })
  limit!: number;

  @ApiProperty({ description: "Window length, in milliseconds." })
  ttlMs!: number;
}

export class CreateApiKeyRequestDto {
  @ApiProperty({ description: "Integrator identity - used for metering and grouping keys." })
  owner!: string;

  @ApiPropertyOptional({
    description: "Per-key rate limit override. Omit to use the server's global default.",
    type: RateLimitOverrideDto,
  })
  rateLimit?: RateLimitOverrideDto;
}

export class ApiKeyRecordDto {
  @ApiProperty({
    description: "The key's id (the SHA-256 hash of the secret) - never the raw key.",
  })
  id!: string;

  @ApiProperty() owner!: string;

  @ApiProperty({ description: "ISO 8601." }) createdAt!: string;

  @ApiPropertyOptional({ description: "ISO 8601, or null if still active.", nullable: true })
  revokedAt!: string | null;

  @ApiPropertyOptional({
    description: "The previous key's id, if this key replaced one.",
    nullable: true,
  })
  rotatedFrom!: string | null;

  @ApiPropertyOptional({ type: RateLimitOverrideDto, nullable: true })
  rateLimit!: RateLimitOverrideDto | null;
}

export class CreateApiKeyResponseDto {
  @ApiProperty({ description: "The raw secret - shown exactly once, never retrievable again." })
  key!: string;

  @ApiProperty({ type: ApiKeyRecordDto })
  record!: ApiKeyRecordDto;
}

export class OwnerUsageDto {
  @ApiProperty({ description: "Successful keyed requests by this owner today (UTC)." })
  today!: number;

  @ApiProperty({
    description: "Successful keyed requests by this owner over the last 30 UTC days.",
  })
  last30Days!: number;
}

export class ApiKeyUsageDto extends ApiKeyRecordDto {
  @ApiProperty({
    type: OwnerUsageDto,
    nullable: true,
    description: "The owner's request counts, shared by all its keys; null if unavailable.",
  })
  usage!: OwnerUsageDto | null;
}

export class ListApiKeysResponseDto {
  @ApiProperty({ type: [ApiKeyUsageDto] })
  keys!: ApiKeyUsageDto[];
}
