import type { NextRequest } from "next/server";
import type { Network } from "@lumenwipe/sdk";
import { deliveredLookupResponse } from "@/lib/api/delivered-query";
import { proxy } from "@/lib/api/proxy";
import { rateLimitProxy } from "@/lib/api/rate-limit";
import { getApiClient } from "@/lib/api/server-client";

// The API reads up to 20 transactions from RPC, then Horizon for any RPC no longer holds.
export const maxDuration = 55;

export async function GET(req: NextRequest, { params }: { params: Promise<{ network: string }> }) {
  const { network } = await params;
  return deliveredLookupResponse(req.nextUrl.searchParams, {
    rateLimit: () => rateLimitProxy(req, "close-delivered", params),
    relay: ({ destination, hashes }) =>
      proxy(() => getApiClient().closeDelivered(destination, hashes, network as Network)),
  });
}
