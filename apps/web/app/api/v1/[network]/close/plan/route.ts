import { NextRequest, NextResponse } from "next/server";
import type { ClosePlanRequest, Network } from "@lumenwipe/sdk";
import { getApiClient } from "@/lib/api/server-client";
import { proxy } from "@/lib/api/proxy";
import { rateLimitProxy } from "@/lib/api/rate-limit";

// This call reads full account state, including DeFi position detection (OctoPos, with a
// direct on-chain fallback sweep when it's unavailable) - a few seconds slower than a plain
// Horizon read in the ordinary case, and up to ~25s in the worst one under real mainnet RPC
// conditions (confirmed live on 2026-09-12). The SDK client already times out cleanly at 45s
// (server-client.ts, apps/web/lib/api/proxy.ts's LumenWipeTimeoutError handling) - this just has
// to stay well above that, or the platform's own function deadline kills the request first and
// the browser sees a bare timeout instead of that clear message.
export const maxDuration = 55;

export async function POST(req: NextRequest, { params }: { params: Promise<{ network: string }> }) {
  const { network } = await params;

  const limited = await rateLimitProxy(req, "close-plan");
  if (limited) return limited;

  let body: ClosePlanRequest;
  try {
    body = (await req.json()) as ClosePlanRequest;
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_body", message: "Request body must be valid JSON." } },
      { status: 400 }
    );
  }

  return proxy(() => getApiClient().closePlan(body, network as Network));
}
