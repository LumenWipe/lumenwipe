import { HttpException, Inject, Injectable, Logger } from "@nestjs/common";
import type { Network } from "@/config/networks";
import { isValidGAddress } from "@/lib/utils/validation";
import { BATCH_PLAN_MAX_ADDRESSES } from "@/lib/close-api/batch-plan";
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
  isIssuerSupplyAcknowledged,
  resolveClaimSelections,
  resolveDispositions,
  resolveTransferDestinations,
  DESTINATION_ACK_CHOICE,
} from "@/lib/close-api/decisions";
import { assetsArrivingFromExits } from "@/lib/close-api/exit-payouts";
import { preflightErrorCode } from "@/lib/close-api/merge-preflight";
import { parseDecisions } from "@/lib/close-api/parse-decisions";
import { computePlanHash } from "@/lib/close-api/plan-response";
import { memoRuleFor, requestMemoProblem } from "@/lib/close-api/memo-rules";
import { CloseBuildError } from "@/lib/close-api/build-transactions";
import {
  CLAIM_ANSWER_STALE_MESSAGE,
  claimStatus,
  selectionFitsStatus,
} from "@/lib/stellar/claim-predicates";
import { InvalidSignatureError } from "@/lib/stellar/signature";
import { InvalidXdrError, TxTimeoutError, TxSubmitError } from "@/lib/utils/errors";
import { fail } from "@/common/fail";
import { mapDomainError, PLAN_ERRORS, TRANSACTION_ERRORS } from "@/lib/close-api/domain-errors";
import { withTimeout } from "@/lib/utils/with-timeout";
import { StatsService } from "@/stats/stats.service";
import { builtCloseHashes, signedXdrHasAccountMerge } from "@/stats/merge-verification";
import type { TransactionsResponse, Trustline } from "@lumenwipe/types";
import {
  CLOCK,
  CLOSE_BUILDER,
  CLOSE_READER,
  EXCHANGE_REGISTRY,
  TRANSACTION_SUBMITTER,
  type Clock,
  type CloseBuilderPort,
  type CloseReaderPort,
  type ExchangeRegistryPort,
  type TransactionSubmitterPort,
} from "@/common/ports";

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

@Injectable()
export class CloseService {
  private readonly logger = new Logger("CloseController");

  constructor(
    private readonly stats: StatsService,
    @Inject(CLOSE_READER) private readonly reader: CloseReaderPort,
    @Inject(CLOSE_BUILDER) private readonly builder: CloseBuilderPort,
    @Inject(TRANSACTION_SUBMITTER) private readonly submitter: TransactionSubmitterPort,
    @Inject(EXCHANGE_REGISTRY) private readonly registry: ExchangeRegistryPort,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  private readonly readDestinationTrustlines = async (
    address: string,
    net: Network
  ): Promise<{ trustlines: Trustline[] } | null> => this.reader.readTrustlinesOnly(address, net);

  async plan(
    network: Network,
    body: { source?: unknown; destination?: unknown; decisions?: unknown }
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
      return await this.reader.buildAccountPlan(source, destination, decisions, network);
    } catch (e) {
      if (e instanceof HttpException || mapDomainError(PLAN_ERRORS, e)) throw e;
      this.logger.error("close/plan failed", e instanceof Error ? e.stack : String(e));
      fail("plan_failed", "Failed to build the close plan.", 500);
    }
  }

  async batchPlan(network: Network, body: { addresses?: unknown; destination?: unknown }) {
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

    const results = await this.reader.planBatch(addresses as string[], destination, network);
    return { results };
  }

  async transactions(
    network: Network,
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
    const memo = typeof body.memo === "string" && body.memo !== "" ? body.memo : null;
    const exchange = this.registry.lookup(destination);
    const requiredOnChain =
      memo === null && !exchange?.requiresMemo
        ? await this.reader.readMemoRequired(destination, network)
        : false;
    const memoProblem = requestMemoProblem(memo, memoRuleFor(exchange, requiredOnChain));
    if (memoProblem) fail(memoProblem.code, memoProblem.message, 422, memoProblem.details);

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
    if (exchange !== null && !this.registry.isFresh(this.clock())) {
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
      const accountState = await this.reader.readAccountState(
        source,
        network,
        tokenContractsFromAnswers(decisions)
      );

      // Selections resolve first: which assets can carry a disposition answer depends on which
      // claims will run, so the claim answers shape the asset universe below.
      const claimableBalanceSelections = resolveClaimSelections(decisions, accountState);
      const mismatched = accountState.claimableBalances.some((b) => {
        const selection = claimableBalanceSelections[b.id];
        return (
          selection !== undefined &&
          !selectionFitsStatus(
            selection,
            claimStatus(b, accountState, accountState.ledgerCloseTime)
          )
        );
      });
      if (mismatched) fail("claimable_balance_not_claimable_now", CLAIM_ANSWER_STALE_MESSAGE, 422);
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
            claimStatus(b, accountState, accountState.ledgerCloseTime) !== "claimable" &&
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

      const mergeProblems = await this.builder.assessMergePreflight(
        accountState,
        destination,
        network
      );
      if (mergeProblems.length > 0) {
        fail(preflightErrorCode(mergeProblems[0]!), mergeProblems[0]!.message, 422, {
          problems: mergeProblems,
        });
      }

      // After the decision gate, never before: this reads one third-party account per distinct
      // destination, and a request that is going to be refused as incomplete should not pay for
      // that first.
      const transferProblems = await this.builder.validateTransferDestinations(
        transferDestinations,
        accountState.trustlines,
        source,
        network,
        this.readDestinationTrustlines
      );
      if (transferProblems.length > 0) {
        fail("transfer_destination_unusable", transferProblems[0]!.message, 422, {
          problems: transferProblems,
        });
      }

      const result = await this.builder.buildCloseTransactions(
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
        isDefiPositionsAcknowledged(decisions, source),
        { acknowledged: isIssuerSupplyAcknowledged(decisions, source) }
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
      await this.rememberBuiltCloses(network, result.transactions);
      return response;
    } catch (e) {
      if (e instanceof HttpException || mapDomainError(TRANSACTION_ERRORS, e)) throw e;
      if (e instanceof CloseBuildError) fail(e.code, e.message, e.status);
      this.logger.error("close/transactions failed", e instanceof Error ? e.stack : String(e));
      fail("transactions_failed", "Failed to build the close transactions.", 500);
    }
  }

  async submit(network: Network, body: { signedXdr?: unknown }) {
    const { signedXdr } = body;
    if (typeof signedXdr !== "string" || signedXdr.length === 0) {
      fail("invalid_signed_xdr", "A signed transaction envelope (signedXdr) is required.", 400);
    }

    try {
      const result = await this.submitter.submitAndWait(signedXdr, network);
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
      if (e instanceof InvalidXdrError) {
        fail("invalid_signed_xdr", "The transaction envelope could not be decoded.", 400);
      }
      this.logger.error("submit failed", e instanceof Error ? e.stack : String(e));
      fail("submit_failed", "Failed to submit the transaction.", 502);
    }
  }

  /** Bounded and never thrown: a close is never refused because the counter is unreachable. */
  private async rememberBuiltCloses(network: Network, transactions: { xdr: string }[]) {
    const hashes = builtCloseHashes(transactions, network);
    if (hashes.length === 0) return;
    try {
      await withTimeout(
        this.stats.rememberBuilt(network, hashes),
        COUNT_CLOSE_TIMEOUT_MS,
        "timed out"
      );
    } catch (e) {
      this.logger.warn(`could not note built close: ${e instanceof Error ? e.message : e}`);
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
