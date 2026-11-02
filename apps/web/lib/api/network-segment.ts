import { NextResponse } from "next/server";
import { isValidNetwork } from "@/config/networks";
import { errorEnvelope } from "@/lib/api/error-body";

const API_ROOTS_WITHOUT_NETWORK = new Set(["health", "stats", "integrator", "config"]);

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function invalidNetworkResponse(): NextResponse {
  return NextResponse.json(errorEnvelope("invalid_network", "Unknown network."), {
    status: 400,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * The 400 for a path under `/api/[network]` or `/api/v1/[network]` whose network segment is not a
 * known network, or null to proceed. `pathname` is the raw request path, so each segment is
 * decoded once, to the value the route handler would receive as its param.
 */
export function refuseUnknownNetwork(pathname: string): NextResponse | null {
  const [, root, first, second] = pathname.split("/").map(decodeSegment);
  if (root !== "api" || first === undefined || API_ROOTS_WITHOUT_NETWORK.has(first)) return null;

  const network = first === "v1" ? second : first;
  if (network !== undefined && isValidNetwork(network)) return null;

  return invalidNetworkResponse();
}
