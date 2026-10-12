import { Body, Controller, HttpCode, Param, Post, UseFilters } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  BatchPlanRequestDto,
  ClosePlanRequestDto,
  CloseTransactionsRequestDto,
  SubmitRequestDto,
} from "./dto/close-requests.dto";
import { SubmitResponseDto } from "./dto/close-responses.dto";
import { BatchPlanResponseDto, PlanResponseDto } from "./dto/plan-response.dto";
import { TransactionsResponseDto } from "./dto/transactions-response.dto";
import { ApiErrorResponse, ApiBodyErrorResponses } from "@/common/api-error-response.decorator";
import type { Network } from "@/config/networks";
import { NetworkPipe } from "@/common/pipes/network.pipe";
import { PlanErrorFilter, TransactionErrorFilter } from "./domain-error.filters";
import { CloseService } from "./close.service";

@ApiTags("close")
@ApiBearerAuth("api-key")
@ApiParam({ name: "network", enum: ["testnet", "mainnet"] })
@ApiErrorResponse(401, "Missing or invalid API key.", ["unauthorized"])
@ApiErrorResponse(429, "Rate limit exceeded for this key.", ["rate_limited"])
@Controller("v1/:network")
export class CloseController {
  constructor(private readonly close: CloseService) {}

  @ApiErrorResponse(400, "Invalid network, source, destination, or JSON body.", [
    "invalid_network",
    "invalid_source",
    "invalid_destination",
    "invalid_decisions",
    "invalid_body",
  ])
  @ApiErrorResponse(404, "Source account not found.", ["account_not_found"])
  @ApiErrorResponse(422, "The account is too large to plan in one request.", ["account_too_large"])
  @ApiErrorResponse(500, "The plan could not be built.", ["plan_failed"])
  @ApiErrorResponse(502, "The data provider returned an unusable response.", [
    "provider_response_unusable",
  ])
  @ApiErrorResponse(
    503,
    "The destination, the account's issued assets or the ledger could not be read. Retry.",
    ["destination_read_failed", "issuer_read_failed", "service_unavailable"]
  )
  @ApiBodyErrorResponses()
  @UseFilters(PlanErrorFilter)
  @Post("close/plan")
  @HttpCode(200)
  @ApiOperation({ summary: "Build a deterministic close plan with decision points and estimates." })
  @ApiBody({ type: ClosePlanRequestDto })
  @ApiResponse({
    status: 200,
    description: "Plan with pending decision points, fee and freed-reserve estimate.",
    type: PlanResponseDto,
  })
  async plan(
    @Param("network", new NetworkPipe()) network: Network,
    @Body() body: { source?: unknown; destination?: unknown; decisions?: unknown }
  ) {
    return this.close.plan(network, body);
  }

