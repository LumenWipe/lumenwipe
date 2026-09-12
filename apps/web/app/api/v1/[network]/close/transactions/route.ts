import { NextRequest, NextResponse } from "next/server";
import type { CloseTransactionsRequest, Network } from "@lumenwipe/sdk";
import { getApiClient } from "@/lib/api/server-client";
import { proxy } from "@/lib/api/proxy";
import { rateLimitProxy } from "@/lib/api/rate-limit";

// Same reasoning as close/plan/route.ts: this re-reads full account state (including DeFi
// detection) on every round of the close loop, so it needs the same headroom above the SDK
// client's 30s timeout.
export const maxDuration = 40;

export async function POST(req: NextRequest, { params }: { params: Promise<{ network: string }> }) {
  const { network } = await params;

  const limited = await rateLimitProxy(req, "close-transactions");
  if (limited) return limited;

  let body: CloseTransactionsRequest;
  try {
    body = (await req.json()) as CloseTransactionsRequest;
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_body", message: "Request body must be valid JSON." } },
      { status: 400 }
    );
  }

  return proxy(() => getApiClient().closeTransactions(body, network as Network));
}
