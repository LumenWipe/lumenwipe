import { NextRequest } from "next/server";
import type { Network } from "@lumenwipe/sdk";
import { getApiClient } from "@/lib/api/server-client";
import { proxy } from "@/lib/api/proxy";
import { rateLimitProxy } from "@/lib/api/rate-limit";

export async function GET(req: NextRequest, { params }: { params: Promise<{ network: string }> }) {
  const limited = await rateLimitProxy(req, "paths");
  if (limited) return limited;
  const { network } = await params;
  const fromAsset = req.nextUrl.searchParams.get("fromAsset") ?? "";
  const amount = req.nextUrl.searchParams.get("amount") ?? "";
  return proxy(
    () => getApiClient().getPaths({ fromAsset, amount }, network as Network),
    "public, s-maxage=15, stale-while-revalidate=60"
  );
}
