import { NextRequest, NextResponse } from "next/server";
import type { Network } from "@lumenwipe/sdk";
import { getApiClient } from "@/lib/api/server-client";
import { proxy } from "@/lib/api/proxy";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ network: string }> }
) {
  const { network } = await params;

  let body: { signedXdr?: unknown };
  try {
    body = (await req.json()) as { signedXdr?: unknown };
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_body", message: "Request body must be valid JSON." } },
      { status: 400 }
    );
  }
  const signedXdr = typeof body.signedXdr === "string" ? body.signedXdr : "";

  return proxy(() => getApiClient().submit(signedXdr, network as Network));
}
