import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Post,
  UseFilters,
} from "@nestjs/common";
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
import { isValidGAddress } from "@/lib/utils/validation";
import { readAccountState } from "@/lib/close-api/read-account";
import { buildAccountPlan } from "@/lib/close-api/account-plan";
import { BATCH_PLAN_MAX_ADDRESSES, planBatch } from "@/lib/close-api/batch-plan";
import {
  isRegistryFresh,
  lookupExchange,
  requiresMediatorForAddress,
} from "@/lib/exchange-registry";
import { validateTransferDestinations } from "@/lib/close-api/transfer-destinations";
import {
  claimableBalanceDecisionId,
  claimedAmountsPerAsset,
  assetDecisionId,
  decisionIdFor,
  tokenConversionFloors,
  tokenAssetsById,
  tokenContractsFromAnswers,
  destinationDecisionId,
  isDestinationAcknowledged,
  isDefiPositionsAcknowledged,
  resolveClaimableBalanceSelections,
  resolveDispositions,
  resolveTransferDestinations,
  DESTINATION_ACK_CHOICE,
} from "@/lib/close-api/decisions";
import { assetsArrivingFromExits } from "@/lib/close-api/exit-payouts";
import { parseDecisions } from "@/lib/close-api/parse-decisions";
import { computePlanHash } from "@/lib/close-api/plan-response";
import { buildCloseTransactions, CloseBuildError } from "@/lib/close-api/build-transactions";
import { submitAndWait, InvalidSignatureError } from "@/lib/stellar/submit";
import { readTrustlinesOnly } from "@/lib/stellar/account-state";
import { TxTimeoutError, TxSubmitError } from "@/lib/utils/errors";
import { fail } from "@/common/fail";
import { PlanErrorFilter, TransactionErrorFilter } from "./domain-error.filters";
import { mapDomainError, PLAN_ERRORS, TRANSACTION_ERRORS } from "@/lib/close-api/domain-errors";
import { withTimeout } from "@/lib/utils/with-timeout";
import { StatsService } from "@/stats/stats.service";
import { signedXdrHasAccountMerge } from "@/stats/merge-verification";
import type { TransactionsResponse, Trustline } from "@lumenwipe/types";

/**
 * Reads a transfer destination's trustlines, treating "does not exist" as an answer rather than
 * an error.
 *
 * Only the trustlines: these addresses are named freely by the caller, one per asset, so the
 * full `readAccountState` - which also paginates offers and claimable balances and can enumerate
 * thousands of sponsorship operations - would turn one inbound request into an unbounded
 * upstream fan-out, and would fail a destination merely for holding more than 1000 offers.
 */
const COUNT_CLOSE_TIMEOUT_MS = 5_000;

const readDestinationTrustlines = async (
  address: string,
  net: Network
): Promise<{ trustlines: Trustline[] } | null> => readTrustlinesOnly(address, net);

@ApiTags("close")
@ApiBearerAuth("api-key")
@ApiParam({ name: "network", enum: ["testnet", "mainnet"] })
@ApiErrorResponse(401, "Missing or invalid API key.", ["unauthorized"])
@ApiErrorResponse(429, "Rate limit exceeded for this key.", ["rate_limited"])
@Controller("v1/:network")
export class CloseController {
  private readonly logger = new Logger(CloseController.name);

  constructor(private readonly stats: StatsService) {}

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
    const { source } = body;
    if (typeof source !== "string" || !isValidGAddress(source)) {
      fail("invalid_source", "A valid source account (G...) is required.", 400);
    }
    const destination = typeof body.destination === "string" ? body.destination : null;
    if (destination !== null && !isValidGAddress(destination)) {
      fail("invalid_destination", "Destination must be a valid account (G...).", 400);
    }
    const decisions = parseDecisions(body.decisions);

    try {
      return await buildAccountPlan(source, destination, decisions, network);
    } catch (e) {
      if (e instanceof HttpException || mapDomainError(PLAN_ERRORS, e)) throw e;
      this.logger.error("close/plan failed", e instanceof Error ? e.stack : String(e));
      fail("plan_failed", "Failed to build the close plan.", 500);
    }
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
    const { addresses } = body;
    if (!Array.isArray(addresses) || addresses.length === 0) {
      fail("invalid_addresses", "A non-empty array of source accounts (G...) is required.", 400);
    }
    if (addresses.length > BATCH_PLAN_MAX_ADDRESSES) {
      fail(
        "too_many_addresses",
        `At most ${BATCH_PLAN_MAX_ADDRESSES} addresses are allowed per batch.`,
        400
      );
    }
    if (!addresses.every((a): a is string => typeof a === "string" && isValidGAddress(a))) {
      fail("invalid_addresses", "Every address must be a valid Stellar account (G...).", 400);
    }
    const destination = typeof body.destination === "string" ? body.destination : null;
    if (destination !== null && !isValidGAddress(destination)) {
      fail("invalid_destination", "Destination must be a valid account (G...).", 400);
    }

