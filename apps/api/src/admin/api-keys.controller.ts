import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Public } from "@/auth/public.decorator";
import {
  API_KEY_STORE,
  type ApiKeyRecord,
  type ApiKeyStore,
  type RateLimitOverride,
} from "@/auth/api-key-store";
import { ApiKeyDirectory } from "@/auth/api-key-directory";
import { MeteringService } from "@/metering/metering.service";
import { fail } from "@/common/fail";
import { AdminGuard } from "./admin.guard";
import { ApiKeyRecordDto } from "./dto/api-key-admin.dto";

function toRecordDto(record: ApiKeyRecord): ApiKeyRecordDto {
  return {
    id: record.hash,
    owner: record.owner,
    createdAt: record.createdAt.toISOString(),
    revokedAt: record.revokedAt ? record.revokedAt.toISOString() : null,
    rotatedFrom: record.rotatedFrom,
    rateLimit: record.rateLimit,
  };
}

/** Validates the optional `rateLimit` body field, or fails with a 400 naming the problem. */
function parseRateLimit(input: unknown): RateLimitOverride | null {
  if (input === undefined || input === null) return null;
  const candidate = input as { limit?: unknown; ttlMs?: unknown };
  if (
    // Number.isFinite, not typeof + > 0 alone: `Infinity` is a number greater than 0, and
    // passing it through would silently disable rate limiting for that key rather than
    // rejecting a malformed request.
    Number.isFinite(candidate.limit) &&
    (candidate.limit as number) > 0 &&
    Number.isFinite(candidate.ttlMs) &&
    (candidate.ttlMs as number) > 0
  ) {
    return { limit: candidate.limit as number, ttlMs: candidate.ttlMs as number };
  }
  fail(
    "invalid_rate_limit",
    "rateLimit must be { limit: positive number, ttlMs: positive number } or omitted.",
    400
  );
}

/**
 * Self-service API key management (issue #289) - admin-only for now. The integrator-facing auth
 * mechanism for true self-serve issuance (wallet vs. magic link) is decided outside this repo;
 * until then, an operator calls these on an integrator's behalf. `@Public()` skips the
 * integrator `ApiKeyGuard` entirely - `AdminGuard` is the only gate.
 */
@ApiExcludeController()
@Public()
@UseGuards(AdminGuard)
@Controller("admin/api-keys")
export class ApiKeysAdminController {
  constructor(
    @Inject(API_KEY_STORE) private readonly store: ApiKeyStore,
    private readonly metering: MeteringService,
    private readonly directory: ApiKeyDirectory
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: { owner?: unknown; rateLimit?: unknown }) {
    const owner = typeof body.owner === "string" ? body.owner.trim() : "";
    if (!owner) fail("invalid_owner", "A non-empty owner is required.", 400);
    const rateLimit = parseRateLimit(body.rateLimit);

    const { raw, record } = await this.store.create(owner, rateLimit);
    return { key: raw, record: toRecordDto(record) };
  }

  @Get()
  async list(@Query("owner") owner?: string) {
    if (!owner) fail("invalid_owner", "An owner query parameter is required.", 400);
    const records = await this.store.listByOwner(owner);
    const usage = await this.metering.usage(owner);
    return { keys: records.map((r) => ({ ...toRecordDto(r), usage })) };
  }

  @Post(":id/revoke")
  @HttpCode(200)
  async revoke(@Param("id") id: string) {
    const revoked = await this.store.revoke(id);
    if (!revoked) fail("api_key_not_found", "No key with that id.", 404);
    // Enforced immediately on this instance; see ApiKeyDirectory's docstring for the bounded
    // eventual-consistency window on any other instance.
    this.directory.invalidate(id);
    return { status: "revoked" };
  }

  @Post(":id/rotate")
  @HttpCode(200)
  async rotate(@Param("id") id: string) {
    const result = await this.store.rotate(id);
    if (!result) fail("api_key_not_found", "No active key with that id.", 404);
    this.directory.invalidate(id);
    return { key: result.raw, record: toRecordDto(result.record) };
  }
}
