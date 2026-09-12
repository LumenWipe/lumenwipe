import { NextRequest } from "next/server";
import type { Network } from "@lumenwipe/sdk";
import { getApiClient } from "@/lib/api/server-client";
import { proxy } from "@/lib/api/proxy";
import { rateLimitProxy } from "@/lib/api/rate-limit";

// This is the analyze call: a full account read, including DeFi position detection (OctoPos,
// with a direct on-chain fallback sweep when it's unavailable - up to ~25s alone under real
// mainnet RPC conditions, confirmed live on 2026-09-12). The SDK client already times out
// cleanly at 45s with a clear message (server-client.ts, apps/web/lib/api/proxy.ts's
// LumenWipeTimeoutError handling), so this just needs to stay above that instead of letting the
// platform's own function deadline win the race first.
export const maxDuration = 55;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ network: string; address: string }> }
) {
  const limited = await rateLimitProxy(req, "account");
  if (limited) return limited;
  const { network, address } = await params;
  return proxy(() => getApiClient().getAccount(address, network as Network));
}
