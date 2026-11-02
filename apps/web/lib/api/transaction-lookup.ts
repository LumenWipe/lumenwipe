import { NextResponse } from "next/server";
import { errorEnvelope } from "@/lib/api/error-body";

const TX_HASH = /^[0-9a-f]{64}$/i;

/** A lookup through the proxy: `rateLimit` judges the network first, then the hash is judged
 *  before the API is called, and no answer, error or not, may be cached. */
export async function transactionLookupResponse(
  hash: string,
  deps: {
    rateLimit: () => Promise<NextResponse | null>;
    relay: () => Promise<NextResponse>;
  }
): Promise<NextResponse> {
  const refused = await deps.rateLimit();
  if (refused) {
    refused.headers.set("Cache-Control", "no-store");
    return refused;
  }
  if (!TX_HASH.test(hash)) {
    return NextResponse.json(
      errorEnvelope("invalid_tx_hash", "The transaction hash must be 64 hex characters."),
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
  return deps.relay();
}