  @ApiErrorResponse(400, "Invalid network, addresses, destination, or JSON body.", [
    "invalid_network",
    "invalid_addresses",
    "too_many_addresses",
    "invalid_destination",
    "invalid_body",
  ])
  @ApiBodyErrorResponses()
  @Post("close/batch-plan")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Plan a bounded list of accounts in one call - what each holds, its wind-down steps, and " +
      "what lands at the shared destination. Read-only; no decisions are applied per address.",
  })
  @ApiBody({ type: BatchPlanRequestDto })
  @ApiResponse({
    status: 200,
    description:
      "One plan per address, in the same order as the request. An address that could not be " +
      "read or planned safely reports as its own `blocked` plan rather than failing the call.",
    type: BatchPlanResponseDto,
  })
  async batchPlan(
    @Param("network", new NetworkPipe()) network: Network,
    @Body() body: { addresses?: unknown; destination?: unknown }
  ) {
    return this.close.batchPlan(network, body);
  }

  @ApiErrorResponse(400, "Invalid network, source, destination, or JSON body.", [
    "invalid_network",
    "invalid_source",
    "invalid_destination",
    "invalid_decisions",
    "invalid_body",
  ])
  @ApiErrorResponse(404, "Source account not found.", ["account_not_found"])
  @ApiErrorResponse(409, "A conversion route drifted; re-plan and retry.", ["quote_drifted"])
  @ApiErrorResponse(
    422,
    "Unprocessable: the close cannot be built as asked. The code names the reason.",
    [
      "memo_required",
      "unsupported_memo_type",
      "invalid_memo",
      "destination_not_acknowledged",
      "needs_decisions",
      "transfer_destination_unusable",
      "merge_destination_unusable",
      "source_sequence_too_far",
      "transfer_destination_missing",
      "conversion_floor_missing",
      "conversion_provider_unrecognized",
      "signer_normalization_unsafe",
      "trustline_deauthorized_with_balance",
      "trustline_maintain_liabilities_with_balance",
      "issuer_supply_not_acknowledged",
      "claimable_balance_not_claimable_now",
      "defi_positions_blocked",
      "defi_positions_stale",
      "defi_position_unrecognized",
      "defi_exit_unsupported",
      "defi_exit_blocked",
      "aquarius_trustline_missing",
      "backstop_emissions_unclaimed",
      "backstop_token_unconvertible",
      "backstop_withdrawal_cooling_down",
      "backstop_withdrawal_not_queued",
      "blend_emissions_trustline_missing",
      "blend_repay_asset_balance_unknown",
      "blend_repay_asset_missing",
      "phoenix_trustline_missing",
      "soroswap_trustline_missing",
      "vault_undercollateralized",
      "withdraw_before_repay",
      "soroban_token_conversion_failed",
      "soroban_token_conversion_unavailable",
      "soroban_token_conversion_unsafe",
      "soroban_token_needs_restore",
      "soroban_token_transfer_failed",
      "soroban_token_transfer_unsafe",
      "soroban_token_route_lost",
      "soroban_token_unreadable",
      "trustline_cannot_be_left",
    ]
  )
  @ApiErrorResponse(500, "The transactions could not be built.", ["transactions_failed"])
  @ApiErrorResponse(502, "The data provider returned an unusable response.", [
    "provider_response_unusable",
  ])
  @ApiErrorResponse(
    503,
    "The exchange (mediator) flow or the exchange registry is not available, or the destination or ledger could not be read. Retry.",
    [
      "mediator_not_configured",
      "registry_expired",
      "destination_read_failed",
      "issuer_read_failed",
      "service_unavailable",
    ]
  )
  @ApiBodyErrorResponses()
  @UseFilters(TransactionErrorFilter)
  @Post("close/transactions")
  @HttpCode(200)
  @ApiOperation({ summary: "Build the unsigned close transactions for a resolved plan." })
  @ApiBody({ type: CloseTransactionsRequestDto })
  @ApiResponse({
    status: 200,
    description: "Unsigned transaction envelopes ready for client signing.",
    type: TransactionsResponseDto,
  })
  async transactions(
    @Param("network", new NetworkPipe()) network: Network,
    @Body()
    body: {
      source?: unknown;
      destination?: unknown;
      decisions?: unknown;
      planHash?: unknown;
      memo?: unknown;
    }
  ) {
    return this.close.transactions(network, body);
  }

  @ApiErrorResponse(
    400,
    "Invalid network, or invalid or unsigned/undecodable transaction envelope.",
    ["invalid_network", "invalid_signed_xdr", "invalid_signature", "invalid_body"]
  )
  @ApiErrorResponse(502, "The network rejected the transaction.", [
    "submit_rejected",
    "submit_failed",
  ])
  @ApiErrorResponse(504, "The transaction did not confirm in time.", ["confirmation_timeout"])
  @ApiBodyErrorResponses()
  @Post("submit")
  @HttpCode(200)
  @ApiOperation({ summary: "Submit a client-signed transaction and wait for confirmation." })
  @ApiBody({ type: SubmitRequestDto })
  @ApiResponse({
    status: 200,
    description: "Confirmed: returns the transaction hash and ledger.",
    type: SubmitResponseDto,
  })
  async submit(
    @Param("network", new NetworkPipe()) network: Network,
    @Body() body: { signedXdr?: unknown }
  ) {
    return this.close.submit(network, body);
  }
}
