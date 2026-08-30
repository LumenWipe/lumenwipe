import { Body, Controller, HttpCode, HttpException, Logger, Param, Post } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import {
  ClosePlanRequestDto,
  CloseTransactionsRequestDto,
  SubmitRequestDto,
} from "./dto/close-requests.dto";
import { isValidNetwork, type Network } from "@/config/networks";
import { isValidGAddress } from "@/lib/utils/validation";
import { readAccountState } from "@/lib/close-api/read-account";
import { fetchConversionPath } from "@/lib/stellar/path-finding";
import { buildPlan } from "@/lib/stellar/tx-builder";
import {
  assessSponsorshipAffordability,
  type SponsorshipAffordability,
} from "@/lib/stellar/sponsorship-affordability";
import {
  isRegistryFresh,
  lookupExchange,
  requiresMediatorForAddress,
} from "@/lib/exchange-registry";
import { validateTransferDestinations } from "@/lib/close-api/transfer-destinations";
import { readTrustlinesOnly } from "@/lib/stellar/account-state";
import {
  assetDecisionId,
  claimableBalanceDecisionId,
  deriveClaimableBalanceDecisionPoints,
  deriveDecisionPoints,
  deriveDestinationDecisionPoints,
  destinationDecisionId,
  isDestinationAcknowledged,
  resolveClaimableBalanceSelections,
  resolveDispositions,
  resolveTransferDestinations,
  collectTransferDestinations,
  MissingTransferDestinationError,
  DESTINATION_ACK_CHOICE,
} from "@/lib/close-api/decisions";
import { assemblePlanResponse, computePlanHash } from "@/lib/close-api/plan-response";
import { buildCloseTransactions, CloseBuildError } from "@/lib/close-api/build-transactions";
import { submitAndWait, InvalidSignatureError } from "@/lib/stellar/submit";
import { TruncatedCollectionError } from "@/lib/stellar/horizon-http";
import {
  AccountNotFoundError,
  AssetRouteLostError,
  TxTimeoutError,
  TxSubmitError,
  UnusableProviderResponseError,
} from "@/lib/utils/errors";
import { BASE_FEE_STROOPS } from "@/config/constants";
import { fail } from "@/common/fail";
import type {
  DecisionAnswer,
  DecisionPoint,
  TransactionsResponse,
  Trustline,
} from "@lumenwipe/types";

/**
 * Reads a transfer destination's trustlines, treating "does not exist" as an answer rather than
 * an error.
 *
 * Only the trustlines: these addresses are named freely by the caller, one per asset, so the
 * full `readAccountState` - which also paginates offers and claimable balances and can enumerate
 * thousands of sponsorship operations - would turn one inbound request into an unbounded
 * upstream fan-out, and would fail a destination merely for holding more than 1000 offers.
 */
const readDestinationTrustlines = async (
  address: string,
  net: Network
): Promise<{ trustlines: Trustline[] } | null> => readTrustlinesOnly(address, net);

@ApiTags("close")
@ApiBearerAuth("api-key")
@ApiParam({ name: "network", enum: ["testnet", "mainnet"] })
@ApiResponse({ status: 401, description: "Missing or invalid API key." })
@ApiResponse({ status: 429, description: "Rate limit exceeded for this key." })
@Controller("v1/:network")
export class CloseController {
  private readonly logger = new Logger(CloseController.name);

