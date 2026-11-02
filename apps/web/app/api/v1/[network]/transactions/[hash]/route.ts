import type { NextRequest } from "next/server";
import type { Network } from "@lumenwipe/sdk";
import { proxy } from "@/lib/api/proxy";
import { rateLimitProxy } from "@/lib/api/rate-limit";
import { getApiClient } from "@/lib/api/server-client";
import { transactionLookupResponse } from "@/lib/api/transaction-lookup";

export const maxDuration = 55;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ network: string; hash: string }> }
) {
  const { network, hash } = await params;
  return transactionLookupResponse(hash, {
    rateLimit: () => rateLimitProxy(req, "transactions", params),
    relay: () => proxy(() => getApiClient().getTransaction(hash, network as Network)),
  });
}
