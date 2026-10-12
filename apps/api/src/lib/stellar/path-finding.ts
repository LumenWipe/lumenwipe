import type { Network } from "@/config/networks";
import { PATH_ROUTING_API_URLS } from "@/config/networks";
import { SLIPPAGE_BPS } from "@/config/constants";
import type { Deadline } from "@/common/deadline";
import { UpstreamError, upstreamGetJson, type UpstreamOptions } from "./upstream-client";
import type { ConversionPath } from "@lumenwipe/types";
import { isNativeAsset, parseAsset } from "@/lib/utils/assets";
import { stroopsToXlm, xlmToStroops } from "@/lib/utils/amounts";

interface PathRecordAsset {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}

interface PathRecord {
  destination_amount: string;
  path: PathRecordAsset[];
}

interface PathsResponse {
  _embedded?: { records?: PathRecord[] };
}

function recordAssetToString(asset: PathRecordAsset): string {
  if (asset.asset_type === "native") return "native";
  return `${asset.asset_code}:${asset.asset_issuer}`;
}

/** Exported for direct unit coverage of the rounding boundary (issue #167) - the only caller in
 *  production code remains `fetchConversionPath` below. */
export function applySlippage(amount: string): string {
  const stroops = BigInt(xlmToStroops(amount));
  const min = (stroops * BigInt(10000 - SLIPPAGE_BPS)) / BigInt(10000);
  return min > BigInt(0) ? stroopsToXlm(min) : "0";
}

/**
 * Why a confirmed answer carries no route: the market is empty, or it exists but the amount would
 * receive nothing once slippage is applied.
 */
export type NoRouteReason = "no_market" | "dust_below_minimum";

/**
 * What the price source said. `none` is an answer (the asset has no route to the target);
 * `unavailable` is the absence of one, and must never be read as `none`.
 */
export type PathResult =
  | { kind: "route"; path: ConversionPath }
  | { kind: "none"; reason: NoRouteReason }
  | { kind: "unavailable"; error: UpstreamError };

const AMOUNT = /^\d+(\.\d+)?$/;

function isUsableRecord(value: unknown): value is PathRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<PathRecord>;
  return (
    typeof record.destination_amount === "string" &&
    AMOUNT.test(record.destination_amount) &&
    Array.isArray(record.path) &&
    record.path.every(
      (hop) =>
        typeof hop === "object" &&
        hop !== null &&
        (hop.asset_type === "native" ||
          (typeof hop.asset_code === "string" && typeof hop.asset_issuer === "string"))
    )
  );
}

/** Only an array of well-formed records is an answer; anything else is no answer at all. */
function recordsOf(body: PathsResponse | null): PathRecord[] {
  const records: unknown = body?._embedded?.records;
  if (!Array.isArray(records) || !records.every(isUsableRecord)) {
    throw new UpstreamError("bad_response", "paths");
  }
  return records;
}

export interface PathFindingOptions {
  fetch?: typeof globalThis.fetch;
  deadline?: Deadline;
  client?: Pick<UpstreamOptions, "policy" | "random" | "sleep" | "now">;
}

/** The route, or null when there is a confirmed none; an unavailable price source throws instead of
 *  reading as "no route". */
export function routeOrNull(result: PathResult): ConversionPath | null {
  if (result.kind === "unavailable") throw result.error;
  return result.kind === "route" ? result.path : null;
}

export async function fetchConversionPath(
  fromAsset: string,
  amount: string,
  network: Network,
  toAsset = "native",
  options: PathFindingOptions = {}
): Promise<PathResult> {
  const base = PATH_ROUTING_API_URLS[network];
  if (!base) return { kind: "unavailable", error: new UpstreamError("unavailable", "paths") };
  if (isNativeAsset(fromAsset) || !(parseFloat(amount) > 0)) {
    return { kind: "none", reason: "no_market" };
  }

  const { code, issuer } = parseAsset(fromAsset);
  if (!issuer) return { kind: "none", reason: "no_market" };

  const query = new URLSearchParams({
    source_asset_type: code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
    source_asset_code: code,
    source_asset_issuer: issuer,
    source_amount: amount,
    destination_assets: toAsset,
  });

  let records: PathRecord[];
  try {
    records = recordsOf(
      await upstreamGetJson<PathsResponse>(base, `/paths/strict-send?${query}`, {
        target: "paths",
        fetch: options.fetch,
        deadline: options.deadline,
        ...options.client,
      })
    );
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    // A lookup that returned nothing usable is retried like an outage; it is never an answer.
    const retryable =
      error.kind === "bad_response" ? new UpstreamError("unavailable", error.target) : error;
    return { kind: "unavailable", error: retryable };
  }

  if (records.length === 0) return { kind: "none", reason: "no_market" };

  const best = records.reduce((a, b) =>
    parseFloat(b.destination_amount) > parseFloat(a.destination_amount) ? b : a
  );

  const destMin = applySlippage(best.destination_amount);
  if (destMin === "0") return { kind: "none", reason: "dust_below_minimum" };

  return {
    kind: "route",
    path: {
      fromAsset,
      toAsset,
      path: best.path.map(recordAssetToString),
      estimatedReceive: best.destination_amount,
      destMin,
    },
  };
}
