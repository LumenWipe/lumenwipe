import { NextRequest, NextResponse } from "next/server";
import type { Network } from "@lumenwipe/sdk";
import { getApiClient } from "@/lib/api/server-client";
import { proxy } from "@/lib/api/proxy";
import { rateLimitProxy } from "@/lib/api/rate-limit";

/**
 * Co-signs the shared-mediator forward payment. The API validates the exact
 * [accountMerge → mediator, payment mediator → destination] shape and holds the
 * mediator secret; this route only relays the user-signed XDR and the key.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ network: string }> }) {
  const { network } = await params;

  const limited = await rateLimitProxy(req, "mediator-sign");
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

  return proxy(() => getApiClient().mediatorSign(transaction, network as Network));
}
