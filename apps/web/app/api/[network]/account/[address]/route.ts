import { NextRequest } from "next/server";
import type { Network } from "@lumenwipe/sdk";
import { getApiClient } from "@/lib/api/server-client";
import { proxy } from "@/lib/api/proxy";
import { rateLimitProxy } from "@/lib/api/rate-limit";

// This is the analyze call: a full account read, including DeFi position detection (OctoPos,
// with a direct on-chain fallback when it's unavailable). That path can legitimately take
// several seconds - the SDK client already times out cleanly at 30s with a clear message
// (apps/web/lib/api/proxy.ts's LumenWipeTimeoutError handling), so this just needs to stay
// above that instead of letting the platform's own function deadline win the race first.
export const maxDuration = 40;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ network: string; address: string }> }
) {
  const limited = await rateLimitProxy(req, "account");
  if (limited) return limited;
  const { network, address } = await params;
  return proxy(() => getApiClient().getAccount(address, network as Network));
}
