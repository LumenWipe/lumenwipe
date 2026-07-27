import { NextResponse } from "next/server";
import { getApiClient } from "@/lib/api/server-client";

/**
 * Web health. The web's backend dependency is now the LumenWipe API (reads, building,
 * and submission all proxy to it), so health reflects API reachability rather than
 * pinging Stellar RPC directly.
 */
export async function GET() {
  try {
    await getApiClient().health();
    return NextResponse.json({ status: "ok", api: "ok" }, { status: 200 });
  } catch {
    return NextResponse.json({ status: "degraded", api: "error" }, { status: 503 });
  }
}
