import { NextRequest, NextResponse } from "next/server";
import { isValidNetwork } from "@/config/networks";
import { isValidGAddress } from "@/lib/utils/validation";
import { readAccountState } from "@/lib/close-api/read-account";
import { requiresMediatorForAddress } from "@/lib/exchange-registry";
import { assetDecisionId, resolveDispositions } from "@/lib/close-api/decisions";
import { buildCloseTransactions, CloseBuildError } from "@/lib/close-api/build-transactions";
import { computePlanHash } from "@/lib/close-api/plan-response";
import { AccountNotFoundError, AssetRouteLostError } from "@/lib/utils/errors";
import type { DecisionAnswer, TransactionsResponse } from "@/types/close-api";

interface TxBody {
  source?: unknown;
  destination?: unknown;
  decisions?: unknown;
  planHash?: unknown;
}

function err(code: string, message: string, status: number, details?: unknown): NextResponse {
  return NextResponse.json({ error: { code, message, details } }, { status });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ network: string }> }
): Promise<NextResponse> {
  const { network } = await params;
  if (!isValidNetwork(network)) return err("invalid_network", "Invalid network.", 400);

  let body: TxBody;
  try {
    body = (await req.json()) as TxBody;
  } catch {
    return err("invalid_body", "Request body must be valid JSON.", 400);
  }

  const { source, destination } = body;
  if (typeof source !== "string" || !isValidGAddress(source)) {
    return err("invalid_source", "A valid source account (G...) is required.", 400);
  }
  if (typeof destination !== "string" || !isValidGAddress(destination)) {
    return err("invalid_destination", "A valid destination account (G...) is required.", 400);
  }
  if (requiresMediatorForAddress(destination)) {
    return err(
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

    // Every balance-bearing trustline must have an explicit disposition before we build.
    const missing = accountState.trustlines
      .filter((tl) => Number(tl.balance) > 0 && !(tl.asset in dispositions))
      .map((tl) => assetDecisionId(tl.asset));
    if (missing.length > 0) {
      return err(
        "needs_decisions",
        "Resolve every asset disposition before requesting transactions.",
        422,
        { missing }
      );
    }

    const transactions = await buildCloseTransactions(accountState, destination, dispositions, network);

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
    return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AccountNotFoundError) return err("account_not_found", e.message, 404);
    if (e instanceof AssetRouteLostError) {
      return err("quote_drifted", "A conversion route is no longer available; re-plan and retry.", 409);
    }
    if (e instanceof CloseBuildError) return err(e.code, e.message, e.status);
    console.error("close/transactions error:", e);
    return err("transactions_failed", "Failed to build the close transactions.", 500);
  }
}
