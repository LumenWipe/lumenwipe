import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { ApiErrorResponse, ApiBodyErrorResponses } from "@/common/api-error-response.decorator";
import { Public } from "@/auth/public.decorator";
import { API_KEY_STORE, type ApiKeyRecord, type ApiKeyStore } from "@/auth/api-key-store";
import { ApiKeyDirectory } from "@/auth/api-key-directory";
import { MeteringService } from "@/metering/metering.service";
import { AuditLogger } from "@/common/audit-logger";
import { fail } from "@/common/fail";
import {
  IntegratorGuard,
  requireIntegratorConfig,
  type IntegratorRequest,
} from "./integrator.guard";
import {
  ChallengeRequestDto,
  ChallengeResponseDto,
  CreateIntegratorKeyRequestDto,
  IssuedIntegratorKeyResponseDto,
  ListIntegratorKeysResponseDto,
  RevokeIntegratorKeyResponseDto,
  SessionRequestDto,
  SessionResponseDto,
} from "./dto/integrator.dto";
import { parseLabel, parseNetworks } from "./key-options";
import { buildChallenge, isClassicAddress, issueSession, verifyChallenge } from "./wallet-auth";

const MAX_ACTIVE_KEYS_PER_OWNER = 5;

function toDto(record: ApiKeyRecord) {
  return {
    id: record.hash,
    createdAt: record.createdAt.toISOString(),
    revokedAt: record.revokedAt ? record.revokedAt.toISOString() : null,
    rotatedFrom: record.rotatedFrom,
    label: record.label,
    networks: record.networks,
    lastUsedAt: record.lastUsedAt ? record.lastUsedAt.toISOString() : null,
  };
}

/**
 * Wallet-authenticated self-service key management. The wallet address is the key `owner`, so
 * every operation is scoped to the session's own address and cannot touch anyone else's keys.
 */
@ApiTags("integrator")
@Public()
@ApiErrorResponse(429, "Rate limit exceeded for this key.", ["rate_limited"])
@Controller("v1/integrator")
export class IntegratorController {
  constructor(
    @Inject(API_KEY_STORE) private readonly store: ApiKeyStore,
    private readonly metering: MeteringService,
    private readonly directory: ApiKeyDirectory,
    private readonly audit: AuditLogger
  ) {}

  @ApiErrorResponse(400, "Missing or invalid address.", ["invalid_address", "invalid_body"])
  @ApiErrorResponse(503, "Self-serve key management is not configured.", [
    "integrator_api_not_configured",
  ])
  @ApiBodyErrorResponses()
  @Post("auth/challenge")
  @HttpCode(200)
  @ApiOperation({ summary: "Get a challenge transaction for a wallet to sign." })
  @ApiBody({ type: ChallengeRequestDto })
  @ApiResponse({ status: 200, description: "A challenge to sign.", type: ChallengeResponseDto })
  challenge(@Body() body: { address?: unknown }) {
    const secret = requireIntegratorConfig();
    if (!isClassicAddress(body.address)) {
      fail("invalid_address", "A valid Stellar account address (G...) is required.", 400);
    }
    return buildChallenge(secret, body.address);
  }

  @ApiErrorResponse(400, "Missing or invalid address, message or signature.", [
    "invalid_request",
    "invalid_body",
  ])
  @ApiErrorResponse(401, "The signed challenge is invalid or has expired.", ["invalid_challenge"])
  @ApiErrorResponse(503, "Self-serve key management is not configured.", [
    "integrator_api_not_configured",
  ])
  @ApiBodyErrorResponses()
  @Post("auth/session")
  @HttpCode(200)
  @ApiOperation({ summary: "Exchange a signed challenge for a short-lived session token." })
  @ApiBody({ type: SessionRequestDto })
  @ApiResponse({ status: 200, description: "A session token.", type: SessionResponseDto })
  session(@Body() body: { address?: unknown; message?: unknown; signature?: unknown }) {
    const secret = requireIntegratorConfig();
    const { address, message, signature } = body;
    if (
      !isClassicAddress(address) ||
      typeof message !== "string" ||
      typeof signature !== "string"
    ) {
      fail("invalid_request", "address, message and signature are required.", 400);
    }
    if (!verifyChallenge(secret, address, message, signature)) {
      fail("invalid_challenge", "The signed challenge is invalid or has expired.", 401);
    }
    return issueSession(secret, address);
  }

  @ApiErrorResponse(401, "Missing, invalid or expired session token.", ["unauthorized"])
  @ApiErrorResponse(503, "Self-serve key management is not configured.", [
    "integrator_api_not_configured",
  ])
  @Get("keys")
  @ApiBearerAuth("integrator-session")
  @UseGuards(IntegratorGuard)
  @ApiOperation({
    summary: "List the signed-in wallet's keys with its request counts.",
    description:
      "Counts cover the last 30 UTC days, today included, and survive a restart. A key's 429 count is written at most once a minute and can trail by that much.",
  })
  @ApiResponse({ status: 200, type: ListIntegratorKeysResponseDto })
  async list(@Req() req: IntegratorRequest) {
    const owner = req.integratorAddress!;
    const records = await this.store.listByOwner(owner);
    const report = await this.metering.report(owner);
    const none = { today: 0, last30Days: 0, rateLimitedLast30Days: 0 };
    return {
      keys: records.map((r) => ({
        ...toDto(r),
        usage: report ? (report.byKey[r.hash] ?? none) : null,
      })),
      usage: report?.owner ?? null,
    };
  }

