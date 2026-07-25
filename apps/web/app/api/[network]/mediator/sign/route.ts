import { NextRequest, NextResponse } from "next/server";
import type { Network } from "@lumenwipe/sdk";
import { getApiClient } from "@/lib/api/server-client";
import { proxy } from "@/lib/api/proxy";

/**
 * Co-signs the shared-mediator forward payment. The API validates the exact
 * [accountMerge → mediator, payment mediator → destination] shape and holds the
 * mediator secret; this route only relays the user-signed XDR and the key.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ network: string }> }
) {
  const { network } = await params;

  let body: { transaction?: unknown };
  try {
    body = (await req.json()) as { transaction?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const transaction = typeof body.transaction === "string" ? body.transaction : "";

  return proxy(() => getApiClient().mediatorSign(transaction, network as Network));
}
