import { Body, Controller, Get, HttpCode, Logger, Param, Post } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { RecordMergeResponse, StatsFeed, StatsTotals } from "@lumenwipe/types";
import { ApiErrorResponse, ApiBodyErrorResponses } from "@/common/api-error-response.decorator";
import { Public } from "@/auth/public.decorator";
import { isValidNetwork, type Network } from "@/config/networks";
import { fail } from "@/common/fail";
import { StatsService } from "./stats.service";
import {
  RecordMergeRequestDto,
  RecordMergeResponseDto,
  StatsFeedDto,
  StatsTotalsDto,
} from "./dto/stats.dto";

const TX_HASH_RE = /^[a-fA-F0-9]{64}$/;

function networkOrFail(network: string): Network {
  if (!isValidNetwork(network)) fail("invalid_network", "Invalid network.", 400);
  return network;
}

@ApiTags("stats")
@ApiParam({ name: "network", enum: ["testnet", "mainnet"] })
@ApiErrorResponse(503, "The stats store is unreachable.", ["stats_unavailable"])
@Controller("v1/:network/stats")
export class StatsController {
  private readonly logger = new Logger(StatsController.name);

  constructor(private readonly stats: StatsService) {}

  // Public: these are the numbers lumenwipe.com shows anyone, and no record ties a close to
  // the person who made it.
  @Public()
  @ApiErrorResponse(400, "Invalid network.", ["invalid_network"])
  @Get()
  @ApiOperation({ summary: "Accounts closed and XLM recovered (public, no API key)." })
  @ApiResponse({ status: 200, type: StatsTotalsDto })
  async totals(@Param("network") network: string): Promise<StatsTotals> {
    const net = networkOrFail(network);
    try {
      return await this.stats.totals(net);
    } catch (e) {
      this.unavailable("stats read failed", e);
    }
  }

  @Public()
  @ApiErrorResponse(400, "Invalid network.", ["invalid_network"])
  @Get("feed")
  @ApiOperation({ summary: "Totals, recent closes and daily activity (public, no API key)." })
  @ApiResponse({ status: 200, type: StatsFeedDto })
  async feed(@Param("network") network: string): Promise<StatsFeed> {
    const net = networkOrFail(network);
    try {
      return await this.stats.feed(net);
    } catch (e) {
      this.unavailable("stats feed read failed", e);
    }
  }

  @ApiErrorResponse(
    400,
    "Invalid network, transaction hash or JSON body, or the merge was not verified on the network.",
    ["invalid_network", "invalid_tx_hash", "tx_not_verified", "invalid_body"]
  )
  @ApiErrorResponse(401, "Missing or invalid API key.", ["unauthorized"])
  @ApiErrorResponse(429, "Rate limit exceeded for this key.", ["rate_limited"])
  @ApiBodyErrorResponses()
  @Post("merges")
  @HttpCode(200)
  @ApiBearerAuth("api-key")
  @ApiOperation({
    summary: "Count a confirmed close submitted outside this API.",
    description:
      "Closes submitted through `POST /v1/{network}/submit` are counted automatically. The " +
      "transaction is re-read from the network and counted only if it confirmed and merged an " +
      "account; repeating a hash never counts it twice.",
  })
  @ApiBody({ type: RecordMergeRequestDto })
  @ApiResponse({ status: 200, type: RecordMergeResponseDto })
  async record(
    @Param("network") network: string,
    @Body() body: { txHash?: unknown }
  ): Promise<RecordMergeResponse> {
    const net = networkOrFail(network);
    const { txHash } = body ?? {};
    if (typeof txHash !== "string" || !TX_HASH_RE.test(txHash)) {
      fail("invalid_tx_hash", "txHash must be a 64-character hex transaction hash.", 400);
    }

    let outcome: Awaited<ReturnType<StatsService["record"]>>;
    try {
      outcome = await this.stats.record(net, txHash.toLowerCase());
    } catch (e) {
      this.unavailable("stats record failed", e);
    }
    if (outcome === "unverified") {
      fail(
        "tx_not_verified",
        "That transaction is not a confirmed account merge on this network.",
        400
      );
    }
    return { counted: outcome === "counted" };
  }

  private unavailable(context: string, e: unknown): never {
    this.logger.error(context, e instanceof Error ? e.stack : String(e));
    fail("stats_unavailable", "Stats are temporarily unavailable.", 503);
  }
}
