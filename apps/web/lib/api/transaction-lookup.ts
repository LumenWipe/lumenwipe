import { NextResponse } from "next/server";
import { errorEnvelope } from "@/lib/api/error-body";

const TX_HASH = /^[0-9a-f]{64}$/i;

/** The shape of a lookup through the proxy: the hash is judged before the rate limit is spent or
 *  the API is called, and no answer, error or not, may be cached. */
export async function transactionLookupResponse(
  hash: string,
  deps: {
    rateLimit: () => Promise<NextResponse | null>;
    relay: () => Promise<NextResponse>;
  }
): Promise<NextResponse> {
  if (!TX_HASH.test(hash)) {
    return NextResponse.json(
      errorEnvelope("invalid_tx_hash", "The transaction hash must be 64 hex characters."),
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
  const limited = await deps.rateLimit();
  if (limited) limited.headers.set("Cache-Control", "no-store");
  return limited ?? deps.relay();
}
