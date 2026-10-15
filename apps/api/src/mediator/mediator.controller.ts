import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { MediatorSignRequestDto } from "./dto/mediator-sign.dto";
import { MediatorCheckResultDto, MediatorSignResponseDto } from "./dto/mediator-responses.dto";
import { ApiErrorResponse, ApiBodyErrorResponses } from "@/common/api-error-response.decorator";
import type { Network } from "@/config/networks";
import { MediatorSigningService } from "./mediator-signing.service";
import { NetworkFirstGuard } from "@/common/guards/network-first.guard";
import { GAddressPipe } from "@/common/pipes/g-address.pipe";
import { NetworkPipe } from "@/common/pipes/network.pipe";

@ApiTags("mediator")
@ApiBearerAuth("api-key")
@ApiParam({ name: "network", enum: ["testnet", "mainnet"] })
@ApiErrorResponse(401, "Missing or invalid API key.", ["unauthorized"])
@ApiErrorResponse(429, "Rate limit exceeded for this key.", ["rate_limited"])
@Controller(":network/mediator")
export class MediatorController {
  constructor(private readonly signing: MediatorSigningService) {}

  @ApiErrorResponse(400, "Missing/invalid transaction or disallowed structure.", [
    "invalid_network",
    "missing_transaction",
    "invalid_transaction_xdr",
    "transaction_structure_not_allowed",
    "merged_account_not_found",
    "forward_amount_exceeds_balance",
    "time_bounds_required",
    "transaction_expired",
    "invalid_body",
  ])
  @ApiErrorResponse(422, "The forward's memo does not meet the destination's memo rule.", [
    "memo_required",
    "unsupported_memo_type",
    "invalid_memo",
  ])
  @ApiErrorResponse(500, "The mediator key is misconfigured.", ["mediator_key_misconfiguration"])
  @ApiErrorResponse(
    503,
    "Mediator flow not configured on this server, or the destination could not be read.",
    ["mediator_not_configured", "service_unavailable"]
  )
  @ApiBodyErrorResponses()
  @Post("sign")
  @HttpCode(200)
  @ApiOperation({ summary: "Co-sign the mediator forwarding payment of an exchange close." })
  @ApiBody({ type: MediatorSignRequestDto })
  @ApiResponse({
    status: 200,
    description: "The transaction with the mediator signature added (base64 XDR).",
    type: MediatorSignResponseDto,
  })
  async sign(
    @Param("network", new NetworkPipe("Invalid network")) network: Network,
    @Body() body: { transaction?: string }
  ) {
    return this.signing.sign(network, body);
  }

  @ApiErrorResponse(400, "Invalid network or address.", ["invalid_network", "invalid_address"])
  @ApiErrorResponse(503, "The destination could not be read.", ["service_unavailable"])
  @UseGuards(new NetworkFirstGuard("Invalid network"))
  @Get("check/:address")
  @ApiOperation({ summary: "Check whether a destination needs the mediator flow and/or a memo." })
  @ApiParam({ name: "address", description: "Destination account (G...)." })
  @ApiResponse({
    status: 200,
    description: "Mediator/memo requirements for the destination.",
    type: MediatorCheckResultDto,
  })
  async check(
    @Param("network", new NetworkPipe("Invalid network")) network: `${Network}`,
    @Param("address", new GAddressPipe("invalid_address", "Invalid address")) address: string
  ) {
    return this.signing.checkDestination(network, address);
  }
}