  @Post("close/plan")
  @HttpCode(200)
  @ApiOperation({ summary: "Build a deterministic close plan with decision points and estimates." })
  @ApiBody({ type: ClosePlanRequestDto })
  @ApiResponse({
    status: 200,
    description: "Plan with pending decision points, fee and freed-reserve estimate.",
  })
  @ApiResponse({ status: 400, description: "Invalid network, source, destination, or JSON body." })
  @ApiResponse({ status: 404, description: "Source account not found." })
  async plan(
    @Param("network") network: string,
    @Body() body: { source?: unknown; destination?: unknown; decisions?: unknown }
  ) {
    if (!isValidNetwork(network)) fail("invalid_network", "Invalid network.", 400);

    const { source } = body;
    if (typeof source !== "string" || !isValidGAddress(source)) {
      fail("invalid_source", "A valid source account (G...) is required.", 400);
    }
    const destination = typeof body.destination === "string" ? body.destination : null;
    if (destination !== null && !isValidGAddress(destination)) {
      fail("invalid_destination", "Destination must be a valid account (G...).", 400);
    }
    const decisions: DecisionAnswer[] = Array.isArray(body.decisions)
      ? (body.decisions as DecisionAnswer[])
      : [];

    try {
      const accountState = await readAccountState(source, network);
      const mediatorRequired = destination ? requiresMediatorForAddress(destination) : false;

      const convertibility: Record<string, boolean> = {};
      const nonClaimableSponsoredEntries = accountState.sponsoredEntries.filter(
        (e) => e.kind !== "claimable_balance"
      );
      const convertibilityPromise = Promise.all(
        accountState.trustlines
          .filter((tl) => Number(tl.balance) > 0)
          .map(async (tl) => {
            const path = await fetchConversionPath(tl.asset, tl.balance, network).catch(() => null);
            convertibility[tl.asset] = path !== null;
          })
      );
      const sponsorshipAffordabilityPromise: Promise<SponsorshipAffordability> =
        accountState.sponsorshipEnumerationIncomplete
          ? Promise.resolve({ revocable: [], unaffordableOwners: new Map() })
          : assessSponsorshipAffordability(source, nonClaimableSponsoredEntries, network);
      const [, sponsorshipAffordability] = await Promise.all([
        convertibilityPromise,
        sponsorshipAffordabilityPromise,
      ]);

      const claimableBalanceSelections = resolveClaimableBalanceSelections(
        decisions,
        accountState.claimableBalances.map((b) => b.id)
      );
      const planAssetsById = accountState.trustlines.map((tl) => ({
        id: assetDecisionId(tl.asset),
        asset: tl.asset,
      }));
      // A transfer answer is well-formed whether or not it names a usable account, so both halves
      // are taken here. The destinations that resolved describe the plan's asset steps and feed
      // the live-ledger check below; the ones that did not go back on the pending list.
      const { destinations: planDestinations, missing: missingDestinations } =
        collectTransferDestinations(decisions, planAssetsById);
      const planDispositions = resolveDispositions(decisions, planAssetsById);

      const buildResult = buildPlan(
        accountState,
        mediatorRequired,
        false,
        claimableBalanceSelections,
        sponsorshipAffordability,
        planDispositions,
        planDestinations
      );
      const decisionPoints = [
        ...deriveDestinationDecisionPoints(destination),
        ...deriveDecisionPoints(accountState, convertibility),
        ...deriveClaimableBalanceDecisionPoints(accountState),
      ];
      const answeredIds = new Set(decisions.map((d) => d?.id));
      // The destination acknowledgement is judged on its choice, not merely on having been
      // answered. For every other decision the choice is re-validated downstream against a
      // known value set, so presence is a fair proxy; here the choice IS the content, and
      // reporting "ready" for an answer that /transactions will refuse leaves a caller with
      // a 422 and no pending decision to point at.
      const pending: DecisionPoint[] = decisionPoints.filter((dp) =>
        destination !== null && dp.id === destinationDecisionId(destination)
          ? !isDestinationAcknowledged(decisions, destination)
          : !answeredIds.has(dp.id)
      );

      // Same reasoning as the acknowledgement above, one step further out: a transfer answer is
      // well-formed whether or not it names a usable account, so it counts as answered and the
      // plan would report "ready" for a close /transactions then refuses. `missingDestinations`
      // (collected above, before the plan was built) is surfaced here instead - while the caller
      // can still change the answer, and while nothing has been built or signed.
      //
      // An answer with no usable destination is unanswered in the only sense that matters, so it
      // goes back on the pending list rather than being swallowed. The previous version relied on
      // it already being pending, which it never was: `pending` is keyed on the answer's id, and
      // the id is present.
      for (const asset of missingDestinations) {
        const id = assetDecisionId(asset);
        const point = decisionPoints.find((dp) => dp.id === id);
        if (point && !pending.includes(point)) pending.push(point);
      }

      const transferProblems = await validateTransferDestinations(
        planDestinations,
        accountState.trustlines,
        source,
        network,
        readDestinationTrustlines
      );
      if (transferProblems.length > 0) {
        buildResult.blockers = [
          ...buildResult.blockers,
          // No `code`: on PlanBlocker that field marks an acknowledged, non-trapping warning,
          // and these must trap. A close that cannot pay one of its assets is not a warning.
          ...transferProblems.map((p) => ({ message: p.message })),
        ];
      }

      const planHash = computePlanHash({
        source,
        destination,
        decisions,
        snapshotLedger: Number(accountState.sequence),
      });

      const totalOps = buildResult.steps.reduce((n, s) => n + s.operationCount, 0);
      const estimate = {
        feeStroops: String(totalOps * BASE_FEE_STROOPS),
        freedReserveXlm: ((2 + accountState.numSubEntries) * 0.5).toFixed(7),
      };

      return assemblePlanResponse({ buildResult, decisionPoints: pending, planHash, estimate });
    } catch (e) {
      if (e instanceof HttpException) throw e;
      if (e instanceof AccountNotFoundError) fail("account_not_found", e.message, 404);
      // A property of the account, with a message that explains it - not a server fault.
      if (e instanceof TruncatedCollectionError) fail("account_too_large", e.message, 422);
      // A misconfigured provider, with a message naming the fields it omitted - upstream of us
      // rather than a fault in the request, and actionable by whoever wired it in.
      if (e instanceof UnusableProviderResponseError) {
        fail("provider_response_unusable", e.message, 502);
      }
      this.logger.error("close/plan failed", e instanceof Error ? e.stack : String(e));
      fail("plan_failed", "Failed to build the close plan.", 500);
    }
  }

