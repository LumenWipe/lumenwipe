import { Body, Controller, HttpCode, HttpException, Logger, Param, Post } from "@nestjs/common";
import { isValidNetwork } from "@/config/networks";
import { isValidGAddress } from "@/lib/utils/validation";
import { readAccountState } from "@/lib/close-api/read-account";
import { fetchConversionPath } from "@/lib/se-api/paths";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { requiresMediatorForAddress } from "@/lib/exchange-registry";
import {
  assetDecisionId,
  deriveDecisionPoints,
  resolveDispositions,
} from "@/lib/close-api/decisions";
import { assemblePlanResponse, computePlanHash } from "@/lib/close-api/plan-response";
import { buildCloseTransactions, CloseBuildError } from "@/lib/close-api/build-transactions";
import { submitAndWait, InvalidSignatureError } from "@/lib/stellar/submit";
import { AccountNotFoundError, AssetRouteLostError, TxTimeoutError } from "@/lib/utils/errors";
import { BASE_FEE_STROOPS } from "@/config/constants";
import type { DecisionAnswer, TransactionsResponse } from "@/types/close-api";

/** Throws an HttpException carrying the API's `{ error: { code, message, details? } }` body. */
function fail(code: string, message: string, status: number, details?: unknown): never {
  const error: Record<string, unknown> = { code, message };
  if (details !== undefined) error.details = details;
  throw new HttpException({ error }, status);
}

@Controller("v1/:network")
export class CloseController {
  private readonly logger = new Logger(CloseController.name);

  @Post("close/plan")
  @HttpCode(200)
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
      await Promise.all(
        accountState.trustlines
          .filter((tl) => Number(tl.balance) > 0)
          .map(async (tl) => {
            const path = await fetchConversionPath(tl.asset, tl.balance, network).catch(() => null);
            convertibility[tl.asset] = path !== null;
          })
      );

      const buildResult = buildPlan(accountState, mediatorRequired, false);
      const decisionPoints = deriveDecisionPoints(accountState, convertibility);
      const answeredIds = new Set(decisions.map((d) => d.id));
      const pending = decisionPoints.filter((dp) => !answeredIds.has(dp.id));

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
      this.logger.error("close/plan failed", e instanceof Error ? e.stack : String(e));
      fail("plan_failed", "Failed to build the close plan.", 500);
    }
  }

  @Post("close/transactions")
  @HttpCode(200)
  async transactions(
    @Param("network") network: string,
    @Body() body: { source?: unknown; destination?: unknown; decisions?: unknown; planHash?: unknown }
  ) {
    if (!isValidNetwork(network)) fail("invalid_network", "Invalid network.", 400);

    const { source, destination } = body;
    if (typeof source !== "string" || !isValidGAddress(source)) {
      fail("invalid_source", "A valid source account (G...) is required.", 400);
    }
    if (typeof destination !== "string" || !isValidGAddress(destination)) {
      fail("invalid_destination", "A valid destination account (G...) is required.", 400);
    }
    if (requiresMediatorForAddress(destination)) {
      fail(
        "mediator_destination_unsupported",
        "Exchange destinations that require a mediator are not yet supported by this API.",
        422
      );
    }
    const decisions: DecisionAnswer[] = Array.isArray(body.decisions)
      ? (body.decisions as DecisionAnswer[])
      : [];

    try {
      const accountState = await readAccountState(source, network);

      const assetsById = accountState.trustlines.map((tl) => ({
        id: assetDecisionId(tl.asset),
        asset: tl.asset,
      }));
      const dispositions = resolveDispositions(decisions, assetsById);

      const missing = accountState.trustlines
        .filter((tl) => Number(tl.balance) > 0 && !(tl.asset in dispositions))
        .map((tl) => assetDecisionId(tl.asset));
      if (missing.length > 0) {
        fail(
          "needs_decisions",
          "Resolve every asset disposition before requesting transactions.",
          422,
          { missing }
        );
      }

      const transactions = await buildCloseTransactions(
        accountState,
        destination,
        dispositions,
        network
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
        transactions,
        remaining: { steps: 0, requiresAnotherCall: false },
      };
      return response;
    } catch (e) {
      if (e instanceof HttpException) throw e;
      if (e instanceof AccountNotFoundError) fail("account_not_found", e.message, 404);
      if (e instanceof AssetRouteLostError) {
        fail("quote_drifted", "A conversion route is no longer available; re-plan and retry.", 409);
      }
      if (e instanceof CloseBuildError) fail(e.code, e.message, e.status);
      this.logger.error("close/transactions failed", e instanceof Error ? e.stack : String(e));
      fail("transactions_failed", "Failed to build the close transactions.", 500);
    }
  }

  @Post("submit")
  @HttpCode(200)
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
      if (e instanceof Error && /xdr|envelope|decode/i.test(e.message)) {
        fail("invalid_signed_xdr", "The transaction envelope could not be decoded.", 400);
      }
      this.logger.error("submit failed", e instanceof Error ? e.stack : String(e));
      fail("submit_failed", "Failed to submit the transaction.", 502);
    }
  }
}