    const results = await planBatch(addresses as string[], destination, network);
    return { results };
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
      "transfer_destination_missing",
      "conversion_floor_missing",
      "conversion_provider_unrecognized",
      "signer_normalization_unsafe",
      "trustline_deauthorized_with_balance",
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
  @ApiErrorResponse(
    503,
    "The exchange (mediator) flow or the exchange registry is not available.",
    ["mediator_not_configured", "registry_expired"]
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
    const { source, destination } = body;
    if (typeof source !== "string" || !isValidGAddress(source)) {
      fail("invalid_source", "A valid source account (G...) is required.", 400);
    }
    if (typeof destination !== "string" || !isValidGAddress(destination)) {
      fail("invalid_destination", "A valid destination account (G...) is required.", 400);
    }
    const decisions = parseDecisions(body.decisions);
    const memo = typeof body.memo === "string" ? body.memo : null;
    const exchange = lookupExchange(destination);
    if (requiresMediatorForAddress(destination) && exchange?.requiresMemo && !memo) {
      fail("memo_required", "This exchange destination requires a deposit memo.", 422, {
        memoType: exchange.memoType,
      });
    }
    if (memo !== null) {
      // The memo type comes from the exchange registry; direct destinations default to text.
      const memoType = exchange?.memoType ?? "text";
      if (memoType === "hash") {
        fail("unsupported_memo_type", "Hash memos are not supported.", 422);
      }
      if (memoType === "id" && !(/^\d+$/.test(memo) && BigInt(memo) <= 18446744073709551615n)) {
        fail(
          "invalid_memo",
          "This destination requires a numeric id memo within the uint64 range.",
          422
        );
      }
      if (memoType === "text" && Buffer.byteLength(memo, "utf8") > 28) {
        fail("invalid_memo", "A text memo must be at most 28 bytes.", 422);
      }
    }

    // A destination the registry does not recognize cannot be assumed to be a personal wallet,
    // and a direct merge into an exchange deposit address is unrecoverable (see
    // deriveDestinationDecisionPoints). The caller must assert control of it explicitly. This
    // gate lives here rather than only in the plan because the plan is advisory: an SDK caller
    // can reach this endpoint without ever having requested one.
    // The same expiry the served payload tells clients to honour, enforced here too. A rule the
    // server states and does not apply protects only the first-party web app: /close/transactions
    // is an API-key product surface with an SDK, and without this an integrator would build a
    // mediated close on memo rules nobody has re-checked in months. Scoped to listed exchanges,
    // because for a personal wallet nothing in the close depends on the registry.
    if (exchange !== null && !isRegistryFresh()) {
      fail(
        "registry_expired",
        "The exchange deposit-address registry has not been re-verified and is out of date. " +
          "Closing into an exchange on unchecked memo rules can send the funds somewhere that " +
          "cannot credit them, so this is refused until the registry is refreshed.",
        503
      );
    }

    if (exchange === null && !isDestinationAcknowledged(decisions, destination)) {
      fail(
        "destination_not_acknowledged",
        "This destination is not a recognized exchange deposit address. Confirm it is an account " +
          "you control before closing into it: a direct close into an exchange or custodial " +
          "address cannot be credited and the funds are lost.",
        422,
        { decisionId: destinationDecisionId(destination), choice: DESTINATION_ACK_CHOICE }
      );
    }

    try {
      const accountState = await readAccountState(
        source,
        network,
        tokenContractsFromAnswers(decisions)
      );

      // Selections resolve first: which assets can carry a disposition answer depends on which
      // claims will run, so the claim answers shape the asset universe below.
      const claimableBalanceSelections = resolveClaimableBalanceSelections(
        decisions,
        accountState.claimableBalances.map((b) => b.id)
      );
      const txClaimedPerAsset = claimedAmountsPerAsset(accountState, claimableBalanceSelections);

      // Held or arriving - an answer for an asset only the claims will fill must resolve, or
      // the gate below would demand an answer the resolution had just discarded.
      const assetsById = [
        ...[
          ...new Set([
            ...accountState.trustlines.map((tl) => tl.asset),
            ...txClaimedPerAsset.keys(),
          ]),
        ].map((asset) => ({ id: assetDecisionId(asset), asset })),
        ...tokenAssetsById(accountState),
      ];
      const dispositions = resolveDispositions(decisions, assetsById);
      const transferDestinations = resolveTransferDestinations(decisions, assetsById);
      const conversionFloors = tokenConversionFloors(decisions, assetsById);

      const authorizedTrustlineAssets = new Set(
        accountState.trustlines.filter((tl) => tl.authorized).map((tl) => tl.asset)
      );
      // Every asset the close will leave holding a balance needs its disposition answered
      // BEFORE the first round - the held ones and the ones the claims will fill. Gating only
      // on today's trustlines let a caller through round 1 (trustline added, balance claimed)
      // and refused them at round 2 for an answer this endpoint never asked for: the exact
      // dead-end the plan endpoint advertises against, replayed for direct API and SDK callers.
      const assetsNeedingDisposition = new Set([
        ...accountState.trustlines.filter((tl) => Number(tl.balance) > 0).map((tl) => tl.asset),
        ...txClaimedPerAsset.keys(),
        // And the ones a position's exit will pay in. Same dead-end as the claims above, reached
        // from the other side: the trustline is empty at round 1, the exit fills it, and round 2
        // refused to build for an answer this endpoint had never asked for.
        ...assetsArrivingFromExits(accountState),
      ]);
      // A Soroban token balance does not stop the merge, which is exactly why it must be
      // answered: without a decision it would be left behind in silence.
      for (const { asset } of tokenAssetsById(accountState)) assetsNeedingDisposition.add(asset);
      const missing = [...assetsNeedingDisposition]
        .filter((asset) => !(asset in dispositions))
        .map((asset) => decisionIdFor(asset));

      const missingClaimDecisions = accountState.claimableBalances
        .filter(
          (b) =>
            b.asset !== "native" &&
            !authorizedTrustlineAssets.has(b.asset) &&
            !claimableBalanceSelections[b.id]
        )
        .map((b) => claimableBalanceDecisionId(b.id));
      missing.push(...missingClaimDecisions);

      if (missing.length > 0) {
        fail(
          "needs_decisions",
          "Resolve every pending decision before requesting transactions.",
          422,
          { missing }
        );
      }

      // After the decision gate, never before: this reads one third-party account per distinct
      // destination, and a request that is going to be refused as incomplete should not pay for
      // that first.
      const transferProblems = await validateTransferDestinations(
        transferDestinations,
        accountState.trustlines,
        source,
        network,
        readDestinationTrustlines
      );
      if (transferProblems.length > 0) {
        fail("transfer_destination_unusable", transferProblems[0]!.message, 422, {
          problems: transferProblems,
        });
      }

      const result = await buildCloseTransactions(
        accountState,
        destination,
        dispositions,
        network,
        memo,
        claimableBalanceSelections,
        transferDestinations,
        {},
        {},
        { floors: conversionFloors },
        isDefiPositionsAcknowledged(decisions, source)
      );

      const planHash = computePlanHash({
        source,
        destination,
        decisions,
        snapshotLedger: Number(accountState.sequence),
      });

      const response: TransactionsResponse = {
        planHash,
        status: "ready",
        transactions: result.transactions,
        remaining: {
          steps: result.remainingSteps,
          requiresAnotherCall: result.requiresAnotherCall,
        },
      };
      return response;
    } catch (e) {
      if (e instanceof HttpException || mapDomainError(TRANSACTION_ERRORS, e)) throw e;
      if (e instanceof CloseBuildError) fail(e.code, e.message, e.status);
      this.logger.error("close/transactions failed", e instanceof Error ? e.stack : String(e));
      fail("transactions_failed", "Failed to build the close transactions.", 500);
    }
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
    const { signedXdr } = body;
    if (typeof signedXdr !== "string" || signedXdr.length === 0) {
      fail("invalid_signed_xdr", "A signed transaction envelope (signedXdr) is required.", 400);
    }

    try {
      const result = await submitAndWait(signedXdr, network);
      if (signedXdrHasAccountMerge(signedXdr)) await this.countClose(network, result.txHash);
      return { status: "success", hash: result.txHash, ledger: result.ledger };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      if (e instanceof InvalidSignatureError) {
        fail("invalid_signature", "The transaction is missing a valid signature.", 400);
      }
      if (e instanceof TxTimeoutError) {
        fail("confirmation_timeout", "The transaction did not confirm in time.", 504);
      }
      // Surface the network's plain-language rejection reason (insufficient
      // balance, bad sequence, no destination, ...) instead of a generic error,
      // so a failed close in the guided flow stays diagnosable.
      if (e instanceof TxSubmitError) {
        fail(
          "submit_rejected",
          e.message,
          502,
          e.resultCode ? { resultCode: e.resultCode } : undefined
        );
      }
      if (e instanceof Error && /xdr|envelope|decode/i.test(e.message)) {
        fail("invalid_signed_xdr", "The transaction envelope could not be decoded.", 400);
      }
      this.logger.error("submit failed", e instanceof Error ? e.stack : String(e));
      fail("submit_failed", "Failed to submit the transaction.", 502);
    }
  }

  /** Awaited, not fire-and-forget: Cloud Run stops giving the instance CPU once the response is
   *  sent. Bounded and never thrown, because the close itself already confirmed. */
  private async countClose(network: Network, txHash: string): Promise<void> {
    try {
      await withTimeout(this.stats.record(network, txHash), COUNT_CLOSE_TIMEOUT_MS, "timed out");
    } catch (e) {
      this.logger.warn(`could not count close ${txHash}: ${e instanceof Error ? e.message : e}`);
    }
  }
}
