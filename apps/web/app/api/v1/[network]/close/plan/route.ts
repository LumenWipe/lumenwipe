import { NextRequest, NextResponse } from "next/server";
import type { ClosePlanRequest, Network } from "@lumenwipe/sdk";
import { getApiClient } from "@/lib/api/server-client";
import { proxy } from "@/lib/api/proxy";
import { rateLimitProxy } from "@/lib/api/rate-limit";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ network: string }> }
) {
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
