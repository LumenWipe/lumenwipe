import { NextRequest, NextResponse } from "next/server";
import type { CloseTransactionsRequest, Network } from "@lumenwipe/sdk";
import { getApiClient } from "@/lib/api/server-client";
import { proxy } from "@/lib/api/proxy";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ network: string }> }
) {
  const { network } = await params;

  let body: CloseTransactionsRequest;
  try {
    body = (await req.json()) as CloseTransactionsRequest;
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_body", message: "Request body must be valid JSON." } },
      { status: 400 }
    );
  }

  return proxy(() => getApiClient().closeTransactions(body, network as Network));
}
