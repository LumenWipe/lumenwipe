import { NextRequest, NextResponse } from "next/server";
import type { Network } from "@lumenwipe/sdk";
import { getApiClient } from "@/lib/api/server-client";
import { proxy } from "@/lib/api/proxy";
import { rateLimitProxy } from "@/lib/api/rate-limit";

/**
 * Sponsors the fee of a wind-down transaction for an account that cannot pay its own way
 * (architecture.md §8.1). The API validates the transaction's shape and holds the fee-account
 * secret; this route only relays the client-signed XDR and the key, exactly like mediator/sign.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ network: string }> }) {
  const { network } = await params;

  const limited = await rateLimitProxy(req, "fee-bump-sponsor");
  if (limited) return limited;

  let body: { transaction?: unknown };
  try {
    body = (await req.json()) as { transaction?: unknown };
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_body", message: "Request body must be valid JSON." } },
      { status: 400 }
    );
  }
  const transaction = typeof body.transaction === "string" ? body.transaction : "";

  return proxy(() => getApiClient().feeBumpSponsor(transaction, network as Network));
}
