import { NextRequest } from "next/server";
import type { Network } from "@lumenwipe/sdk";
import { getApiClient } from "@/lib/api/server-client";
import { proxy } from "@/lib/api/proxy";
import { rateLimitProxy } from "@/lib/api/rate-limit";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ network: string; address: string }> }
) {
  const limited = await rateLimitProxy(req, "mediator-check");
  if (limited) return limited;
  const { network, address } = await params;
  return proxy(
    () => getApiClient().mediatorCheck(address, network as Network),
    "public, s-maxage=30, stale-while-revalidate=120"
  );
}
