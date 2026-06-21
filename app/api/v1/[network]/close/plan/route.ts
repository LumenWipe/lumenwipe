import { NextRequest, NextResponse } from "next/server";
import { isValidNetwork } from "@/config/networks";
import { isValidGAddress } from "@/lib/utils/validation";
import { getAccountState } from "@/lib/stellar/account";
import { fetchConversionPath } from "@/lib/se-api/paths";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { requiresMediatorForAddress } from "@/lib/exchange-registry";
import { deriveDecisionPoints } from "@/lib/close-api/decisions";
import { assemblePlanResponse, computePlanHash } from "@/lib/close-api/plan-response";
import { AccountNotFoundError } from "@/lib/utils/errors";
import { BASE_FEE_STROOPS } from "@/config/constants";
import type { DecisionAnswer } from "@/types/close-api";

interface PlanBody {
  source?: unknown;
  destination?: unknown;
  decisions?: unknown;
}

function err(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ network: string }> }
): Promise<NextResponse> {
  const { network } = await params;
  if (!isValidNetwork(network)) return err("invalid_network", "Invalid network.", 400);

  let body: PlanBody;
  try {
    body = (await req.json()) as PlanBody;
  } catch {
    return err("invalid_body", "Request body must be valid JSON.", 400);
  }

  const { source } = body;
  if (typeof source !== "string" || !isValidGAddress(source)) {
    return err("invalid_source", "A valid source account (G...) is required.", 400);
  }
  const destination = typeof body.destination === "string" ? body.destination : null;
  if (destination !== null && !isValidGAddress(destination)) {
    return err("invalid_destination", "Destination must be a valid account (G...).", 400);
  }
  const decisions: DecisionAnswer[] = Array.isArray(body.decisions)
    ? (body.decisions as DecisionAnswer[])
    : [];

  try {
    const accountState = await getAccountState(source, network);
    const mediatorRequired = destination ? requiresMediatorForAddress(destination) : false;

    // Best-effort convertibility: a balance is convertible if path finding returns a
    // route to XLM. The authoritative re-quote happens in /close/transactions.
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
      // Base reserve (2 entries) plus 0.5 XLM per subentry freed on close.
      freedReserveXlm: ((2 + accountState.numSubEntries) * 0.5).toFixed(7),
    };

    return NextResponse.json(
      assemblePlanResponse({ buildResult, decisionPoints: pending, planHash, estimate }),
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    if (e instanceof AccountNotFoundError) {
      return err("account_not_found", e.message, 404);
    }
    console.error("close/plan error:", e);
    return err("plan_failed", "Failed to build the close plan.", 500);
  }
}