  @ApiErrorResponse(400, "The label or networks are malformed.", [
    "invalid_label",
    "invalid_networks",
    "invalid_body",
  ])
  @ApiErrorResponse(401, "Missing, invalid or expired session token.", ["unauthorized"])
  @ApiErrorResponse(409, "The wallet already has the maximum active keys.", ["key_limit_reached"])
  @ApiErrorResponse(503, "Self-serve key management is not configured.", [
    "integrator_api_not_configured",
  ])
  @ApiBodyErrorResponses()
  @Post("keys")
  @HttpCode(201)
  @ApiBearerAuth("integrator-session")
  @UseGuards(IntegratorGuard)
  @ApiOperation({
    summary: "Create a key. The raw secret is returned exactly once.",
    description: `A wallet holds at most ${MAX_ACTIVE_KEYS_PER_OWNER} active keys. A key limited to some networks is refused with \`key_network_not_allowed\` on any other network and on routes that take no network. Label and networks cannot be changed later; rotation keeps them.`,
  })
  @ApiBody({ type: CreateIntegratorKeyRequestDto, required: false })
  @ApiResponse({
    status: 201,
    description: "The raw key, returned exactly once.",
    type: IssuedIntegratorKeyResponseDto,
  })
  async create(
    @Req() req: IntegratorRequest,
    @Body() body: { label?: unknown; networks?: unknown } | undefined
  ) {
    const owner = req.integratorAddress!;
    const label = parseLabel(body?.label);
    const networks = parseNetworks(body?.networks);
    return this.audit.track("api_key.create", owner, async (scope) => {
      scope.owner = owner;
      const active = (await this.store.listByOwner(owner)).filter((r) => !r.revokedAt);
      if (active.length >= MAX_ACTIVE_KEYS_PER_OWNER) {
        fail(
          "key_limit_reached",
          `You can have up to ${MAX_ACTIVE_KEYS_PER_OWNER} active keys. Revoke one to create another.`,
          409
        );
      }
      const { raw, record } = await this.store.create(owner, { label, networks });
      scope.keyHash = record.hash;
      return { key: raw, record: toDto(record) };
    });
  }

  @ApiErrorResponse(401, "Missing, invalid or expired session token.", ["unauthorized"])
  @ApiErrorResponse(404, "No key with that id.", ["api_key_not_found"])
  @ApiErrorResponse(503, "Self-serve key management is not configured.", [
    "integrator_api_not_configured",
  ])
  @ApiBodyErrorResponses()
  @Post("keys/:id/revoke")
  @HttpCode(200)
  @ApiBearerAuth("integrator-session")
  @UseGuards(IntegratorGuard)
  @ApiOperation({ summary: "Revoke one of the signed-in wallet's keys." })
  @ApiParam({ name: "id", description: "The key id." })
  @ApiResponse({ status: 200, description: "Revoked.", type: RevokeIntegratorKeyResponseDto })
  async revoke(@Req() req: IntegratorRequest, @Param("id") id: string) {
    const owner = req.integratorAddress!;
    return this.audit.track("api_key.revoke", owner, async (scope) => {
      scope.owner = owner;
      scope.keyHash = id;
      await this.requireOwned(owner, id);
      await this.store.revoke(id);
      this.directory.invalidate(id);
      return { status: "revoked" };
    });
  }

  @ApiErrorResponse(401, "Missing, invalid or expired session token.", ["unauthorized"])
  @ApiErrorResponse(404, "No active key with that id.", ["api_key_not_found"])
  @ApiErrorResponse(503, "Self-serve key management is not configured.", [
    "integrator_api_not_configured",
  ])
  @ApiBodyErrorResponses()
  @Post("keys/:id/rotate")
  @HttpCode(200)
  @ApiBearerAuth("integrator-session")
  @UseGuards(IntegratorGuard)
  @ApiOperation({ summary: "Revoke a key and issue its replacement." })
  @ApiParam({ name: "id", description: "The key id." })
  @ApiResponse({
    status: 200,
    description: "The new raw key, returned exactly once.",
    type: IssuedIntegratorKeyResponseDto,
  })
  async rotate(@Req() req: IntegratorRequest, @Param("id") id: string) {
    const owner = req.integratorAddress!;
    return this.audit.track("api_key.rotate", owner, async (scope) => {
      scope.owner = owner;
      scope.keyHash = id;
      await this.requireOwned(owner, id);
      const result = await this.store.rotate(id);
      if (!result) fail("api_key_not_found", "No active key with that id.", 404);
      scope.newKeyHash = result.record.hash;
      this.directory.invalidate(id);
      return { key: result.raw, record: toDto(result.record) };
    });
  }

  private async requireOwned(owner: string, id: string): Promise<void> {
    const record = await this.store.findByHash(id);
    if (!record || record.owner !== owner) fail("api_key_not_found", "No key with that id.", 404);
  }
}
