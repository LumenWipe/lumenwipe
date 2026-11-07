import { NextResponse } from "next/server";
import { errorEnvelope } from "@/lib/api/error-body";
import { isValidGAddress } from "@/lib/utils/validation";

/** The most hashes one lookup through this proxy may name. Narrower than the API's own 20, which
 *  is for integrators: a receipt asks only about its closing transactions, normally one, and a
 *  wider cap would only widen the upstream reads each allowed request can cost the shared key. */
export const DELIVERED_MAX_HASHES = 5;

const TX_HASH = /^[0-9a-f]{64}$/;

export interface DeliveredQuery {
  destination: string;
  /** Lowercase, distinct, in the order asked. */
  hashes: string[];
}

export type DeliveredQueryResult =
  | { ok: true; query: DeliveredQuery }
  | { ok: false; code: "invalid_destination" | "invalid_tx_hash"; message: string };

/** The one value a parameter was given, or null when it is missing or repeated. */
function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : null;
}

/** Reads `destination` and `hashes` from a delivered-amount lookup and nothing else: any other
 *  parameter is ignored, so it can never reach the API. */
export function parseDeliveredQuery(params: URLSearchParams): DeliveredQueryResult {
  const destination = single(params, "destination");
  if (destination === null || !isValidGAddress(destination)) {
    return {
      ok: false,
      code: "invalid_destination",
      message: "destination must be a valid Stellar account address.",
    };
  }
  const raw = single(params, "hashes");
  const hashes = raw === null ? [] : raw.split(",").map((hash) => hash.toLowerCase());
  if (
    hashes.length === 0 ||
    hashes.length > DELIVERED_MAX_HASHES ||
    new Set(hashes).size !== hashes.length ||
    !hashes.every((hash) => TX_HASH.test(hash))
  ) {
    return {
      ok: false,
      code: "invalid_tx_hash",
      message: `hashes must be 1 to ${DELIVERED_MAX_HASHES} distinct transaction hashes, comma-separated, each 64 hex characters.`,
    };
  }
  return { ok: true, query: { destination, hashes } };
}

function uncached(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/** A delivered-amount lookup through the proxy: `rateLimit` judges the network first, then the
 *  query is judged before the API is called, and no answer, error or not, may be cached. */
export async function deliveredLookupResponse(
  params: URLSearchParams,
  deps: {
    rateLimit: () => Promise<NextResponse | null>;
    relay: (query: DeliveredQuery) => Promise<NextResponse>;
  }
): Promise<NextResponse> {
  const refused = await deps.rateLimit();
  if (refused) return uncached(refused);
  const parsed = parseDeliveredQuery(params);
  if (!parsed.ok) {
    return uncached(NextResponse.json(errorEnvelope(parsed.code, parsed.message), { status: 400 }));
  }
  return uncached(await deps.relay(parsed.query));
}
