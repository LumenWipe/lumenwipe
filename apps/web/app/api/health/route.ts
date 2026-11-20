import { NextResponse } from "next/server";
import { getApiClient } from "@/lib/api/server-client";

/** Under the 3 s an outside probe waits, instead of the client's 45 s request timeout. */
const HEALTH_TIMEOUT_MS = 2_500;
const CACHE_CONTROL = "public, s-maxage=10";

/**
 * Web health. The web's backend dependency is now the LumenWipe API (reads, building,
 * and submission all proxy to it), so health reflects API reachability rather than
 * pinging Stellar RPC directly. It asks the API's dependency-free `/health` only.
 */
export async function GET() {
  const headers = { "Cache-Control": CACHE_CONTROL };
  try {
    await getApiClient().health({ signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return NextResponse.json({ status: "ok", api: "ok" }, { status: 200, headers });
  } catch {
    return NextResponse.json({ status: "degraded", api: "error" }, { status: 503, headers });
  }
}
