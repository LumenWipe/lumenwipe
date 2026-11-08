import { NextRequest, NextResponse } from "next/server";
import type { Network } from "@lumenwipe/sdk";
import { errorEnvelope } from "@/lib/api/error-body";
import { proxyErrorResponse } from "@/lib/api/proxy-error";
import { rateLimitProxy } from "@/lib/api/rate-limit";
import { getApiClient } from "@/lib/api/server-client";
import type { RecoveryEstimate } from "@/lib/api/estimate-client";
import { recoveryRange } from "@/lib/plan/expected-receive";
import { isValidGAddress } from "@/lib/utils/validation";

// The estimate runs the analyze screen's two reads at once (the account and its destination-less
// plan), each with DeFi position detection; see the account route for why 55s.
export const maxDuration = 55;

/** Each estimate costs two full account reads on the shared API key, and the estimate is for one
 *  visitor's own address, so its bucket is far tighter than the close flow's. */
const ESTIMATE_LIMIT_PER_DAY = 50;

const NO_STORE = { "Cache-Control": "no-store" };

/** Fixed text per failure, so no upstream message, which may quote the address, is relayed. */
const FAILURES: Record<number, readonly [string, string]> = {
  404: ["account_not_found", "The account does not exist on this network."],
  429: ["rate_limited", "Too many requests."],
  504: ["upstream_timeout", "The account read timed out."],
};

/** Upstream headers worth keeping on a failure: when to retry, and the id to quote. */
const KEPT_HEADERS = ["Retry-After", "x-request-id"];

function failure(status: number, upstream?: Headers): NextResponse {
  const [code, message] = FAILURES[status] ?? [
    "estimate_unavailable",
    "The estimate is unavailable.",
  ];
  const headers = new Headers(NO_STORE);
  for (const name of KEPT_HEADERS) {
    const value = upstream?.get(name);
    if (value) headers.set(name, value);
  }
  return NextResponse.json(errorEnvelope(code, message), { status, headers });
}

async function addressOf(req: NextRequest): Promise<string | null> {
  const body: unknown = await req.json().catch(() => null);
  const address =
    typeof body === "object" && body !== null ? (body as { address?: unknown }).address : null;
  return typeof address === "string" && isValidGAddress(address) ? address : null;
}

/**
 * A read-only recovery estimate for one address. The address travels in the body, never in the
 * URL, and the answer carries only derived figures and the read time: no address, no account
 * state. Nothing is cached or stored: the read is keyed by an address, so it identifies a person.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ network: string }> }
): Promise<NextResponse> {
  // An outage of the limiter refuses rather than forwards: the estimate is optional and costs two
  // full account reads, so it must never run uncapped against the shared key.
  const limited = await rateLimitProxy(req, "estimate", {
    params,
    limitPerDay: ESTIMATE_LIMIT_PER_DAY,
    whenUnavailable: "refuse",
  });
  if (limited) {
    limited.headers.set("Cache-Control", "no-store");
    return limited;
  }

  const address = await addressOf(req);
  if (!address) {
    return NextResponse.json(
      errorEnvelope("invalid_address", "The body must carry a valid Stellar account address."),
      { status: 400, headers: NO_STORE }
    );
  }

  const network = (await params).network as Network;
  try {
    const client = getApiClient();
    const [account, plan] = await Promise.all([
      client.getAccount(address, network),
      client.closePlan({ source: address }, network),
    ]);
    const range = recoveryRange(account, plan);
    if (!range) return failure(502);
    const estimate: RecoveryEstimate = { readAt: new Date().toISOString(), range };
    return NextResponse.json(estimate, { headers: NO_STORE });
  } catch (e) {
    const relayed = proxyErrorResponse(e);
    return failure(relayed.status, relayed.headers);
  }
}