  @Post("close/transactions")
  @HttpCode(200)
  @ApiOperation({ summary: "Build the unsigned close transactions for a resolved plan." })
  @ApiBody({ type: CloseTransactionsRequestDto })
  @ApiResponse({
    status: 200,
    description: "Unsigned transaction envelopes ready for client signing.",
  })
  @ApiResponse({ status: 400, description: "Invalid network, source, destination, or JSON body." })
  @ApiResponse({ status: 404, description: "Source account not found." })
  @ApiResponse({ status: 409, description: "A conversion route drifted; re-plan and retry." })
  @ApiResponse({
    status: 422,
    description:
      "Unprocessable: unresolved asset dispositions, a required exchange memo is missing, the destination is not a recognized exchange address and has not been acknowledged (destination_not_acknowledged), a transfer disposition carries no usable destination (transfer_destination_missing), or a transfer destination cannot receive its asset (transfer_destination_unusable).",
  })
  @ApiResponse({
    status: 503,
    description: "The exchange (mediator) flow is not configured on this server.",
  })
  async transactions(
    @Param("network") network: string,
    @Body()
    body: {
      source?: unknown;
      destination?: unknown;
      decisions?: unknown;
      planHash?: unknown;
      memo?: unknown;
    }
  ) {
    if (!isValidNetwork(network)) fail("invalid_network", "Invalid network.", 400);

    const { source, destination } = body;
    if (typeof source !== "string" || !isValidGAddress(source)) {
      fail("invalid_source", "A valid source account (G...) is required.", 400);
    }
    if (typeof destination !== "string" || !isValidGAddress(destination)) {
      fail("invalid_destination", "A valid destination account (G...) is required.", 400);
    }
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
    const decisions: DecisionAnswer[] = Array.isArray(body.decisions)
      ? (body.decisions as DecisionAnswer[])
      : [];

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
      const accountState = await readAccountState(source, network);

      const assetsById = accountState.trustlines.map((tl) => ({
        id: assetDecisionId(tl.asset),
        asset: tl.asset,
      }));
      const dispositions = resolveDispositions(decisions, assetsById);
      const transferDestinations = resolveTransferDestinations(decisions, assetsById);

      const claimableBalanceSelections = resolveClaimableBalanceSelections(
        decisions,
        accountState.claimableBalances.map((b) => b.id)
      );
      const authorizedTrustlineAssets = new Set(
        accountState.trustlines.filter((tl) => tl.authorized).map((tl) => tl.asset)
      );
      const missing = accountState.trustlines
        .filter((tl) => Number(tl.balance) > 0 && !(tl.asset in dispositions))
        .map((tl) => assetDecisionId(tl.asset));

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
        transferDestinations
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
      if (e instanceof HttpException) throw e;
      if (e instanceof AccountNotFoundError) fail("account_not_found", e.message, 404);
      if (e instanceof AssetRouteLostError) {
        fail("quote_drifted", "A conversion route is no longer available; re-plan and retry.", 409);
      }
      if (e instanceof MissingTransferDestinationError) {
        fail("transfer_destination_missing", e.message, 422, {
          decisionId: assetDecisionId(e.asset),
        });
      }
      if (e instanceof CloseBuildError) fail(e.code, e.message, e.status);
      this.logger.error("close/transactions failed", e instanceof Error ? e.stack : String(e));
      fail("transactions_failed", "Failed to build the close transactions.", 500);
    }
  }

  @Post("submit")
  @HttpCode(200)
  @ApiOperation({ summary: "Submit a client-signed transaction and wait for confirmation." })
  @ApiBody({ type: SubmitRequestDto })
  @ApiResponse({ status: 200, description: "Confirmed: returns the transaction hash and ledger." })
  @ApiResponse({
    status: 400,
    description: "Invalid or unsigned/undecodable transaction envelope.",
  })
  @ApiResponse({ status: 502, description: "The network rejected the transaction." })
  @ApiResponse({ status: 504, description: "The transaction did not confirm in time." })
  async submit(@Param("network") network: string, @Body() body: { signedXdr?: unknown }) {
    if (!isValidNetwork(network)) fail("invalid_network", "Invalid network.", 400);

    const { signedXdr } = body;
    if (typeof signedXdr !== "string" || signedXdr.length === 0) {
      fail("invalid_signed_xdr", "A signed transaction envelope (signedXdr) is required.", 400);
    }

    try {
      const result = await submitAndWait(signedXdr, network);
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
}
