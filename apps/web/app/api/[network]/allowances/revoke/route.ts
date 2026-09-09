import { NextRequest, NextResponse } from "next/server";
import type { Network } from "@lumenwipe/sdk";
import { getApiClient } from "@/lib/api/server-client";
import { proxy } from "@/lib/api/proxy";
import { rateLimitProxy } from "@/lib/api/rate-limit";

/**
 * Builds the unsigned revocation transaction (architecture.md §12). This route only relays the
 * three addresses and the API key; the API validates and builds, the browser verifies and signs.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ network: string }> }) {
  const { network } = await params;

  const limited = await rateLimitProxy(req, "allowances-revoke");
  if (limited) return limited;

  let body: { owner?: unknown; token?: unknown; spender?: unknown };
  try {
    body = (await req.json()) as { owner?: unknown; token?: unknown; spender?: unknown };
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_body", message: "Request body must be valid JSON." } },
      { status: 400 }
    );
  }
  const owner = typeof body.owner === "string" ? body.owner : "";
  const token = typeof body.token === "string" ? body.token : "";
  const spender = typeof body.spender === "string" ? body.spender : "";

  return proxy(() => getApiClient().revokeAllowance({ owner, token, spender }, network as Network));
}
